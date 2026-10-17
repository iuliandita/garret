// app/ui/src/preview-rail-layout.ts
// The rail's width and the paging arithmetic, out of `preview-rail.ts` where a
// mutation can reach them and a test needs no DOM.
//
// THE WIDTH IS A PREFERENCE, NOT A MEASUREMENT. What is kept is what the writer
// asked for (a pixel width, or "half the window"); what is applied is that
// request clamped against the window as it is NOW, so a width chosen on a large
// monitor does not swallow the prose after the window shrinks, and the
// request itself survives to the next large window.

/** The rail has always been this wide; it is also the smallest it may be. */
export const RAIL_MIN_WIDTH = 420;
/** At or below this the rail is a fixed overlay (style.css) and has no divider. */
export const OVERLAY_MAX_WINDOW = 900;
/** The half-window snap needs room for the navigator and a readable column. */
export const HALF_MIN_WINDOW = 1200;
export const KEY_STEP = 24;
export const KEY_STEP_LARGE = 96;
/** A drag released this close to half the window lands on it. */
export const SNAP_RADIUS = 28;

export type RailPref = { readonly kind: "half" } | { readonly kind: "width"; readonly px: number };

export const isOverlay = (windowWidth: number): boolean => windowWidth <= OVERLAY_MAX_WINDOW;
export const canSnapHalf = (windowWidth: number): boolean => windowWidth >= HALF_MIN_WINDOW;
export const halfWidth = (windowWidth: number): number => Math.floor(windowWidth / 2);

/** About half the window, never below the minimum. */
export function maxWidth(windowWidth: number): number {
  return Math.max(RAIL_MIN_WIDTH, halfWidth(windowWidth));
}

export function clampWidth(px: number, windowWidth: number): number {
  if (!Number.isFinite(px)) return RAIL_MIN_WIDTH;
  return Math.min(maxWidth(windowWidth), Math.max(RAIL_MIN_WIDTH, Math.round(px)));
}

/** The width a drag ends on: clamped, and pulled onto half the window when it
 *  is within reach and the window is wide enough to offer that. */
export function snapWidth(px: number, windowWidth: number): number {
  const clamped = clampWidth(px, windowWidth);
  if (!canSnapHalf(windowWidth)) return clamped;
  return Math.abs(clamped - halfWidth(windowWidth)) <= SNAP_RADIUS
    ? halfWidth(windowWidth)
    : clamped;
}

export function resolveWidth(pref: RailPref | null, windowWidth: number): number {
  if (pref === null) return RAIL_MIN_WIDTH;
  return clampWidth(pref.kind === "half" ? halfWidth(windowWidth) : pref.px, windowWidth);
}

/** What a key does to the width. Left widens: the divider is the rail's left
 *  edge and moves left. Null for a key that is not the divider's. */
export function keyWidth(key: string, current: number, large: boolean, windowWidth: number): number | null {
  const step = large ? KEY_STEP_LARGE : KEY_STEP;
  switch (key) {
    case "ArrowLeft":
      return clampWidth(current + step, windowWidth);
    case "ArrowRight":
      return clampWidth(current - step, windowWidth);
    case "Home":
      return RAIL_MIN_WIDTH;
    case "End":
      return maxWidth(windowWidth);
    default:
      return null;
  }
}

const HALF_TOKEN = "half";

export function parsePref(raw: string | null): RailPref | null {
  if (raw === null) return null;
  if (raw === HALF_TOKEN) return { kind: "half" };
  if (!/^\d{1,5}$/.test(raw)) return null;
  const px = Number(raw);
  return px >= RAIL_MIN_WIDTH ? { kind: "width", px } : null;
}

export const serializePref = (pref: RailPref): string =>
  pref.kind === "half" ? HALF_TOKEN : String(pref.px);

/** Device-local storage, which can be absent or refuse a write (a locked-down
 *  webview, a full quota). The preference then lasts for the session only,
 *  which is the right degradation for a width, so neither direction throws. */
export type DeviceStorage = Pick<Storage, "getItem" | "setItem">;

export function defaultStorage(): DeviceStorage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function readDevice(storage: DeviceStorage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeDevice(storage: DeviceStorage | null, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // Session-only, see DeviceStorage.
  }
}

/** How many pages a column-laid-out box holds: its scrollable width over one
 *  page's width. A fraction of a pixel of rounding is not a page. */
export function pageCount(scrollWidth: number, pageWidth: number): number {
  if (!(pageWidth > 0) || !(scrollWidth > 0)) return 1;
  return Math.max(1, Math.ceil((scrollWidth - 1) / pageWidth));
}

export function clampPage(page: number, count: number): number {
  if (!Number.isFinite(page)) return 0;
  return Math.min(Math.max(0, count - 1), Math.max(0, Math.trunc(page)));
}
