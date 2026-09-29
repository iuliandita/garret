// app/ui/src/nav-context-menu.ts
// Right-click a row in the navigator and act on THAT row: the three creates,
// Synopsis... and Who appears here... for a row that carries a body,
// Rename, Delete or Restore, and Revision state.
//
// A SECOND ROUTE, NOT A SECOND IMPLEMENTATION. Every operation here already
// exists and is already reachable from the Outline menu; `outline.ts` owns the
// mutations, this file owns nothing but which items a row is offered and what
// they were offered ON. The dropdown itself is `menu-panel.ts`, shared with the
// application menu.
//
// THE CAPTURED ROW IS THE WHOLE SLICE. `open(itemId, ...)` closes over that id
// and never asks the selection again. The menu bar already holds its labels for
// this reason - a selection change between paint and click silently turns a
// Restore into a Delete - and the navigator sharpens it twice over: it is a
// VIRTUAL list, so the row element the menu opened on may be unmounted by the
// time an item runs, and quick open's recorded defect (a scene marked open
// without moving the selection, so Outline > Delete binned the scene the writer
// had LEFT) is exactly this failure with a worse disguise, because the row under
// the pointer LOOKS selected.

import { isCompositionKey } from "./composition-key";
import { t } from "./i18n";
import { closeOnOutsideClick } from "./dismiss-outside";
import { clampToViewport, createMenuPanel, type MenuItemSpec } from "./menu-panel";

/** The keyboard route to this menu.
 *
 *  `Shift+F10` is the platform convention everywhere; `ContextMenu` is the
 *  dedicated key on keyboards that have one. Both, because a keyboard-first
 *  application whose newest affordance is pointer-only has shipped a feature
 *  half its users cannot reach.
 *
 *  IN ITS OWN MODULE rather than as two string literals in the navigator's
 *  listener, and that is not tidiness. `help.test.ts` parses
 *  `navigator/index.ts` for every `event.key === "..."` and fails when the panel
 *  does not show it, spelling the chord as the bare key - so an inline `"F10"`
 *  would demand a shortcuts row reading `F10`, which is a lie about a chord that
 *  needs Shift. A predicate carries the modifier WITH the key and gets its own
 *  named guard, exactly as `historyChordOf` does for Alt+Left. */
export function isContextMenuChord(event: KeyboardEvent): boolean {
  if (isCompositionKey(event)) return false;
  if (event.ctrlKey || event.altKey || event.metaKey) return false;
  if (event.key === "ContextMenu") return true;
  return event.key === "F10" && event.shiftKey;
}

export interface NavContextMenuDeps {
  /** Where the panel is appended. The body, not `#nav`: the panel is
   *  `position: fixed` and a row near the foot of the pane opens a menu that
   *  must be allowed to stand outside the navigator's own scroll box. */
  container: HTMLElement;
  /** A new item as the last child of the row the menu opened on. */
  /** A new item placed relative to the row this menu opened on. NOT "as a
   *  child of" it: the context menu and the Outline menu run the SAME placement
   *  rule against different anchors, which is what keeps them from being two
   *  answers to one question. No title -- see `Outline.create`. */
  create(relativeTo: string, itemType: string): void;
  /** Open the outline bar's rename field against that row. */
  beginRename(itemId: string): void;
  remove(itemId: string): void;
  restore(itemId: string): void;
  /** Is that row in the bin? Read ONCE, at open, and the answer is held. */
  trashed(itemId: string): boolean;
  /** The row's item type, read ONCE at open exactly like `trashed`: it decides
   *  whether Synopsis and Who appears here are offered at all, and re-reading
   *  it inside a handler would be asking the same question `trashed`'s own
   *  test guards against asking twice. Null for a row the walk no longer
   *  holds. */
  typeOf(itemId: string): string | null;
  openRevisionState(itemId: string): void;
  /** Synopsis... and Who appears here... -- the same two acts the
   *  Outline menu's `menu-synopsis` and `menu-appears` items reach, offered on
   *  the row this menu opened on rather than on whatever is selected. */
  openSynopsis(itemId: string): void;
  openAppears(itemId: string): void;
  /** Put focus back where the writer was. Called on Escape and on nothing else:
   *  an item that opens a panel moves focus itself, and a click already says
   *  where the writer wants to be. */
  returnFocus(): void;
  /** Injectable so the clamp can be tested against a window happy-dom does not
   *  have. */
  viewport?: () => { width: number; height: number };
}

export interface NavContextMenu {
  /** Open on `itemId` at viewport coordinates (`x`, `y`). The caller has already
   *  moved the selection onto that row. */
  open(itemId: string, x: number, y: number): void;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
}

