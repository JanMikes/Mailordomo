/**
 * verify-mailbox — the Phase 3 HUMAN CHECKPOINT runbook (PLAN.md §7 / §12, CHECKPOINT 1).
 *
 * Connects to ONE real mailbox STRICTLY READ-ONLY and prints what the user needs to eyeball before
 * Phases 4–9 build on the transport layer:
 *   • SPECIAL-USE folder resolution (by flag, never by English name),
 *   • the mailbox `uidValidity` (and uidNext / message count),
 *   • JWZ-style threading of a few recent messages reconstructed from Message-ID / In-Reply-To /
 *     References.
 *
 * It performs NO writes and NO sends: the mailbox is opened `readOnly`, and only LIST / SELECT /
 * FETCH are issued (no APPEND, STORE, MOVE, or EXPUNGE).
 *
 * It is intentionally SELF-CONTAINED — it imports only `imapflow` (a real npm package), so it runs
 * with a plain `node packages/backend/scripts/verify-mailbox.ts` (Node ≥ 23.6 strips the types;
 * on Node 22 use `node --experimental-strip-types …`). The SPECIAL-USE pick and the threading view
 * below mirror `engines/folder-mapper.ts` and `threading/jwz.ts`; they are duplicated in miniature
 * here only so this checkpoint tool needs no build step and no workspace imports.
 *
 * Required env vars:
 *   IMAP_HOST           e.g. imap.mail.me.com (iCloud) / imap.gmail.com
 *   IMAP_USER           the login (full email)
 *   IMAP_PASS           an APP-SPECIFIC password (iCloud @me.com and Gmail both require one)
 * Optional env vars:
 *   IMAP_PORT           default 993
 *   IMAP_SECURE         default true  ("false" for STARTTLS-on-143)
 *   IMAP_MAILBOX        default INBOX
 *   VERIFY_FETCH_COUNT  default 20  (how many recent messages to thread)
 */
import { ImapFlow } from 'imapflow';

interface VerifyConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  mailbox: string;
  fetchCount: number;
}

function readConfig(): VerifyConfig | null {
  const host = process.env.IMAP_HOST;
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASS;
  const missing = [
    ['IMAP_HOST', host],
    ['IMAP_USER', user],
    ['IMAP_PASS', pass],
  ].filter(([, value]) => !value);
  if (!host || !user || !pass) {
    console.error('Missing required env vars: ' + missing.map(([name]) => name).join(', '));
    console.error(
      'Usage: IMAP_HOST=… IMAP_USER=… IMAP_PASS=… [IMAP_PORT=993] [IMAP_SECURE=true] ' +
        '[IMAP_MAILBOX=INBOX] [VERIFY_FETCH_COUNT=20] node packages/backend/scripts/verify-mailbox.ts',
    );
    return null;
  }
  return {
    host,
    user,
    pass,
    port: Number(process.env.IMAP_PORT ?? '993'),
    secure: (process.env.IMAP_SECURE ?? 'true').toLowerCase() !== 'false',
    mailbox: process.env.IMAP_MAILBOX ?? 'INBOX',
    fetchCount: Math.max(1, Number(process.env.VERIFY_FETCH_COUNT ?? '20')),
  };
}

// SPECIAL-USE resolution by flag (mirrors engines/folder-mapper.resolveSpecialUseFolders).
const SPECIAL_USE_BY_FLAG: Readonly<Record<string, string>> = {
  '\\all': 'all',
  '\\archive': 'archive',
  '\\drafts': 'drafts',
  '\\flagged': 'flagged',
  '\\junk': 'junk',
  '\\sent': 'sent',
  '\\trash': 'trash',
};

interface FolderLike {
  path: string;
  specialUse?: string | undefined;
  flags: Set<string>;
}

function resolveSpecialUse(folders: readonly FolderLike[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const folder of folders) {
    const candidates: string[] = [];
    if (folder.specialUse) candidates.push(folder.specialUse);
    for (const flag of folder.flags) candidates.push(flag);
    for (const candidate of candidates) {
      const key = SPECIAL_USE_BY_FLAG[candidate.toLowerCase()];
      if (key && !(key in result)) result[key] = folder.path;
    }
  }
  return result;
}

// Minimal message-id parsing + threading (mirrors threading/jwz.ts, miniaturized).
const MESSAGE_ID_TOKEN = /<[^<>\s]+>/g;

