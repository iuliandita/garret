// app/ui/src/side-layout.ts
// ONE RULE FOR WHAT A SIDE SURFACE LEAVES THE PROSE. The inspector and the
// preview rail share the third column, and the prose pane gets what is left.
// The answer comes from that remaining width in CSS pixels, so interface zoom
// and a dragged rail are already in it; a breakpoint alone could not see either.
//
//   beside  the surface docks and the prose reflows beside it.
//   yield   the navigator steps aside while the surface is open, because with
//           it the pane would fall below a readable measure.
//   full    not even that fits: the surface takes the whole workspace and the
//           prose under it is inert, instead of showing lines cut at its edge.
//
// THE YIELD IS NOT THE WRITER'S CHOICE and is never recorded as one:
// chrome-toggles keeps the writer's navigator state and only paints the yield
// over it. Pressing the toggle during a yield keeps the navigator for the rest
// of that open; the surface, and any draft in it, stays.

/** `--nav-width`; the column the navigator takes when it is not an overlay. */
export const NAV_COLUMN_WIDTH = 320;
/** `#inspector-dock .panel-shell`'s width. */
export const INSPECTOR_WIDTH = 360;
/** The narrowest prose pane that still sets whole sentences on a line. */
export const MIN_PROSE_PANE = 440;

export type SideLayout = "beside" | "yield" | "full";

export interface SideLayoutInput {
  windowWidth: number;
  /** The open surface's width; 0 when none is open. */
  sideWidth: number;
  /** The navigator would take its column (not hidden, not a narrow overlay). */
  navColumn: boolean;
  /** The writer reopened the navigator during this open. */
  navKept: boolean;
}

export function decideSideLayout(input: SideLayoutInput): SideLayout {
  if (input.sideWidth <= 0) return "beside";
  if (input.windowWidth - input.sideWidth < MIN_PROSE_PANE) return "full";
  if (
    input.navColumn &&
    !input.navKept &&
    input.windowWidth - NAV_COLUMN_WIDTH - input.sideWidth < MIN_PROSE_PANE
  ) return "yield";
  return "beside";
}

export type SideSurface = "inspector" | "rail";

/** The work surfaces a full-width side surface covers. */
const COVERED = ["editor", "outline-view"];

const open = new Map<SideSurface, number>();
const listeners = new Set<() => void>();
let navColumn = true;
let navKept = false;
let layout: SideLayout = "beside";
let coveredScroll: number | null = null;
let resizeBound = false;

const onResize = (): void => apply();

function bindResize(want: boolean): void {
  if (typeof window === "undefined" || want === resizeBound) return;
  resizeBound = want;
  if (want) window.addEventListener("resize", onResize);
  else window.removeEventListener("resize", onResize);
}

function cover(doc: Document): void {
  coveredScroll = doc.getElementById("editor")?.scrollTop ?? null;
  for (const id of COVERED) doc.getElementById(id)?.toggleAttribute("inert", true);
}

/** Gives the prose back. Its scroll is restored; the keyboard returns to the
 *  caret only when the close left it nowhere (a focus target that was inert a
 *  moment ago refuses focus), never over somewhere the writer has moved to. */
function uncover(doc: Document): void {
  for (const id of COVERED) doc.getElementById(id)?.removeAttribute("inert");
  const editor = doc.getElementById("editor");
  if (editor !== null && coveredScroll !== null) editor.scrollTop = coveredScroll;
  coveredScroll = null;
  const active = doc.activeElement;
  const lost = active === null || active === doc.body || !active.isConnected || active.closest("[hidden]") !== null;
  if (!lost || editor === null || editor.hidden) return;
  editor.querySelector<HTMLElement>("[contenteditable='true']")?.focus();
}

function apply(): void {
  if (open.size === 0) navKept = false;
  bindResize(open.size > 0);
  if (typeof document === "undefined" || document.body === null) return;
  const next = decideSideLayout({
    windowWidth: typeof window === "undefined" ? 0 : window.innerWidth,
    sideWidth: Math.max(0, ...open.values()),
    navColumn,
    navKept,
  });
  if (next === layout) return;
  const was = layout;
  layout = next;
  if (next === "full") cover(document);
  else if (was === "full") uncover(document);
  if (next === "beside") delete document.body.dataset.sideLayout;
  else document.body.dataset.sideLayout = next;
  for (const listener of listeners) listener();
}

/** A surface opened, resized (`width`) or closed (`null`). */
export function reportSide(surface: SideSurface, width: number | null): void {
  if (width === null) open.delete(surface);
  else open.set(surface, width);
  apply();
}

/** chrome-toggles: whether the navigator would take its column right now. */
export function setNavColumn(shown: boolean): void {
  navColumn = shown;
  apply();
}

/** chrome-toggles: the writer pressed the toggle during a yield. */
export function keepNav(): void {
  navKept = true;
  apply();
}

export function navYielded(): boolean {
  return layout === "yield";
}

export function onSideLayout(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
