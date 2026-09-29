import { isCompositionKey } from "./composition-key";
// app/ui/src/menu-panel.ts
// The dropdown itself: a list of items, painted from specs, walked with the
// arrow keys, closed before anything it was asked to do runs.
//
// EXTRACTED FROM menu-bar.ts RATHER THAN RESTATED, which is the opposite of the
// call this repo usually makes. The word count and the two tree walks are
// restated because they answer DIFFERENT questions in different languages
// against different data; a menu bar's dropdown and a navigator's context menu
// answer the SAME question, in one language, in one file, today. Two copies
// would drift on the one property that matters most here - close before run -
// and the drift would be invisible: both menus would still open, still paint,
// still run the item.
//
// WHAT IT DOES NOT OWN. It does not know where it sits (the bar anchors its
// panel in CSS, the context menu positions at the pointer), it does not own the
// keys that OPEN it (a surface binds its own opener - see the menu bar's Alt+key
// and the navigator's Shift+F10), and it decides nothing about any item. Every
// item calls a dep.

/** A row in a dropdown.
 *
 *  `label` is a function rather than a string because an item's text can depend
 *  on what is selected: the Outline menu offers Delete for a live row and
 *  Restore for one already in the bin. It is called when the menu is PAINTED and
 *  the result is held, so the action taken is the one the writer READ. */
export interface MenuItemSpec {
  id: string;
  label: () => string;
  /** Rendered right-aligned and appended to the accessible name. Purely
   *  informational: the shortcut is bound by the editor, the navigator or the
   *  find bar, never here. A menu that also bound them would be a second
   *  binding to drift from the real one. */
  shortcut?: string;
  /** Set on the items that open one of the page's `role="dialog"` panels, so a
   *  screen-reader user is told the item opens a thing.
   *
   *  Only `aria-haspopup`, deliberately - NOT `aria-expanded`. The menu closes
   *  the instant an item is activated, so an item is never the visible owner of
   *  an open panel and an expanded state on it would be false for the whole time
   *  the panel is up. */
  opensDialog?: boolean;
  enabled?: () => boolean;
  checked?: () => boolean;
  /** Draw a separator above this item (240). The separator is not an item:
   *  it is not focusable, the arrows skip it, and it carries no id, so
   *  menu-cli's id count and menu-drive's parsed indices do not see it. */
  separatorBefore?: boolean;
  run: () => void;
}

export interface MenuPanel {
  /** The element, for the caller to append and position. */
  readonly element: HTMLElement;
  isOpen(): boolean;
  /** Paint `items` and show. Labels are resolved HERE, once, and held. */
  paint(items: readonly MenuItemSpec[], label: string): void;
  close(): void;
  /** Wraps: a menu is a ring, and stopping at the ends costs a writer who held
   *  ArrowDown one extra decision for nothing. */
  focusItem(index: number): void;
  focusedIndex(): number;
  /** ArrowUp / ArrowDown. Returns true when it consumed the key, so a caller
   *  can go on to its own bindings when it did not. Does NOT handle Escape: what
   *  focus returns to differs per surface and is the caller's to answer. */
  handleArrowKey(event: KeyboardEvent): boolean;
  destroy(): void;
}

/** Keep a menu of `width` x `height` opened at (`x`, `y`) inside the viewport.
 *
 *  Pure, and exported for its own tests, because in happy-dom every box is
 *  0x0 and in the shipped app this is the difference between a menu a writer can
 *  read and one whose last two items are past the edge of the window. A row near
 *  the bottom of a long manuscript is the ordinary case, not an edge one.
 *
 *  Flips back by the overflow rather than mirroring about the pointer: a menu
 *  taller than the window would otherwise land at a negative y, which is the one
 *  failure worse than the one being fixed. Clamped at 0 for that reason. */
export function clampToViewport(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(x, viewportWidth - width)),
    y: Math.max(0, Math.min(y, viewportHeight - height)),
  };
}

export interface MenuPanelOptions {
  id: string;
  /** Fired whenever the panel goes from open to closed, INCLUDING the close an
   *  item performs before it runs.
   *
   *  Not a nicety: the surfaces around the panel hold state that must fall with
   *  it - the menu bar's `aria-expanded` on the title it opened from, and the
   *  context menu's captured row. Without it an item click leaves the panel
   *  hidden and its owner still believing a menu is open, and the next request
   *  to open that same menu reads as a re-open and closes nothing twice. */
  onClose?: () => void;
}

