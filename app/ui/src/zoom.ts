import { isCompositionKey } from "./composition-key";
// app/ui/src/zoom.ts
// Interface zoom. The HOST applies it as WebKit page zoom and records it in
// settings.json; this unit owns the five words, the shortcuts, and nothing
// else. It never touches `document.body.style.zoom` or a transform: either
// would move every extent the rigs read and every compositing layer the
// stylesheet argues for. Page zoom leaves the CSS pixel grid alone.

export const ZOOMS = ["100", "125", "150", "175", "200"] as const;
export type Zoom = (typeof ZOOMS)[number];
export const DEFAULT_ZOOM: Zoom = "100";

export function isZoom(value: unknown): value is Zoom {
  return typeof value === "string" && (ZOOMS as readonly string[]).includes(value);
}

/** Narrow what the host injected. Lenient like every other preference: a bad
 *  word is the default, not an error, because `read_settings` already made
 *  the same choice for the whole file. */
export function zoomFrom(raw: unknown): Zoom {
  return isZoom(raw) ? raw : DEFAULT_ZOOM;
}

/** One step in or out, clamped. Wrapping from 200 to 100 is a surprise. */
export function stepZoom(current: Zoom, direction: 1 | -1): Zoom {
  const at = ZOOMS.indexOf(current);
  const next = Math.min(ZOOMS.length - 1, Math.max(0, at + direction));
  return ZOOMS[next];
}

export interface ZoomPersistence {
  current: () => Zoom;
  request: (next: Zoom) => Promise<void>;
}

/** Panel and keyboard share one ordered stream of host writes. Only the
 *  latest request may restore the last value the host actually accepted. */
export function createZoomPersistence(
  initial: Zoom,
  persist: (next: Zoom) => Promise<void>,
  onChange: (next: Zoom) => void,
): ZoomPersistence {
  let current = initial;
  let confirmed = initial;
  let generation = 0;
  let pending = Promise.resolve();
  return {
    current: () => current,
    request(next) {
      const request = ++generation;
      current = next;
      onChange(next);
      const save = pending.then(async () => {
        try {
          await persist(next);
          confirmed = next;
        } catch (error: unknown) {
          if (request === generation) {
            current = confirmed;
            onChange(confirmed);
          }
          throw error;
        }
      });
      pending = save.catch(() => {});
      return save;
    },
  };
}

export type ZoomAction = "in" | "out" | "reset";

/** Ctrl+= (and Ctrl+Shift+= which arrives as "+"), Ctrl+-, Ctrl+0. Alt or
 *  Meta held means some other chord. */
export function zoomActionFor(event: KeyboardEvent): ZoomAction | null {
  if (isCompositionKey(event)) return null;
  if (!event.ctrlKey || event.altKey || event.metaKey) return null;
  switch (event.key) {
    case "=":
    case "+":
      return "in";
    case "-":
      return "out";
    case "0":
      return "reset";
    default:
      return null;
  }
}

export interface ZoomKeysDeps {
  current: () => Zoom;
  /** Called only when the zoom actually changes. */
  set: (zoom: Zoom) => void;
}

/** On the DOCUMENT, like the menu bar's Alt chords: the writer is in the
 *  editor and a zoom you can only change from a panel is a zoom with a
 *  prerequisite. Returns the uninstaller. */
export function installZoomKeys(target: Document, deps: ZoomKeysDeps): () => void {
  const onKey = (event: Event): void => {
    if (!(event instanceof KeyboardEvent) || isCompositionKey(event)) return;
    const action = zoomActionFor(event);
    if (action === null) return;
    // Still consumed on repeat: it is the writer's chord and nothing else on
    // the page should see it. But not stepped again - a HELD Ctrl+= is one
    // intention ("bigger"), not one host write per autorepeat tick, which is
    // what a held key otherwise fires at OS repeat rate.
    event.preventDefault();
    if (event.repeat) return;
    const now = deps.current();
    const next =
      action === "reset" ? DEFAULT_ZOOM : stepZoom(now, action === "in" ? 1 : -1);
    if (next !== now) deps.set(next);
  };
  target.addEventListener("keydown", onKey);
  return () => target.removeEventListener("keydown", onKey);
}
