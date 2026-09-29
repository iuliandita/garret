import {
  closeHistory,
  isHistoryTransaction,
  redoDepth,
  undoDepth,
} from "prosemirror-history";
import type { EditorState, Transaction } from "prosemirror-state";

export type WordSource = "typing" | "pasted" | "imported" | "restored" | "unattributed";

export interface EditSourceChange {
  source: WordSource;
  beforeWords?: number;
}

function directSource(tr: Transaction): WordSource {
  if (tr.getMeta("wordSource") === "unattributed") return "unattributed";
  const event = tr.getMeta("uiEvent");
  return event === "paste" || event === "drop" ? "pasted" : "typing";
}

function align(labels: WordSource[], depth: number): void {
  if (labels.length > depth) labels.splice(0, labels.length - depth);
  while (labels.length < depth) labels.unshift("unattributed");
}

/** Keeps source labels beside ProseMirror's bounded history without reading its
 * private plugin metadata. Labels are ordered oldest to newest, like the public
 * depths: overflow drops the oldest labels and undo/redo moves the newest one.
 */
export class EditSourceTracker {
  private done: WordSource[] = [];
  private undone: WordSource[] = [];
  private lastSource: WordSource | null = null;

  /** Source transitions are event boundaries. Same-source edits retain
   * ProseMirror's normal time, adjacency and composition grouping. */
  prepare(tr: Transaction): void {
    if (isHistoryTransaction(tr)) return;
    const source = directSource(tr);
    if (this.lastSource !== null && source !== this.lastSource) closeHistory(tr);
  }

  /** Call after applying `tr`. `beforeWords` is lazy because counting on every
   * keystroke would put a full-document scan back on the typing path. */
  record(
    tr: Transaction,
    before: EditorState,
    after: EditorState,
    beforeWords: () => number,
  ): EditSourceChange {
    const beforeDone = undoDepth(before) as number;
    const beforeUndone = redoDepth(before) as number;
    const afterDone = undoDepth(after) as number;
    const afterUndone = redoDepth(after) as number;
    let source: WordSource;

    align(this.done, beforeDone);
    align(this.undone, beforeUndone);

    if (isHistoryTransaction(tr)) {
      const undoing = afterDone === beforeDone - 1;
      const redoing = afterUndone === beforeUndone - 1;
      if (undoing && !redoing) {
        source = this.done.pop() ?? "unattributed";
        this.undone.push(source);
      } else if (redoing && !undoing) {
        source = this.undone.pop() ?? "unattributed";
        this.done.push(source);
      } else {
        source = "unattributed";
      }
    } else {
      source = directSource(tr);
      if (tr.getMeta("addToHistory") === false) {
        // The edit still contributes saved movement, but it created no event
        // whose source could be inherited by a later undo or redo.
      } else if (afterDone > beforeDone) {
        this.done.push(source);
      } else if (afterDone < beforeDone) {
        // The history plugin trims in batches after its configured depth is
        // exceeded. Keep the new event and discard the same oldest labels.
        this.done.splice(0, beforeDone - afterDone + 1);
        this.done.push(source);
      } else if (this.lastSource !== null && source !== this.lastSource) {
        // A source transition is explicitly closed in prepare(), so an equal
        // depth here is not a history event we can label from public evidence.
        source = "unattributed";
      }
    }

    align(this.done, afterDone);
    align(this.undone, afterUndone);

    const changedSource = this.lastSource === null || source !== this.lastSource;
    this.lastSource = source;
    return changedSource ? { source, beforeWords: beforeWords() } : { source };
  }

  reset(): void {
    this.done = [];
    this.undone = [];
    this.lastSource = null;
  }
}