export function createMenuPanel(opts: MenuPanelOptions): MenuPanel {
  const panel = document.createElement("div");
  panel.id = opts.id;
  panel.setAttribute("role", "menu");
  panel.hidden = true;

  let items: HTMLButtonElement[] = [];

  function close(): void {
    if (panel.hidden) return;
    items = [];
    panel.hidden = true;
    panel.replaceChildren();
    // AFTER the panel is already closed, so an owner whose handler closes again
    // finds nothing to do and the notification cannot recur.
    opts.onClose?.();
  }

  function focusItem(index: number): void {
    if (items.length === 0) return;
    const count = items.length;
    const clamped = ((index % count) + count) % count;
    items[clamped]?.focus();
  }

  function focusedIndex(): number {
    return items.findIndex((element) => element === document.activeElement);
  }

  // A free function rather than a method, so a caller that destructures the
  // returned object still gets a working handler: `this` inside an object
  // literal is the call site's receiver, and a menu whose arrows silently stop
  // working when the panel is passed around is a defect no type would catch.
  function handleArrowKey(event: KeyboardEvent): boolean {
    if (isCompositionKey(event)) return false;
    if (panel.hidden) return false;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusItem(focusedIndex() + 1);
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      const index = focusedIndex();
      focusItem(index < 0 ? -1 : index - 1);
      return true;
    }
    return false;
  }

  return {
    element: panel,
    isOpen: () => !panel.hidden,

    paint(specs: readonly MenuItemSpec[], label: string): void {
      const rendered: HTMLButtonElement[] = [];
      const children: HTMLElement[] = [];
      for (const spec of specs) {
        if (spec.separatorBefore === true && rendered.length > 0) {
          const rule = document.createElement("div");
          rule.className = "menu-separator";
          rule.setAttribute("role", "separator");
          children.push(rule);
        }
        const element = document.createElement("button");
        element.id = spec.id;
        element.type = "button";
        element.setAttribute("role", spec.checked ? "menuitemradio" : "menuitem");
        if (spec.checked) element.setAttribute("aria-checked", String(spec.checked()));
        if (spec.opensDialog === true) element.setAttribute("aria-haspopup", "dialog");
        // Every item is reachable by ArrowDown from the opener, so none of them
        // needs to be a tab stop of its own; -1 keeps Tab leaving the menu
        // entirely rather than walking items the arrows already cover.
        element.tabIndex = -1;
        if (spec.enabled) element.setAttribute("aria-disabled", String(!spec.enabled()));

        const text = document.createElement("span");
        text.className = "menu-item-label";
        text.textContent = spec.label();
        element.append(text);

        if (spec.shortcut !== undefined) {
          const hint = document.createElement("span");
          hint.className = "menu-item-shortcut";
          hint.textContent = spec.shortcut;
          // The hint is decoration for the accessible name's purposes: it is
          // appended to the name below in a form a screen reader can read out
          // ("Undo, Control Z" rather than the glyph soup a visible hint may
          // become), so exposing the span as well would say it twice.
          hint.setAttribute("aria-hidden", "true");
          element.append(hint);
          element.setAttribute("aria-keyshortcuts", spec.shortcut);
        }

        element.addEventListener("click", () => {
          if (spec.enabled?.() === false) return;
          // Close BEFORE running. The item may open a panel and move focus into
          // it, and a dropdown still painted over that panel is the writer's
          // next click landing on the wrong surface. Observed from inside the
          // dep, never through a second listener on this element: listeners fire
          // in registration order, so an observing listener added afterwards
          // runs after `close()` either way and passes against the reversed
          // implementation.
          close();
          spec.run();
        });
        rendered.push(element);
        children.push(element);
      }

      panel.replaceChildren(...children);
      panel.setAttribute("aria-label", label);
      panel.hidden = false;
      items = rendered;
    },

    close,
    focusItem,
    focusedIndex,
    handleArrowKey,

    destroy(): void {
      // The item elements go with it: they are children of the panel and carry
      // the only listeners this module registers. Nothing here is on the
      // document, deliberately - a shared module that registered document-level
      // listeners would leak one set per surface using it, which is the recorded
      // shape only counting finds.
      close();
      panel.remove();
    },
  };
}
