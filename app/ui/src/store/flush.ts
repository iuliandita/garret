// app/ui/src/store/flush.ts
// The debounce lives here, not in the host: a commit is a dirty-document flush
// at most DEBOUNCE_MS after the FIRST unflushed edit. Not a sliding window — a
// sliding window lets continuous typing defer a flush indefinitely, which is
// exactly the case the one-second recovery target is written for.
//
// Timers and the clock are injected so this is testable without a GUI, without
// a host, and without waiting in real time.
import { percentiles } from "../measure/stats";
import type { EditSourceChange, WordSource } from "../edit-source";

export const DEBOUNCE_MS = 1000;

export interface FlushEntry {
  item_id: string;
  body: string;
  base_rev: number;
  /** Where this document's comments now sit, or undefined for "leave them
   *  alone". Rides the body so a position and the prose it describes reach the
   *  file in ONE transaction: two schedules are two states of one fact and they
   *  are free to disagree about where a note is. */
  comments?: readonly { id: number; from: number; to: number }[];
}

export interface FlushAck {
  item_id: string;
  rev: number;
}

/** The word movement credited to one edit source at a persistence checkpoint. */
export interface SourceMovement {
  source: WordSource;
  added: number;
  deleted: number;
}

/** Attribution is deliberately alongside, rather than inside, FlushEntry: prose
 * persistence remains byte-for-byte the same request for callers that do not
 * provide a trustworthy source baseline. */
export interface FlushAttribution {
  item_id: string;
  day: string;
  changes: SourceMovement[];
}

export interface FlushStats {
  count: number;
  entries: number;
  errors: number;
  conflicts: number;
  p50: number;
  p95: number;
}

/** What the writer needs to know about their work: is it in the file yet.
 *
 *  `pending` deliberately merges "dirty, debounce armed" with "flush in flight".
 *  They are different states of this scheduler and the same answer to the only
 *  question the indicator exists to answer, and a surface that distinguished
 *  them would be reporting on the implementation rather than on the manuscript.
 *
 *  DERIVED, never assigned by a caller. `saved` is a claim about the file, and
 *  the one failure this surface must never have is saying `saved` when it is
 *  not: an indicator that can be set is an indicator that can be set wrongly. */
export type SaveState = "saved" | "pending" | "failed";

export interface FlushSchedulerOptions {
  invoke: (entries: FlushEntry[], attribution?: FlushAttribution[]) => Promise<FlushAck[]>;
  /** Where one document's comments currently are, read AT FLUSH TIME rather
   *  than at markDirty time. Two reasons, and both matter:
   *
   *  - The keystroke path is untouched. `markDirty` runs per character and
   *    still carries one string; the anchors are read once per flush, about
   *    once a second.
   *  - "Current" means current. Positions read when the debounce was armed
   *    would be a second's worth of edits out of date by the time they reach
   *    the file.
   *
   *  Returns undefined for any document that is not the open one -- only the
   *  open one can have been edited -- and for the open one when its mapping has
   *  been capped, so the last positions known to be right are the ones that
   *  stay. */
  commentsOf?: (itemId: string) => readonly { id: number; from: number; to: number }[] | undefined;
  /** The editor owns the only document-aware word count. Without it, source
   * provenance stays absent rather than being guessed from serialized JSON. */
  wordCountOf?: (body: string) => number;
  /** The host's local-day rule. Attribution must not invent a date when the
   * enclosing project has not supplied one. */
  localDay?: () => string;
  debounceMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Raised once, on the first failure. `error` is what was thrown, so the
   *  banner can keep the host's diagnostic apart from its sentence. */
  onFailure?: (message: string, error?: unknown) => void;
  /** Fired on a TRANSITION only, never on every edit. `markDirty` runs on the
   *  keystroke path, and a subscriber invoked per character would put whatever
   *  the display unit does inside the typing budget. */
  onStateChange?: (state: SaveState) => void;
}

