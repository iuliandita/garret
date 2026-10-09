import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { MenuBarDeps } from "../../src/menu-bar";

GlobalRegistrator.register();
(window as Window & typeof globalThis & { __appLocale?: string }).__appLocale = "de";

const { createMenuBar } = await import("../../src/menu-bar");

const container = document.createElement("span");
document.body.append(container);

const deps = {
  showManuscript: () => undefined,
  showOutlineTable: () => undefined,
  showOutlineCards: () => undefined,
  showReadThrough: () => undefined,
  showContinuousChapter: () => undefined,
  openReference: () => undefined,
  closeReference: () => undefined,
  outlineViewMode: () => "manuscript" as const,
  container,
  openProjects: () => undefined,
  exportProject: () => undefined,
  exportAs: () => undefined,
  exportDocx: () => undefined,
  openEpubPreview: () => undefined,
  openPdfPreview: () => undefined,
  backupNow: () => undefined,
  importProject: () => undefined,
  openLibrary: () => undefined,
  openPreferences: () => undefined,
  renameProject: () => undefined,
  openFind: () => undefined,
  openQuickOpen: () => undefined,
  openReplace: () => undefined,
  openHistory: () => undefined,
  openMirrorChanges: () => undefined,
  openComments: () => undefined,
  addComment: () => undefined,
  addToDictionary: () => undefined,
  navBack: () => undefined,
  navForward: () => undefined,
  canNavBack: () => true,
  canNavForward: () => true,
  undo: () => undefined,
  redo: () => undefined,
  outlineUndo: () => undefined,
  outlineRedo: () => undefined,
  outlineUndoLabel: () => null,
  outlineRedoLabel: () => null,
  create: () => undefined,
  createNote: () => undefined,
  createBibleFolder: () => undefined,
  createTimeline: () => undefined,
  createMatter: () => undefined,
  move: () => undefined,
  beginRename: () => undefined,
  removeOrRestore: () => undefined,
  selectedTrashed: () => false,
  openStatistics: () => undefined,
  openAnalytics: () => undefined,
  openRevisionState: () => undefined,
  openReviewProposals: () => undefined,
  openSynopsis: () => undefined,
  openCast: () => undefined,
  openAppearances: () => undefined,
  openAppearancesMap: () => undefined,
  openBookDesign: () => undefined,
  openCovers: () => undefined,
  openIdentities: () => undefined,
  openHelp: () => undefined,
  quit: () => undefined,
} satisfies MenuBarDeps;

const bar = createMenuBar(deps);

function expect(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

function press(key: string): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, altKey: true, bubbles: true, cancelable: true }));
}

try {
  const panel = container.querySelector<HTMLElement>("#menu-panel");
  if (panel === null) throw new Error("missing menu panel");
  expect(panel.hidden, true, "menu begins hidden");

  for (const [key, titleId, title, firstItemId, firstItem] of [
    // These literal German labels and chords are product oracles: deriving
    // them from the catalog would let a copied English catalog pass.
    ["d", "menu-file", "Datei", "menu-project-new", "Neues Buch…"],
    ["b", "menu-edit", "Bearbeiten", "menu-undo", "Rückgängig"],
    ["g", "menu-outline", "Gliederung", "menu-new", "Neu…"],
    ["h", "menu-help", "Hilfe", "menu-shortcuts", "Anleitung und Tastenkürzel"],
  ] as const) {
    press(key);
    const menuTitle = container.querySelector<HTMLButtonElement>(`#${titleId}`);
    const firstItemElement = panel.querySelector<HTMLButtonElement>("[role='menuitem']");
    const firstItemLabel = firstItemElement?.querySelector<HTMLElement>(".menu-item-label");
    expect(panel.hidden, false, `Alt+${key.toUpperCase()} opens ${title}`);
    expect(menuTitle?.textContent, title, `${title} title is localized`);
    expect(menuTitle?.getAttribute("aria-expanded"), "true", `${title} is selected`);
    expect(panel.getAttribute("aria-label"), title, `${title} labels its menu`);
    expect(document.activeElement?.id, firstItemId, `${title} enters its first item`);
    expect(firstItemElement?.getAttribute("role"), "menuitem", `${title} exposes a menuitem`);
    expect(firstItemLabel?.textContent, firstItem, `${title} has its own localized first item`);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(panel.hidden, true, `Escape closes ${title}`);
    expect(menuTitle?.getAttribute("aria-expanded"), "false", `${title} is unselected after Escape`);
  }

  for (const key of ["f", "e", "o"] as const) {
    press(key);
    expect(panel.hidden, true, `English Alt+${key.toUpperCase()} opens no German menu`);
  }

  console.log(JSON.stringify({ ok: true, locale: "de", chords: ["Alt+D", "Alt+B", "Alt+G", "Alt+H"] }));
} finally {
  bar.destroy();
  container.remove();
  await GlobalRegistrator.unregister();
}
