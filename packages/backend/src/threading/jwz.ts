/**
 * JWZ message threading — a PURE function over header sets (no IO).
 *
 * An implementation of Jamie Zawinski's threading algorithm (the basis of RFC 5256
 * `THREAD=REFERENCES`): reconstruct conversation trees from `Message-ID` / `In-Reply-To` /
 * `References` alone, because no maintained Node library does this (PROJECT.md §12, decision D5).
 *
 * Robustness is the whole point — real mail is messy, so every degenerate case is handled:
 *  - MISSING `Message-ID`        → a stable synthetic id, so the message still threads as itself.
 *  - DUPLICATE `Message-ID`      → the later message gets a synthetic id (never silently merged).
 *  - GARBAGE in `References`      → only well-formed `<…>` tokens are taken; junk is ignored.
 *  - REFERENCED-BUT-ABSENT ids    → modeled as empty containers, then pruned (JWZ step 4).
 *  - LOOPS (a references b refs a) → never created; a link is skipped if it would form a cycle.
 *  - NO references at all          → the message is its own root.
 *
 * The function is generic over the caller's message payload `M`, so the cache can thread `.eml`
 * header rows and the verify script can thread live envelopes through the same code.
 */

/** A single `<…>` message-id token; parsing normalizes to this exact, comparable form. */
export type NormalizedMessageId = string;

/** The minimal header surface needed to thread a message. All fields tolerate absence/garbage. */
export interface ThreadableMessage {
  readonly messageId?: string | null;
  readonly inReplyTo?: string | null;
  /** Either the raw `References` header string or an already-split list (mailparser gives both). */
  readonly references?: readonly string[] | string | null;
  readonly subject?: string | null;
  readonly date?: Date | string | number | null;
}

/** A node in the resulting thread forest. `message === null` marks a pruned-away gap that survived. */
export interface ThreadNode<M> {
  /** Real `Message-ID` (normalized) or a synthesized id for malformed/duplicate/absent ids. */
  readonly id: NormalizedMessageId;
  readonly message: M | null;
  readonly children: ReadonlyArray<ThreadNode<M>>;
  /** True when `id` was synthesized rather than taken from the message itself. */
  readonly synthetic: boolean;
}

interface Container<M> {
  id: NormalizedMessageId;
  message: M | null;
  parent: Container<M> | null;
  children: Array<Container<M>>;
  synthetic: boolean;
  /** Earliest known date in this subtree, for stable chronological ordering. */
  sortKey: number;
}

const MESSAGE_ID_TOKEN = /<[^<>\s]+>/g;

/**
 * Extract normalized `<…>` message-ids from a `References`/`In-Reply-To` value (string or list).
 * Order-preserving and de-duplicated. If the value carries no bracketed token but is a single bare
 * word (a lenient server), that word is wrapped and used. Exported because the IMAP adapter and the
 * verify script both need the identical parse.
 */
export function parseMessageIds(
  value: readonly string[] | string | null | undefined,
): NormalizedMessageId[] {
  if (value == null) return [];
  const text = Array.isArray(value) ? value.join(' ') : String(value);
  const out: NormalizedMessageId[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(MESSAGE_ID_TOKEN)) {
    const token = match[0];
    if (token && !seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }
  if (out.length === 0) {
    const trimmed = text.trim();
    if (trimmed.length > 0 && !/\s/.test(trimmed)) {
      out.push(normalizeMessageId(trimmed));
    }
  }
  return out;
}

/** Normalize a single id: trim, and wrap a bare `a@b` token in angle brackets for consistent keys. */
export function normalizeMessageId(raw: string): NormalizedMessageId {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return trimmed;
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) return trimmed;
  return `<${trimmed.replace(/^<|>$/g, '')}>`;
}

function toSortKey(date: Date | string | number | null | undefined, fallback: number): number {
  if (date == null) return fallback;
  if (date instanceof Date) {
    const t = date.getTime();
    return Number.isNaN(t) ? fallback : t;
  }
  const t = new Date(date).getTime();
  return Number.isNaN(t) ? fallback : t;
}

/** True iff `maybeAncestor` is `node` or sits above it — used to refuse cycle-forming links. */
function isAncestorOrSelf<M>(maybeAncestor: Container<M>, node: Container<M>): boolean {
  let cur: Container<M> | null = node;
  while (cur) {
    if (cur === maybeAncestor) return true;
    cur = cur.parent;
  }
  return false;
}

function link<M>(parent: Container<M>, child: Container<M>): void {
  child.parent = parent;
  parent.children.push(child);
}

function detach<M>(child: Container<M>): void {
  const parent = child.parent;
  if (!parent) return;
  parent.children = parent.children.filter((c) => c !== child);
  child.parent = null;
}