export interface FlushScheduler {
  /** Teach the scheduler the stored revision of a document it may flush. */
  register(itemId: string, rev: number): void;
  markDirty(itemId: string, body: string, change?: EditSourceChange): void;
  /** Resolves when any in-flight flush has settled. Tests await this. */
  settled(): Promise<void>;
  stats(): FlushStats;
  failed(): boolean;
  dirtyCount(): number;
  /** The last rev the store acked for this item, or the registered rev if it never flushed. */
  revOf(itemId: string): number | undefined;
  /** Whether the writer's work is in the file. Derived from what the scheduler
   *  already knows exactly; there is no setter. */
  saveState(): SaveState;
  /** Force any pending edits out now, bypassing the debounce, and wait for
   *  them to land. `settled()` only awaits a flush already in flight; a timer
   *  armed but not yet fired would otherwise be lost at shutdown. */
  drain(): Promise<void>;
  /** Retire this scheduler: clear any armed timer and refuse further work.
   *  Idempotent, synchronous, and it does NOT flush - the caller drains first.
   *
   *  Dropping the reference is not enough. The debounce timer holds a live
   *  callback, so a scheduler belonging to a project the writer has left could
   *  still fire into a store that is no longer the one its item ids and
   *  revisions describe. Two projects seeded from the same generator share item
   *  ids outright, so that write would land on a real row in the wrong
   *  manuscript. The host's generation check would refuse it, but a backstop
   *  is not a reason to leave the timer armed. */
  stop(): void;
}

