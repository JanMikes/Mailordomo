/**
 * Daemon seams (PROJECT.md §6; PLAN.md D34). The background daemon orchestrates the existing engines
 * over a stream of new messages — it does NOT reimplement them. Everything non-deterministic or
 * IO-bound is INJECTED so the orchestrator (`runDaemonCycle`) is a pure-ish, fully-fakeable function:
 * the message source, the Claude runner, the usage throttle, the metadata writer, the clock + id
 * factory, and — critically — the draft FILER for the sanctioned overdue-nudge.
 *
 * GOLDEN RULE #1 (sending is ALWAYS manual): nothing under `daemon/**` imports `smtp/**`, `api/**`,
 * or the backend root barrel (the D18/D31 ESLint guard enforces it). The daemon can DRAFT (the
 * nudge), but the {@link DraftFiler} that performs the save is constructed OUTSIDE the daemon (in the
 * composition root, which may import smtp) and injected here. There is no transmit verb on this seam.
 */
import type {
  CreateDraftMetaRequest,
  CreatePromiseRequest,
  CreateTaskRequest,
  CreateTaskTransitionRequest,
  DraftMeta,
  PromiseRecord,
  Task,
  TaskState,
  TaskTransition,
} from '@mailordomo/shared';
import type { DraftFiler } from '../claude/nudge';
import type { ThreadMessageInput } from '../claude/summarize';
import type { ClaudeRunner } from '../claude/types';
import type { UsageThrottle } from '../claude/throttle';
import type { StaleThresholds } from '../engines/stale';

export type { DraftFiler };

/**
 * One inbound message to process this cycle, plus the thread/task context the engines need. The
 * SOURCE (which owns IMAP/cache state) builds these; the orchestrator stays decoupled from transport.
 * Bodies are read LOCALLY (this runs on the user's machine) — fine per Golden rule #3.
 */
export interface DaemonMessage {
  /** The metadata-service thread id this message belongs to (the source upserts the thread first). */
  readonly threadId: string;
  /** Thread subject (triage/extract context; the nudge/draft subject). */
  readonly subject: string;
  /** The other party — display name/address; the recipient of any nudge. */
  readonly sender: string;
  /** Sanctioned snippet for triage. */
  readonly snippet: string;
  /** Full plain-text body, read locally (extraction reasons over the prose). */
  readonly body: string;
  /** ISO-8601 instant the message was received — the deadline anchor + the thread's last activity. */
  readonly receivedIso: string;
  /** IANA mailbox timezone for deadline resolution (defaults to Europe/Prague in the extractor). */
  readonly timezone?: string;
  /** The current task on the thread (id + state + the staleness inputs), or a brand-new thread. */
  readonly task: DaemonTaskContext;
  /** The thread's messages (oldest→newest, with bodies) for the optional Sonnet summary. May be empty. */
  readonly threadMessages: readonly ThreadMessageInput[];
}

/** The current task context for a thread: identity + state + the inputs `detectStale` reasons over. */
export interface DaemonTaskContext {
  /** Existing task id, or `null` for a brand-new thread (the orchestrator creates the task). */
  readonly id: string | null;
  /** Current task state — the `from` state for transitions and the staleness verdict. */
  readonly state: TaskState;
  /** ISO-8601 of the thread's last activity (drives staleness). Null = unknown. */
  readonly lastActivityIso: string | null;
  /** ISO-8601 follow-up deadline, if set. */
  readonly followUpAtIso?: string | null;
  /** ISO-8601 hard deadline, if set. */
  readonly deadlineIso?: string | null;
}

/** The message source — owns "what is new" (IMAP poll → cache → enumerate). Fakeable in tests. */
export interface DaemonSource {
  /** Return the messages to process this cycle (already upserted as metadata threads). */
  poll(): Promise<readonly DaemonMessage[]>;
}

/**
 * The narrow metadata WRITE/READ surface the daemon needs — a structural subset of `MetadataClient`
 * (the real client satisfies it; tests pass a fake). Deliberately small: the daemon writes task/
 * transition/promise/draft METADATA and reads back promises + draft metadata for the nudge. It has
 * NO method that could transmit mail.
 */
export interface DaemonMetadataPort {
  createTask(req: CreateTaskRequest): Promise<Task>;
  createTransition(taskId: string, req: CreateTaskTransitionRequest): Promise<TaskTransition>;
  createPromise(req: CreatePromiseRequest): Promise<PromiseRecord>;
  listPromises(threadId?: string): Promise<PromiseRecord[]>;
  listDraftMeta(threadId?: string): Promise<DraftMeta[]>;
  createDraftMeta(req: CreateDraftMetaRequest): Promise<DraftMeta>;
}

/** Dependencies for one daemon cycle. Everything injected ⇒ the orchestrator is fully fakeable. */
export interface DaemonCycleDeps {
  readonly source: DaemonSource;
  readonly runner: ClaudeRunner;
  readonly throttle: UsageThrottle;
  readonly metadata: DaemonMetadataPort;
  /** The sanctioned overdue-nudge filer (saveDraft-only) — injected from OUTSIDE `daemon/**`. */
  readonly filer: DraftFiler;
  /** User-adjustable stale thresholds (D27). Defaults applied by `detectStale`. */
  readonly staleThresholds?: StaleThresholds;
  /** Injected clock → ISO "now" (default wall clock). Tests pass a fixed instant. */
  readonly now?: () => string;
  /** Injected id factory for reconciled promises (default `crypto.randomUUID`). */
  readonly newId?: () => string;
  /** Optional sink for a freshly-computed thread summary (default: discarded — see D35). */
  readonly onSummary?: (threadId: string, summary: string) => void;
  /** Structured logger (default `console`). */
  readonly logger?: (message: string, meta?: unknown) => void;
}

/** Aggregate result of one cycle — what the daemon did (for logs/metrics/tests). */
export interface DaemonCycleResult {
  readonly processed: number;
  readonly tasksCreated: number;
  readonly transitions: number;
  readonly promisesCreated: number;
  readonly summarized: number;
  readonly nudgesDrafted: number;
  /** Deferrable jobs (summary) skipped by usage-throttle backpressure. */
  readonly deferred: number;
  /** Per-message failures (the cycle is resilient — one bad message never aborts the pass). */
  readonly errors: readonly { readonly threadId: string; readonly error: string }[];
}
