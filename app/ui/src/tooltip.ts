import { isCompositionKey } from "./composition-key";
// app/ui/src/tooltip.ts
// A control's name, made visible again.
//
// NOTHING IN THIS APPLICATION HAS NEEDED ONE UNTIL NOW, and that is the whole
// argument for it existing. Every control here has carried its name as visible
// text, so the name was always on screen and a tip would have repeated it. An
// icon-only control breaks that: the accessible name survives on `aria-label`,
// which a screen reader reads and a sighted user cannot.
//
// NOT `element.title`. The native tooltip appears for the POINTER only -- a
// keyboard user who tabs onto an icon-only button is shown nothing, ever -- and
// its delay, its placement and its palette all belong to the toolkit. This unit
// shows on `mouseenter` AND on `focus`, which is the half that matters.
//
// IT IS NOT PART OF THE NAME. The tip is a sibling of the control inside an
// anchor span, never a child of the button: name-from-content would otherwise
// fold the hint sentence into the control's accessible name, so a screen-reader
// user would hear the caveat every time and every rig matching the name exactly
// would stop finding the control. `aria-hidden="true"` for the same reason --
// the button's own name already carries what the tip says.
//
// THE ANCHOR CARRIES NO GEOMETRY. #project-bar is 39px and that is a
// click-geometry constant restated in switch-cli and outline-cli. The tip is
// positioned absolutely by the stylesheet, so it is out of flow and cannot
// change the strip's line box; the anchor is an inline flex box exactly as tall
// as the control it wraps. No length is written here.

export interface TooltipSpec {
  /** The control the tip describes. Escape listens on the document only while
   *  the tip is shown, and is removed on hiding or destruction. */
  control: HTMLElement;
  /** What the control is called -- the same catalog string its `aria-label`
   *  carries, so the two cannot say different things. */
  name: string;
  /** A second line, when the control owes the writer more than its name.
   *  Underline does: Markdown cannot carry it and the export drops it. */
  hint: string | null;
}

export interface Tooltip {
  /** What goes in the strip: the control, wrapped, with its tip beside it. */
  readonly anchor: HTMLElement;
  /** The tip itself. Exposed so a test can read it; nothing else needs it. */
  readonly tip: HTMLElement;
  /** Rename the tip in place. A control whose name follows its state (the
   *  status dot) renames rather than rebuilds: rebuilding would move the
   *  control between anchors on every state change. */
  setName(name: string): void;
  destroy(): void;
}

export function createTooltip(spec: TooltipSpec): Tooltip {
  const { control } = spec;

  const anchor = document.createElement("span");
  anchor.className = "tip-anchor";

  const tip = document.createElement("span");
  tip.className = "tip";
  tip.hidden = true;
  tip.setAttribute("aria-hidden", "true");

  const nameLine = document.createElement("span");
  nameLine.className = "tip-name";
  nameLine.textContent = spec.name;
  tip.append(nameLine);
  if (spec.hint !== null) {
    const hintLine = document.createElement("span");
    hintLine.className = "tip-hint";
    hintLine.textContent = spec.hint;
    tip.append(hintLine);
  }

  anchor.append(control);

  // ATTACHED ONLY WHILE SHOWN, and a measurement is why. Left in the resting
  // DOM -- `hidden`, so painting nothing and laying out nothing -- the three
  // tips still cost `outline-cli` about 2.5 ms on its mutation p95 (29-30 ms
  // before this slice, 33 ms with them mounted, 30.9 ms with the icons alone).
  // That is a per-structural-mutation cost for six elements a writer sees only
  // while the pointer is on a control. Single-variable runs against the
  // pre-slice build in the same session are what separated the two; the icons
  // themselves cost nothing measurable.
  let focused = false;
  let hovered = false;
  let listening = false;
  const show = (): void => {
    tip.hidden = false;
    if (tip.parentNode === null) anchor.append(tip);
    if (!listening) {
      document.addEventListener("keydown", onKeyDown, true);
      listening = true;
    }
  };
  const hide = (): void => {
    tip.hidden = true;
    tip.remove();
    if (listening) {
      document.removeEventListener("keydown", onKeyDown, true);
      listening = false;
    }
  };
  const enter = (): void => { hovered = true; show(); };
  const leave = (event: MouseEvent): void => {
    if (event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget)) return;
    hovered = false;
    if (!focused) hide();
  };
  const focus = (): void => { focused = true; show(); };
  const blur = (): void => { focused = false; if (!hovered) hide(); };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (isCompositionKey(event)) return;
    if (event.key === "Escape" && !tip.hidden) {
      hide();
      // The expanded control also owns the Escape that dismisses its popup.
      if (event.target instanceof Node && control.contains(event.target) && control.getAttribute("aria-expanded") === "true") return;
      event.preventDefault();
      event.stopPropagation();
    }
  };

  control.addEventListener("mouseenter", enter);
  control.addEventListener("mouseleave", leave);
  tip.addEventListener("mouseenter", enter);
  tip.addEventListener("mouseleave", leave);
  control.addEventListener("focus", focus);
  control.addEventListener("blur", blur);

  return {
    anchor,
    tip,
    setName(name: string): void {
      nameLine.textContent = name;
    },
    destroy(): void {
      control.removeEventListener("mouseenter", enter);
      control.removeEventListener("mouseleave", leave);
      tip.removeEventListener("mouseenter", enter);
      tip.removeEventListener("mouseleave", leave);
      control.removeEventListener("focus", focus);
      control.removeEventListener("blur", blur);
      hide();
    },
  };
}