export function createFlushScheduler(opts: FlushSchedulerOptions): FlushScheduler {
  const {
    invoke,
    commentsOf,
    wordCountOf,
    localDay,
    debounceMs = DEBOUNCE_MS,
    now = () => performance.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (h) => clearTimeout(h as Parameters<typeof clearTimeout>[0]),
    onFailure,
    onStateChange,
  } = opts;

  interface SourceLedger {
    /** Finished source segments, aggregated in first-seen order. */
    changes: SourceMovement[];
    /** The one source segment whose end is not known until the next transition
     * or the body is claimed for a write. */
    current?: { source: WordSource; beforeWords: number };
    /** Source transitions are bounded so a malformed editor stream cannot
     * enlarge an autosave request without limit. */
    segments: number;
    /** The last claimed count lets a same-source edit during an in-flight write
     * start at the exact checkpoint it follows. */
    claimed?: { source: WordSource; words: number };
  }

  interface DirtyDocument {
    body: string;
    ledger?: SourceLedger;
  }

  const MAX_SOURCE_SEGMENTS = 256;
  const dirty = new Map<string, DirtyDocument>();
  const inFlightItems = new Set<string>();
  const claimedBaselines = new Map<string, { source: WordSource; words: number }>();
  const revs = new Map<string, number>();
  const latencies: number[] = [];
  let timer: unknown = null;
  let inFlight: Promise<void> = Promise.resolve();
  let failedFlag = false;
  let stopped = false;
  let errors = 0;
  let conflicts = 0;
  let flushes = 0;
  let entryCount = 0;
  let flushing = false;
  let flushOwed = false;

  function usableCount(value: number | undefined): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isInteger(value);
  }

  function appendMovement(ledger: SourceLedger, source: WordSource, before: number, after: number): void {
    const movement = ledger.changes.find((change) => change.source === source) ?? (() => {
      const created: SourceMovement = { source, added: 0, deleted: 0 };
      ledger.changes.push(created);
      return created;
    })();
    if (after >= before) movement.added += after - before;
    else movement.deleted += before - after;
  }

  function cloneLedger(ledger: SourceLedger | undefined): SourceLedger | undefined {
    return ledger && {
      changes: ledger.changes.map((change) => ({ ...change })),
      current: ledger.current && { ...ledger.current },
      segments: ledger.segments,
      claimed: ledger.claimed && { ...ledger.claimed },
    };
  }

  function mergeLedger(before: SourceLedger | undefined, after: SourceLedger | undefined): SourceLedger | undefined {
    if (!before) return cloneLedger(after);
    if (!after) return cloneLedger(before);
    const merged: SourceLedger = { changes: before.changes.map((change) => ({ ...change })), segments: before.segments + after.segments };
    for (const change of after.changes) appendMovement(merged, change.source, 0, change.added), appendMovement(merged, change.source, change.deleted, 0);
    merged.current = after.current && { ...after.current };
    merged.claimed = after.claimed && { ...after.claimed };
    return merged.segments > MAX_SOURCE_SEGMENTS ? undefined : merged;
  }

  function recordChange(itemId: string, document: DirtyDocument, change: EditSourceChange | undefined): void {
    // A caller without source metadata may have changed the body. Continuing a
    // prior segment would manufacture a typing credit for an edit we cannot
    // identify, so the whole pending checkpoint stays unattributed.
    if (!change) {
      document.ledger = undefined;
      return;
    }
    if (!wordCountOf) return;
    if (change.beforeWords !== undefined && !usableCount(change.beforeWords)) {
      document.ledger = undefined;
      return;
    }
    const before = change.beforeWords;
    const ledger = document.ledger;
    if (!ledger) {
      // An explicit counter belongs to this editor state, including after a
      // reload. It outranks a checkpoint baseline left by the prior state.
      if (usableCount(before)) {
        document.ledger = { changes: [], current: { source: change.source, beforeWords: before }, segments: 1 };
        return;
      }
      const claimed = claimedBaselines.get(itemId);
      if (claimed?.source === change.source) {
        document.ledger = {
          changes: [],
          current: { source: change.source, beforeWords: claimed.words },
          segments: 1,
          claimed,
        };
        return;
      }
      return;
    }
    if (!ledger.current) {
      if (ledger.claimed?.source === change.source && usableCount(ledger.claimed.words)) {
        ledger.current = { source: change.source, beforeWords: ledger.claimed.words };
        ledger.segments++;
        return;
      }
      if (!usableCount(before)) {
        document.ledger = undefined;
        return;
      }
      ledger.current = { source: change.source, beforeWords: before };
      ledger.segments++;
      return;
    }
    if (ledger.current.source === change.source) return;
    if (!usableCount(before) || ledger.segments >= MAX_SOURCE_SEGMENTS) {
      document.ledger = undefined;
      return;
    }
    appendMovement(ledger, ledger.current.source, ledger.current.beforeWords, before);
    ledger.current = { source: change.source, beforeWords: before };
    ledger.segments++;
  }

  function claimAttribution(itemId: string, document: DirtyDocument): FlushAttribution | undefined {
    const ledger = document.ledger;
    if (!ledger || !ledger.current || !wordCountOf || !localDay || ledger.segments > MAX_SOURCE_SEGMENTS) return undefined;
    let finalWords: number;
    let day: string;
    try {
      finalWords = wordCountOf(document.body);
      day = localDay();
    } catch {
      return undefined;
    }
    if (!usableCount(finalWords) || !day) return undefined;
    appendMovement(ledger, ledger.current.source, ledger.current.beforeWords, finalWords);
    ledger.claimed = { source: ledger.current.source, words: finalWords };
    claimedBaselines.set(itemId, ledger.claimed);
    ledger.current = undefined;
    const changes = ledger.changes.filter((change) => change.added > 0 || change.deleted > 0).map((change) => ({ ...change }));
    return changes.length === 0 ? undefined : { item_id: itemId, day, changes };
  }

  function saveState(): SaveState {
    if (failedFlag) return "failed";
    // `flushing` and not `dirty.size` alone: `fire` clears the map before it
    // awaits, so between the clear and the ack the writer's last sentence is in
    // neither place. Reading `dirty` on its own would report `saved` for the
    // whole duration of the write that is still happening.
    return dirty.size > 0 || flushing ? "pending" : "saved";
  }

  // The transition filter. Every emit goes through here, so no call site has to
  // remember not to re-announce a state the display is already showing.
  let announced: SaveState = "saved";
  function announce(): void {
    const next = saveState();
    if (next === announced) return;
    announced = next;
    onStateChange?.(next);
  }

  function fire(): void {
    timer = null;
    if (stopped || failedFlag || dirty.size === 0) return;

    // A later timer may expire while the host is still applying the previous
    // batch. It must leave this snapshot alone: its base_rev becomes current
    // only after that batch's acknowledgement.
    if (flushing) {
      flushOwed = true;
      return;
    }

    let startedAt = 0;
    const captured = new Map(dirty);
    dirty.clear();
    for (const itemId of captured.keys()) inFlightItems.add(itemId);
    flushing = true;
    // An async boundary catches preparation and synchronous bridge failures
    // without delaying the invocation into a later microtask.
    const send = async (): Promise<FlushAck[]> => {
      const entries: FlushEntry[] = [...captured].map(([item_id, document]) => ({
        item_id,
        body: document.body,
        base_rev: revs.get(item_id) ?? 0,
        comments: commentsOf?.(item_id),
      }));
      const attribution = [...captured].flatMap(([itemId, document]) => {
        const claimed = claimAttribution(itemId, document);
        return claimed ? [claimed] : [];
      });
      startedAt = now();
      return invoke(entries, attribution.length > 0 ? attribution : undefined);
    };
    inFlight = send()
      .then((acks) => {
        if (stopped) return;
        latencies.push(now() - startedAt);
        flushes++;
        entryCount += captured.size;
        for (const ack of acks) revs.set(ack.item_id, ack.rev);
      })
      .catch((err: unknown) => {
        if (stopped) return;
        // Put the entries back. Nothing may be lost before the user acts, and
        // autosave stops rather than retrying into the same failure.
        for (const [itemId, document] of captured) {
          const newer = dirty.get(itemId);
          if (newer) {
            newer.ledger = mergeLedger(document.ledger, newer.ledger);
          } else {
            dirty.set(itemId, document);
          }
        }
        errors++;
        const message = err instanceof Error ? err.message : String(err);
        if (message.toLowerCase().includes("conflict")) conflicts++;
        failedFlag = true;
        if (timer !== null) {
          clearTimer(timer);
          timer = null;
        }
        onFailure?.(message, err);
      })
      // Both arms, and AFTER them: the state is `saved` only once the ack has
      // been recorded, and `failed` only once the flag is set.
      .finally(() => {
        for (const itemId of captured.keys()) inFlightItems.delete(itemId);
        flushing = false;
        if (!stopped && !failedFlag && dirty.size > 0 && flushOwed) {
          flushOwed = false;
          fire();
        }
        if (!stopped) announce();
      });
  }

  return {
    register(itemId: string, rev: number): void {
      if (dirty.has(itemId) || inFlightItems.has(itemId)) return;
      revs.set(itemId, rev);
      // register is a loaded document boundary. A prior editor's claimed
      // count cannot safely seed the first source segment in this one.
      claimedBaselines.delete(itemId);
    },
    markDirty(itemId: string, body: string, change?: EditSourceChange): void {
      // A retired scheduler belongs to a project that is gone. Arming a timer
      // here would schedule a write against a store whose ids these no longer
      // describe.
      if (stopped) return;
      if (failedFlag) {
        const document = dirty.get(itemId) ?? { body };
        document.body = body;
        recordChange(itemId, document, change);
        dirty.set(itemId, document);
        return;
      }
      const document = dirty.get(itemId) ?? { body };
      document.body = body;
      recordChange(itemId, document, change);
      dirty.set(itemId, document);
      // Armed by the FIRST unflushed edit and never re-armed by later ones.
      if (timer === null) timer = setTimer(fire, debounceMs);
      // Filtered to transitions, so this costs one comparison per keystroke
      // rather than one repaint per keystroke.
      announce();
    },
    settled: () => inFlight,
    stats(): FlushStats {
      const p = percentiles(latencies);
      return {
        count: flushes,
        entries: entryCount,
        errors,
        conflicts,
        p50: p.p50,
        p95: p.p95,
      };
    },
    failed: () => failedFlag,
    dirtyCount: () => dirty.size,
    revOf: (itemId) => revs.get(itemId),
    saveState,
    // Deliberately does NOT announce. `stop` clears the dirty map, so the
    // derived state becomes `saved` — but the work in it was discarded, not
    // written, and telling a departing project's display "saved" is the one
    // thing this surface must never do. The caller drains first; that drain is
    // what legitimately announces `saved`.
    stop(): void {
      stopped = true;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      dirty.clear();
    },
    async drain(): Promise<void> {
      while (!failedFlag && dirty.size > 0) {
        if (timer !== null) {
          clearTimer(timer);
          timer = null;
        }
        fire();
        await inFlight;
      }
      await inFlight;
    },
  };
}
