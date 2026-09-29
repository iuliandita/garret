// app/ui/src/inspector.ts
// THE INSPECTOR: the panels that are ABOUT the manuscript and are worked
// beside it (comments, synopsis, cast, appearances, history, review, craft,
// statistics) sit in the third grid column, where the preview rail lives,
// instead of hanging over the prose from the header. AMENDS "a panel covers
// the prose it is about" (calm-panels record).
//
// THE COLUMN IS THE STYLESHEET'S. Each docked panel is itself the grid item
// (its anchors are `display: contents`, the rail's shape), so a visible panel
// takes its 360px and a hidden one takes nothing, synchronously, with no
// script in between: a panel focuses itself the moment it is shown, and a
// width that arrived a microtask later would have been a panel focused while
// it had no box.
//
// WHAT THIS UNIT OWNS is the rest of the rule, which no stylesheet can say:
// one inspector at a time, the rails and the inspector sharing the column,
// `data-inspector-open` on <body> for the rules that move with it, and F6.
// It HEARS an open rather than being told: every docked panel opens by
// removing its own `hidden`, eight units with eight open paths, and an
// observer on that one attribute is one place instead of eight call sites
// that a ninth panel would forget.
//
// A REPLACEMENT IS NOT A DISMISSAL. Opening another inspector, or a rail,
// closes the one showing through its `replace`, which never moves focus: the
// writer is on their way somewhere, and a returnFocus here would take the
// keyboard back to the prose from the panel they just opened. A panel holding
// unsaved work (review's drafts) refuses; its own close then asks its leave
// question and the newcomer stands down.
import { isCompositionKey } from "./composition-key";

export interface InspectorHost {
  /** Closes the preview and reference rails: the column is one column. */
  closeRails(): void;
  /** Where F6 takes the keyboard from inside the inspector. */
  focusProse(): void;
}

interface Docked {
  panel: HTMLElement;
  close(): void;
  replace(): boolean;
  open: boolean;
  observer: MutationObserver | null;
}

const docked = new Set<Docked>();
let host: InspectorHost | null = null;

function sync(doc: Document): void {
  if (doc.body === null) return;
  if ([...docked].some((entry) => entry.open)) doc.body.dataset.inspectorOpen = "true";
  else delete doc.body.dataset.inspectorOpen;
}

function opened(entry: Docked): void {
  const doc = entry.panel.ownerDocument;
  const keep = doc.activeElement;
  for (const other of docked) {
    if (other === entry || !other.open) continue;
    if (other.replace()) {
      other.open = false;
      continue;
    }
    // REFUSED: the one showing holds work a replacement would throw away.
    // The newcomer goes, and the holder asks its own question.
    entry.close();
    entry.open = false;
    other.close();
    sync(doc);
    return;
  }
  host?.closeRails();
  // A unit that closed focused something of its own; the newcomer keeps the
  // keyboard it took when it opened.
  if (keep instanceof HTMLElement && entry.panel.contains(keep) && doc.activeElement !== keep) keep.focus();
  sync(doc);
}

/** Docks `panel` as an inspector. Returns the undock, which the shell calls
 *  from its own destroy. */
export function dockInspector(
  panel: HTMLElement,
  options: { close(): void; replace?: () => boolean },
): () => void {
  const entry: Docked = {
    panel,
    close: options.close,
    replace: options.replace ?? ((): boolean => {
      options.close();
      return true;
    }),
    open: !panel.hidden,
    observer: null,
  };
  docked.add(entry);
  if (typeof MutationObserver !== "undefined") {
    entry.observer = new MutationObserver(() => {
      const now = !panel.hidden;
      if (now === entry.open) return;
      entry.open = now;
      if (now) opened(entry);
      else sync(panel.ownerDocument);
    });
    entry.observer.observe(panel, { attributes: true, attributeFilter: ["hidden"] });
  }
  return () => {
    entry.observer?.disconnect();
    docked.delete(entry);
    sync(panel.ownerDocument);
  };
}

/** Clears the column for a rail. False when an inspector refused (it is
 *  asking its leave question), and the rail should not open. */
export function yieldInspector(): boolean {
  for (const entry of docked) {
    if (!entry.open) continue;
    if (!entry.replace()) {
      entry.close();
      return false;
    }
    entry.open = false;
    sync(entry.panel.ownerDocument);
  }
  return true;
}

/** The open inspector's panel, or null. */
export function openInspector(): HTMLElement | null {
  for (const entry of docked) if (entry.open && !entry.panel.hidden) return entry.panel;
  return null;
}

/** Installs the project's half: its rails and its prose. Returns the
 *  uninstall, which the project calls on teardown. */
export function setInspectorHost(next: InspectorHost, doc: Document = document): () => void {
  host = next;
  // F6 MOVES BETWEEN THE PROSE AND THE INSPECTOR, the pane-cycling key
  // desktop applications share. Nothing else in the page binds it, and it
  // does nothing (and is not consumed) when no inspector is open.
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "F6" || isCompositionKey(event)) return;
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    const panel = openInspector();
    if (panel === null) return;
    event.preventDefault();
    const active = doc.activeElement;
    if (active instanceof Node && panel.contains(active)) next.focusProse();
    else panel.focus();
  };
  doc.addEventListener("keydown", onKeyDown);
  return () => {
    doc.removeEventListener("keydown", onKeyDown);
    if (host === next) host = null;
  };
}
