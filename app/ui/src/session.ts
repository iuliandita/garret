// app/ui/src/session.ts
// The seam between "the document changed" and "the store was written", and the
// only place that knows which document is open.
//
// The ordering in switchTo is the load-bearing part of this file. noteChange is
// `markDirty(docId, editor.serialize())` - one line that reads both the id and
// the editor - so any interleaving that lets a change fire while those two
// disagree writes one document's prose under another document's id.
import { t } from "./i18n";
import type { DocInput, PmNodeJson } from "./editor";
import type { EditSourceChange } from "./edit-source";
import type { FlushScheduler } from "./store/flush";

/** A failure carries the reason it happened, not just that it happened - the
 *  one case here whose cause a writer or a bug report needs, distinct from
 *  the item id the caller already has. */
export type SwitchOutcome = "switched" | "same" | "busy" | { kind: "failed"; reason: string };

export interface SessionEditor {
  /** The current document, serialized the way the store holds it. */
  serialize(): string;
  /** Replace the whole document. Must not fire onChange (see editor.ts). */
  replaceDoc(input: DocInput): void;
}

export interface SessionDeps {
  editor: SessionEditor;
  flusher: Pick<FlushScheduler, "markDirty" | "drain" | "register" | "failed">;
  /** Injected rather than a raw invoke, so this unit needs no Tauri bridge and
   *  no command-name string to be tested. */
  loadDoc(itemId: string): Promise<{ body: string; rev: number }>;
  docId: string;
  /** True for an item this session must hand to `onTimelineDoc` rather than
   *  `editor.replaceDoc`. Absent (or answering false for every id)
   *  reproduces the earlier behaviour exactly: every switch is a prose
   *  document. */
  isTimelineDoc?(itemId: string): boolean;
  /** The second document kind: `switchTo` hands the
   *  RAW body straight through -- it is never `JSON.parse`d as `PmNodeJson`,
   *  because it is not one, and the caller's own parser
   *  (`timeline-model.ts`'s `parseTimeline`) already answers `newer`/
   *  `invalid` without throwing. That is what lets this run with no
   *  try/catch of its own, unlike the `editor.replaceDoc` branch below. */
  onTimelineDoc?(itemId: string, body: string): void;
  /** The last outgoing display bytes, after the final drain and before the
   *  editor's identity moves. A read-only companion can retain this exact
   *  body while an older saved-body read is still in flight. */
  beforeSwap?(itemId: string, body: string): void;
}

export interface Session {
  activeDocId(): string;
  /** The document changed. Arms the flush debounce. */
  noteChange(change?: EditSourceChange): void;
  /** Everything dirty reaches the store, or the scheduler has failed. Used at
   *  all three safety points: blur, visibility loss, window close.
   *
   *  drain(), never settled(): settled() awaits only a flush already in flight,
   *  so a debounce timer armed by the very last keystroke would be dropped. */
  flushPending(): Promise<void>;
  /** Open another document. See the ordering comment at the top of this file. */
  switchTo(itemId: string): Promise<SwitchOutcome>;
}

export function createSession(deps: SessionDeps): Session {
  const { editor, flusher, loadDoc } = deps;
  let docId = deps.docId;
  let switching = false;

  return {
    activeDocId: () => docId,
    noteChange(change?: EditSourceChange): void {
      // Timeline edits supply their own body directly to the flusher.
      if (deps.isTimelineDoc?.(docId) === true) return;
      flusher.markDirty(docId, editor.serialize(), change);
    },
    flushPending: () => flusher.drain(),
    async switchTo(itemId: string): Promise<SwitchOutcome> {
      if (itemId === docId) return "same";
      // Dropped, not queued. A queue of one is a queue whose head is stale by
      // the time it runs, and a queue of many turns a keyboard repeat into a
      // burst of store loads. The user's next click still works.
      if (switching) return "busy";
      switching = true;
      try {
        // 1. The outgoing document reaches the store before anything else
        //    happens, so the load below reads an authoritative copy.
        await flusher.drain();
        // 2. Autosave is broken and the failure banner is already up.
        if (flusher.failed()) {
          return { kind: "failed", reason: t("session.save-refused") };
        }
        // 3. Safe to yield here: docId still names the outgoing document, so a
        //    keystroke landing during this await is marked dirty against the
        //    document it actually belongs to.
        const doc = await loadDoc(itemId);
        const timeline = deps.isTimelineDoc?.(itemId) === true;
        // 4. Parsed BEFORE the id moves, prose only. `doc.body` is the only
        //    untrusted input in this function, and a malformed one throwing
        //    between the assignment and the swap would leave the id naming
        //    the incoming document while the editor still held the outgoing
        //    one - which is exactly the state every other line here exists
        //    to prevent, made permanent for the life of the window. A
        //    timeline's body is never `PmNodeJson` and is not parsed here at
        //    all -- `onTimelineDoc`'s own caller (timeline-model.ts's
        //    `parseTimeline`) answers `newer`/`invalid` without throwing, so
        //    there is nothing this step needs to guard against for that arm.
        const json = timeline ? null : (JSON.parse(doc.body) as PmNodeJson);
        // Loading yields while the outgoing editor remains writable. Its last
        // body and live comment positions must land before that editor goes.
        await flusher.drain();
        if (flusher.failed()) {
          return { kind: "failed", reason: t("session.late-save-refused") };
        }
        if (deps.isTimelineDoc?.(docId) !== true) deps.beforeSwap?.(docId, editor.serialize());
        flusher.register(itemId, doc.rev);
        // 5. No await between these two. Neither `replaceDoc` nor
        //    `onTimelineDoc` fires onChange, so nothing can observe the pair
        //    half-applied. `replaceDoc` CAN still throw (the JSON parses but
        //    does not fit the schema), so the id is restored rather than
        //    left pointing at a document the editor never loaded;
        //    `onTimelineDoc` cannot (its own caller's parser never throws),
        //    so it needs no try/catch of its own.
        const outgoing = docId;
        docId = itemId;
        if (timeline) {
          deps.onTimelineDoc?.(itemId, doc.body);
        } else {
          try {
            editor.replaceDoc({ kind: "pmjson", json: json as PmNodeJson });
          } catch (err: unknown) {
            docId = outgoing;
            throw err;
          }
        }
        return "switched";
      } catch (err: unknown) {
        return { kind: "failed", reason: String(err) };
      } finally {
        switching = false;
      }
    },
  };
}