/**
 * Build the thread forest for a set of messages. Roots are returned oldest-first, and each node's
 * children are sorted oldest-first, by the earliest date in their subtree.
 */
export function buildThreads<M extends ThreadableMessage>(
  messages: readonly M[],
): Array<ThreadNode<M>> {
  const idTable = new Map<NormalizedMessageId, Container<M>>();
  const standalone: Array<Container<M>> = [];
  let syntheticCounter = 0;

  const ensureContainer = (id: NormalizedMessageId): Container<M> => {
    const existing = idTable.get(id);
    if (existing) return existing;
    const created: Container<M> = {
      id,
      message: null,
      parent: null,
      children: [],
      synthetic: false,
      sortKey: Number.POSITIVE_INFINITY,
    };
    idTable.set(id, created);
    return created;
  };

  const makeSynthetic = (message: M, sortKey: number): Container<M> => {
    const id = `<jwz-synthetic-${++syntheticCounter}>`;
    const created: Container<M> = {
      id,
      message,
      parent: null,
      children: [],
      synthetic: true,
      sortKey,
    };
    standalone.push(created);
    return created;
  };

  // Pass 1: place every message into a container (creating synthetic ids for missing/duplicate),
  // then wire up its reference chain and set its parent.
  messages.forEach((message, index) => {
    const rawId = message.messageId ? normalizeMessageId(message.messageId) : '';
    const sortKey = toSortKey(message.date, index);

    let self: Container<M>;
    if (rawId.length === 0) {
      self = makeSynthetic(message, sortKey);
    } else {
      const existing = idTable.get(rawId);
      if (existing && existing.message !== null) {
        // Duplicate real id → keep both, the newcomer under a synthetic id.
        self = makeSynthetic(message, sortKey);
      } else {
        self = existing ?? ensureContainer(rawId);
        self.message = message;
        self.sortKey = sortKey;
      }
    }

    // Build the reference chain: References in order, plus In-Reply-To as the immediate parent
    // when it is not already the final hop.
    const chain = parseMessageIds(message.references);
    for (const inReplyTo of parseMessageIds(message.inReplyTo)) {
      if (chain[chain.length - 1] !== inReplyTo) chain.push(inReplyTo);
    }

    let prev: Container<M> | null = null;
    for (const refId of chain) {
      if (refId === self.id) continue; // a message must not reference itself into a loop
      const cur = ensureContainer(refId);
      if (prev && prev !== cur && cur.parent === null && !isAncestorOrSelf(cur, prev)) {
        link(prev, cur);
      }
      prev = cur;
    }

    // Set this message's parent to the last reference, reparenting if a better parent appeared and
    // it does not introduce a cycle.
    if (prev && prev !== self && !isAncestorOrSelf(self, prev)) {
      detach(self);
      link(prev, self);
    }
  });

  // Roots = every container with no parent (from both the id table and the standalone set).
  const roots: Array<Container<M>> = [];
  for (const container of idTable.values()) {
    if (container.parent === null) roots.push(container);
  }
  for (const container of standalone) {
    if (container.parent === null) roots.push(container);
  }

  const pruned = pruneEmpties(roots, true);
  computeSortKeys(pruned);
  sortForest(pruned);
  return pruned.map(toNode);
}

/**
 * JWZ step 4 — prune empty containers. An empty leaf is dropped; an empty container with children
 * is spliced out (its children rise to its parent), except a root-level empty container with
 * multiple children is KEPT as a grouping root (so unrelated trees that share a missing ancestor
 * are not falsely merged under a single child).
 */
function pruneEmpties<M>(containers: Array<Container<M>>, isRoot: boolean): Array<Container<M>> {
  const result: Array<Container<M>> = [];
  for (const container of containers) {
    container.children = pruneEmpties(container.children, false);
    if (container.message === null) {
      if (container.children.length === 0) {
        continue; // empty leaf → drop
      }
      if (!isRoot || container.children.length === 1) {
        for (const child of container.children) child.parent = container.parent;
        result.push(...container.children);
        continue; // splice the empty container out
      }
      // root-level empty with multiple children → keep as a grouping container
    }
    result.push(container);
  }
  return result;
}

function computeSortKeys<M>(containers: Array<Container<M>>): number {
  let min = Number.POSITIVE_INFINITY;
  for (const container of containers) {
    const childMin = computeSortKeys(container.children);
    container.sortKey = Math.min(container.sortKey, childMin);
    if (container.sortKey < min) min = container.sortKey;
  }
  return min;
}

function sortForest<M>(containers: Array<Container<M>>): void {
  containers.sort((a, b) => a.sortKey - b.sortKey);
  for (const container of containers) sortForest(container.children);
}

function toNode<M>(container: Container<M>): ThreadNode<M> {
  return {
    id: container.id,
    message: container.message,
    synthetic: container.synthetic,
    children: container.children.map(toNode),
  };
}