const CREATES: ReadonlyArray<{ id: string; label: string; itemType: string }> = [
  { id: "nav-context-new-part", label: t("menu.new-part"), itemType: "part" },
  { id: "nav-context-new-chapter", label: t("menu.new-chapter"), itemType: "chapter" },
  { id: "nav-context-new-scene", label: t("menu.new-scene"), itemType: "scene" },
];

export function createNavContextMenu(deps: NavContextMenuDeps): NavContextMenu {
  // NO `target` FIELD, deliberately. The obvious shape is to hold the row the
  // menu is open on and read it when an item fires; every item here closes over
  // the id instead, so there is no second copy of the answer to go stale and no
  // state for a close to have to remember to clear. A field nothing reads is
  // worse than none, because a reader credits it.
  const panel = createMenuPanel({ id: "nav-context-menu" });
  deps.container.append(panel.element);

  /** The three types a synopsis or an appearances count is ABOUT: a scene, a
   *  bible note and a matter document all carry a body a writer writes prose
   *  into. A part, a chapter or a section header carries neither, which is
   *  the row-type distinction `style.css`'s own type rules already draw. */
  function carriesABody(itemId: string): boolean {
    const type = deps.typeOf(itemId);
    return type === "scene" || type === "note" || type === "matter";
  }

  function itemsFor(itemId: string): MenuItemSpec[] {
    // Read ONCE, here, and closed over by both the label and the action - so the
    // action taken is the one the writer READ, and it cannot be turned into its
    // opposite by anything that happens while the menu is up.
    const trashed = deps.trashed(itemId);
    const items: MenuItemSpec[] = [
      ...CREATES.map((spec) => ({
        id: spec.id,
        label: () => spec.label,
        run: () => deps.create(itemId, spec.itemType),
      })),
    ];
    // ABOVE RENAME: a writer reaching for the row's own words should
    // not have to pass the row's own name first.
    if (carriesABody(itemId)) {
      items.push(
        { id: "nav-context-synopsis", label: () => t("menu.synopsis"), run: () => deps.openSynopsis(itemId) },
        { id: "nav-context-appears", label: () => t("menu.appears"), run: () => deps.openAppears(itemId) },
      );
    }
    items.push(
      { id: "nav-context-rename", label: () => t("menu.rename"), run: () => deps.beginRename(itemId) },
      {
        id: "nav-context-remove",
        label: () => (trashed ? t("menu.restore") : t("menu.delete")),
        run: () => (trashed ? deps.restore(itemId) : deps.remove(itemId)),
      },
      {
        id: "nav-context-state",
        opensDialog: true,
        label: () => t("menu.revision-state"),
        run: () => deps.openRevisionState(itemId),
      },
    );
    return items;
  }

  function close(): void {
    panel.close();
  }

  function open(itemId: string, x: number, y: number): void {
    // Closing first, not toggling: a second right-click is a request to open on
    // whatever is under it now, which may be a different row.
    close();
    panel.paint(itemsFor(itemId), t("nav.context.label"));

    // Positioned only after painting, because the size to clamp against is the
    // size of what was painted. offsetWidth/offsetHeight are 0 under happy-dom,
    // which makes the clamp a no-op there and is why `clampToViewport` is a pure
    // function with its own tests rather than a claim about this line.
    const view = deps.viewport?.() ?? {
      width: window.innerWidth,
      height: window.innerHeight,
    };
    const at = clampToViewport(
      x,
      y,
      panel.element.offsetWidth,
      panel.element.offsetHeight,
      view.width,
      view.height,
    );
    panel.element.style.left = `${at.x}px`;
    panel.element.style.top = `${at.y}px`;

    panel.focusItem(0);
  }

  // On the DOCUMENT rather than on the panel: Escape must be heard even after a
  // click has taken focus out of the menu, which is the half of a dismissal the
  // recorded toggle-retirement defect lost.
  const onKeyDown = (event: KeyboardEvent): void => {
    if (isCompositionKey(event)) return;
    if (!panel.isOpen()) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      // The row the menu opened on is where the writer was. Without this, focus
      // falls to <body> and the keyboard has nowhere to continue from - a
      // recorded defect, which a context menu inherits with no toggle to return
      // to.
      deps.returnFocus();
      return;
    }
    panel.handleArrowKey(event);
  };
  document.addEventListener("keydown", onKeyDown);
  const stopOutsideClick = closeOnOutsideClick(panel.element, () => panel.isOpen(), close);

  let destroyed = false;
  return {
    open,
    close,
    isOpen: () => panel.isOpen(),
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      // Both are on the DOCUMENT, so they are the listeners that outlive every
      // element this unit owns and accumulate one live closure per project
      // switch - the recorded shape only counting finds.
      document.removeEventListener("keydown", onKeyDown);
      stopOutsideClick();
      panel.destroy();
    },
  };
}
