import { t } from "./i18n";
// app/ui/src/open.ts
// What a navigator activation means. Separate from main.ts because main.ts
// cannot be imported by a test, and separate from session.ts because the
// session deals in document ids and has no idea what an item's type is.
import { MATTER_TYPE, NOTE_TYPE, TIMELINE_TYPE } from "./item-types";
import type { Session } from "./session";

export interface OpenerDeps {
  /** switchTo alone: it already answers "is this the open document?" itself,
   *  and a second reader of the active id here would be a second place that
   *  could disagree with the session about which document is open. */
  session: Pick<Session, "switchTo">;
  /** The item's type, or undefined for an id no walk contains. Must read the
   *  LIVE walk: an item created after the page booted is openable the moment
   *  the navigator shows it, and a snapshot taken at mount time reports
   *  undefined for it forever. */
  typeOf(itemId: string): string | undefined;
  /** Tell the navigator which row is the open document. */
  markOpen(itemId: string): void;
  /** Opening a document means writing in it. */
  focusEditor(): void;
  onFailure(message: string): void;
}

/** The types that carry a document row: the store's `item_create` writes one for
 *  a scene, a bible document, a matter document and a timeline, and for nothing
 *  else. Parts, chapters and loose `doc` items stay selectable and are simply
 *  not openable - making a CONTAINER openable is a store change (a body per
 *  container), not a UI change.
 *
 *  A SET rather than one string, and 041 is the day the third arrived - which is
 *  what the shape was for. It is restated from `store::carries_document`, on the
 *  wire-contract rule that governs every type string here.
 *
 *  A TIMELINE IS IN THIS SET AND REACHES `switchTo` LIKE ANY OTHER OPENABLE
 *  TYPE (102) -- `session.ts`'s own `isTimelineDoc`/`onTimelineDoc` branch is
 *  what routes it away from `editor.replaceDoc` from there. 101 special-cased
 *  it here instead, before this build had anywhere to send one; that arm is
 *  gone along with `timeline.not-yet`, the sentence it raised. */
const OPENABLE: readonly string[] = ["scene", NOTE_TYPE, MATTER_TYPE, TIMELINE_TYPE];

/** Exported for the ONE other reader of this rule: quick open decides whether a
 *  chosen row is opened or merely selected, and a second copy of the list there
 *  is how a bible document became reachable by name and unopenable by Return. */
export function isOpenableType(itemType: string): boolean {
  return OPENABLE.includes(itemType);
}

export function createDocumentOpener(deps: OpenerDeps): (itemId: string) => Promise<void> {
  return async function open(itemId: string): Promise<void> {
    const type = deps.typeOf(itemId);
    // A miss is not the same answer as "this is not a scene". A part returning
    // silently is the design; an id no walk contains reached this function from
    // somewhere the page believes is a row, and reporting it as "nothing to do"
    // is how a dead activation path survives a graded run.
    if (type === undefined) {
      deps.onFailure(t("open.missing", { item: itemId }));
      return;
    }
    if (!isOpenableType(type)) return;
    const outcome = await deps.session.switchTo(itemId);
    if (outcome === "switched") {
      deps.markOpen(itemId);
      deps.focusEditor();
      return;
    }
    // Already open: the row was clicked, so the caret belongs back in the prose.
    if (outcome === "same") {
      deps.focusEditor();
      return;
    }
    // Silent: the switch the user already asked for is still running.
    if (outcome === "busy") return;
    // The only remaining member of the union: { kind: "failed", reason }.
    // Cause first, id second - a writer needs to know what is wrong before
    // which document it happened to.
    deps.onFailure(t("open.failed", { reason: outcome.reason, item: itemId }));
  };
}