function parseIds(value: string | string[] | undefined | null): string[] {
  if (value == null) return [];
  const text = Array.isArray(value) ? value.join(' ') : value;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(MESSAGE_ID_TOKEN)) {
    const token = match[0];
    if (token && !seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

function parseReferencesHeader(headers: Buffer | undefined): string[] {
  if (!headers) return [];
  const text = headers.toString('utf8');
  const match = /^references:[ \t]*([^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*)/im.exec(text);
  return match ? parseIds(match[1] ?? '') : [];
}

interface ThreadView {
  id: string;
  label: string;
  children: ThreadView[];
}

interface CollectedMessage {
  id: string;
  subject: string;
  from: string;
  date: string;
  parent: string | null;
}

function buildThreadViews(messages: readonly CollectedMessage[]): ThreadView[] {
  const nodes = new Map<string, ThreadView>();
  const parentOf = new Map<string, string>();

  for (const message of messages) {
    nodes.set(message.id, {
      id: message.id,
      label: `${message.subject || '(no subject)'} — ${message.from || '(unknown)'} [${message.date}] ${message.id}`,
      children: [],
    });
    if (message.parent) parentOf.set(message.id, message.parent);
  }

  // Create placeholder nodes for referenced-but-absent parents (JWZ empty containers).
  for (const parent of parentOf.values()) {
    if (!nodes.has(parent)) {
      nodes.set(parent, { id: parent, label: `(referenced, not fetched) ${parent}`, children: [] });
    }
  }

  for (const [childId, parentId] of parentOf) {
    const parentNode = nodes.get(parentId);
    const childNode = nodes.get(childId);
    if (parentNode && childNode && parentNode !== childNode) parentNode.children.push(childNode);
  }

  const childIds = new Set(parentOf.keys());
  return [...nodes.values()].filter((node) => !childIds.has(node.id));
}

function printThread(node: ThreadView, depth: number, visited: Set<string>): void {
  if (visited.has(node.id)) {
    console.log(`${'  '.repeat(depth)}- (cycle) ${node.id}`);
    return;
  }
  visited.add(node.id);
  console.log(`${'  '.repeat(depth)}- ${node.label}`);
  for (const child of node.children) printThread(child, depth + 1, visited);
}

function formatFrom(from: ReadonlyArray<{ name?: string; address?: string }> | undefined): string {
  const first = from?.[0];
  if (!first) return '';
  if (first.name && first.address) return `${first.name} <${first.address}>`;
  return first.address ?? first.name ?? '';
}

async function run(config: VerifyConfig): Promise<void> {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
    logger: false,
  });

  await client.connect();
  console.log(`Connected to ${config.host}:${config.port} as ${config.user} (READ-ONLY)\n`);

  try {
    const folders = await client.list();
    console.log(`Folders (${folders.length}):`);
    for (const folder of folders) {
      const tag = folder.specialUse ? `  [${folder.specialUse}]` : '';
      console.log(`  ${folder.path}${tag}`);
    }

    const special = resolveSpecialUse(folders);
    console.log('\nResolved SPECIAL-USE folders (by flag, not by name):');
    const keys = Object.keys(special).sort();
    if (keys.length === 0) console.log('  (none advertised)');
    for (const key of keys) console.log(`  ${key.padEnd(8)} -> ${special[key]}`);

    const mailbox = await client.mailboxOpen(config.mailbox, { readOnly: true });
    console.log(`\nOpened ${mailbox.path} (readOnly=${mailbox.readOnly ?? true})`);
    console.log(`  uidValidity   : ${mailbox.uidValidity.toString()}`);
    console.log(`  uidNext       : ${mailbox.uidNext}`);
    console.log(`  exists        : ${mailbox.exists}`);
    console.log(`  highestModseq : ${mailbox.highestModseq?.toString() ?? '(no CONDSTORE)'}`);

    const start = Math.max(1, mailbox.uidNext - config.fetchCount);
    const range = `${start}:*`;
    console.log(
      `\nThreading recent messages (UID ${range}) via Message-ID/In-Reply-To/References:`,
    );

    const collected: CollectedMessage[] = [];
    for await (const message of client.fetch(
      range,
      { uid: true, envelope: true, headers: ['references'] },
      { uid: true },
    )) {
      const envelope = message.envelope;
      const messageId = envelope?.messageId ?? `<synthetic-uid-${message.uid}>`;
      const references = parseReferencesHeader(message.headers);
      const inReplyTo = parseIds(envelope?.inReplyTo ?? null);
      const chain = references.length > 0 ? references : inReplyTo;
      const parent = chain.length > 0 ? (chain[chain.length - 1] ?? null) : null;
      collected.push({
        id: messageId,
        subject: envelope?.subject ?? '',
        from: formatFrom(envelope?.from),
        date: envelope?.date ? envelope.date.toISOString() : '',
        parent: parent === messageId ? null : parent,
      });
    }

    if (collected.length === 0) {
      console.log('  (no messages in range)');
    } else {
      const roots = buildThreadViews(collected);
      const visited = new Set<string>();
      for (const root of roots) printThread(root, 1, visited);
    }

    console.log('\nVerification complete — no writes or sends were performed.');
  } finally {
    await client.logout();
  }
}

const config = readConfig();
if (!config) {
  process.exitCode = 1;
} else {
  try {
    await run(config);
  } catch (error) {
    console.error('\nverify-mailbox failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
