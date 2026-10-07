// app/ui/src/empty-project.ts
// The empty workspace: what the page shows
// when `__appProject` is the empty string -- the window opened with no book,
// under `settings.start` "home" or "blank". The same shell as a mounted
// project (header, navigator column, editor, footer), holding nothing.
//
// EVERY `MenuProjectActions` ARM IS WRITTEN OUT, deliberately, not a Proxy: a
// new action added to that interface without an arm here fails to compile,
// which is the guarantee `mountProject`'s own object gives by being written
// the same way. Every arm calls `refuse()`, raising ONE catalog notice
// (`library.nothing-open`) through the SAME banner surface `project.ts` uses
// (banner.ts, extracted from it in this slice for exactly this reuse) into
// the SAME container (`document.body`), so a switch from empty to a book
// tears one surface down through one `destroy()` rather than two that happen
// to look alike.
import { t } from "./i18n";
import { createBanner } from "./banner";
import type { ActiveMarks, Editor, SelectionBox } from "./editor";
import type { CommentAnchor } from "./comments";
import type { CastNamePair } from "./cast-marks";
import type { ManuscriptNavigator, TreeSource } from "./navigator/index";
import type { VisibleRow } from "./navigator/visible";
import type { FixtureSource } from "./fixture/source";
import type { MenuProjectActions, MountedProject } from "./project";
import type { DailyTarget } from "./goals";

export interface EmptyProjectDeps {
  /** Open the switcher on the list. `menu-library`, the workspace's own "Open
   *  the library" button and the library screen's own routes all reach
   *  through this one thunk rather than the `Switcher` itself: `mountEmpty`
   *  runs BEFORE `main.ts` builds the switcher (the first mount happens
   *  before the application-chrome block that constructs it), so this is
   *  called only once whatever it is bound to by main.ts is ready. */
  openLibrary(): void;
}

/** No manuscript has ever produced a row, so nothing here needs a real
 *  document, a real tree or a real ProseMirror view: `MenuProjectActions`'
 *  own comment is the rule for this whole module -- "a menu item that threw
 *  during assembly would turn a measurement run into a page error", stated
 *  again for the fields `main.ts` still destructures out of the FIRST mount
 *  regardless of whether one exists (`source`, `navigator`, `editor`, and the
 *  rest of `MountedProject`). Those fields are read in `main.ts`'s SOAK
 *  branch, which a no-project boot can never reach in practice (`APP_RUN`
 *  defaults to "interactive" and every graded rig that drives a soak sets
 *  `APP_PROJECT`) but which the compiler still type-checks unconditionally,
 *  so `MountedProject.editor` and `.navigator` cannot be narrowed here to
 *  "the methods main.ts actually calls" without breaking that branch's own
 *  typing. Everything below is therefore a COMPLETE, inert implementation of
 *  both interfaces rather than a partial one -- not a fake ProseMirror view,
 *  since nothing here holds a document, a schema or a DOM mount. */
function inertNavigator(): ManuscriptNavigator {
  return {
    activeIndex: () => -1,
    activeTitle: () => "",
    setCounts: () => undefined,
    setSynopses: () => undefined,
    setAppearances: () => undefined,
    rows: (): readonly VisibleRow[] => [],
    handleKey: () => undefined,
    selectById: () => undefined,
    setOpen: () => undefined,
    activate: () => undefined,
    reload: (_next: TreeSource) => undefined,
    destroy: () => undefined,
  };
}

function inertEditor(): Editor {
  return {
    typeChar: () => undefined,
    splitParagraph: () => undefined,
    erasePrev: () => undefined,
    caretToParagraph: () => undefined,
    replaceDoc: () => undefined,
    setEditable: () => undefined,
    revealMatch: () => false,
    setCommentAnchors: (_anchors: readonly CommentAnchor[]) => undefined,
    setCastNames: (_names: readonly CastNamePair[]) => undefined,
    castMarkAtCaret: () => null,
    wordAtCaret: () => null,
    redrawSpelling: () => undefined,
    commentAnchors: (): readonly CommentAnchor[] => [],
    commentsCapped: () => false,
    textIn: () => "",
    selectRange: () => false,
    restoreSelection: () => undefined,
    selection: () => ({ from: 0, to: 0 }),
    selectionRect: (): SelectionBox | null => null,
    replaceMatch: () => false,
    replaceAll: () => ({ replaced: 0, spanning: 0 }),
    undo: () => undefined,
    redo: () => undefined,
    toggleBold: () => undefined,
    toggleItalic: () => undefined,
    toggleUnderline: () => undefined,
    activeMarks: (): ActiveMarks => ({ bold: false, italic: false, underline: false }),
    // The one method main.ts actually calls on an OPEN mount's `current.editor`
    // (`current.editor.focus()`, the switcher's and preferences' `onDismiss`).
    // Reachable here too, harmlessly: with nothing open there is nowhere for
    // focus to go, so it does nothing rather than throw.
    focus: () => undefined,
    serialize: () => "",
    wordCount: () => 0,
    setHidden: () => undefined,
    destroy: () => undefined,
  };
}

const emptySource: FixtureSource = {
  count: 0,
  seed: "empty",
  titleAt: () => "",
  idAt: () => "",
};

/** Mount the empty workspace into the shell `index.html` already has: the same
 *  elements a book uses, holding nothing. Looks its own elements up by id, the
 *  convention `mountProject` itself follows, rather than taking them as
 *  dependencies -- `openLibrary` is the only actual capability this needs. */
export function mountEmpty(deps: EmptyProjectDeps): MountedProject {
  const navHeader = document.getElementById("nav-header");
  const editorEl = document.getElementById("editor");
  if (navHeader === null || editorEl === null) {
    throw new Error("page shell is missing #nav-header or #editor: index.html and empty-project.ts disagree");
  }
  const sceneName = document.getElementById("scene-name");
  const sceneHeading = document.getElementById("scene-heading");
  if (sceneName !== null) {
    sceneName.textContent = "";
    sceneName.hidden = true;
  }
  if (sceneHeading !== null) sceneHeading.textContent = "";

  // `#nav-header[data-empty]` is style.css's own selector for the muted
  // reading of this sentence; there is no rename affordance to speak of here.
  navHeader.dataset.empty = "";
  const sentence = document.createElement("span");
  sentence.id = "empty-nav-sentence";
  sentence.textContent = t("library.no-book");
  navHeader.append(sentence);

  // Built INTO #editor, after #scene-heading, exactly as mountProject builds
  // and removes the ProseMirror mount there -- nothing here is positioned
  // (the rule for #editor's descendants).
  const workspace = document.createElement("div");
  workspace.id = "empty-workspace";
  const prompt = document.createElement("p");
  prompt.textContent = t("library.open-prompt");
  const openButton = document.createElement("button");
  openButton.type = "button";
  openButton.id = "empty-open-library";
  openButton.textContent = t("library.open");
  openButton.addEventListener("click", () => deps.openLibrary());
  workspace.append(prompt, openButton);
  editorEl.append(workspace);

  // The footer has nothing to report: no count, no goal, no save state, no
  // status dot. Hidden rather than emptied, so a switch to a book only has to
  // un-hide what a real mount already knows how to fill in.
  const footerIds = ["word-count", "goal-bar", "status-controls", "save-controls"];
  for (const id of footerIds) {
    const el = document.getElementById(id);
    if (el !== null) el.hidden = true;
  }

  const noticeBanner = createBanner();
  function refuse(): void {
    noticeBanner.raise("open-error", t("library.nothing-open"), "problem");
  }

  const menuActions: MenuProjectActions = {
    showManuscript: refuse,
    showOutlineTable: refuse,
    showOutlineCards: refuse,
    showReadThrough: refuse,
    showContinuousChapter: refuse,
    openReference: refuse,
    closeReference: refuse,
    outlineViewMode: () => "manuscript",
    exportProject: refuse,
    exportAs: refuse,
    exportDocx: refuse,
    backupNow: refuse,
    openFind: refuse,
    openQuickOpen: refuse,
    openReplace: refuse,
    openHistory: refuse,
    openMirrorChanges: refuse,
    openComments: refuse,
    addComment: refuse,
    addToDictionary: refuse,
    openStatistics: refuse,
    openAnalytics: refuse,
    openRevisionState: refuse,
    openReviewProposals: refuse,
    openSynopsis: refuse,
    openCast: refuse,
    openKnowledge: refuse,
    openCraftReports: refuse,
    openBookDesign: refuse,
    openCovers: refuse,
    openIdentities: refuse,
    openEpubPreview: refuse,
    openPdfPreview: refuse,
    openAppearances: refuse,
    openAppearancesMap: refuse,
    navBack: refuse,
    navForward: refuse,
    canNavBack: () => false,
    canNavForward: () => false,
    undo: refuse,
    redo: refuse,
    outlineUndo: refuse,
    outlineRedo: refuse,
    // `null` is exactly what a mounted project with nothing to undo already
    // answers (`outline?.undoLabel() ?? null` in project.ts), so the menu's
    // own label function paints the same "nothing to undo" catalog string
    // without this module naming it a second time.
    outlineUndoLabel: () => null,
    outlineRedoLabel: () => null,
    openCreation: refuse,
    create: () => refuse(),
    createNote: refuse,
    createBibleFolder: refuse,
    createTimeline: refuse,
    createMatter: () => refuse(),
    move: () => refuse(),
    beginRename: refuse,
    removeOrRestore: refuse,
    selectedTrashed: () => false,
  };

  return {
    navigator: inertNavigator(),
    editor: inertEditor(),
    session: null,
    outline: null,
    source: emptySource,
    storeItems: null,
    activeDocId: null,
    activeDocRev: 0,
    loadedBodyHash: "",
    flusher: null,
    raiseFailure: (message: string) => noticeBanner.raise("persist-error", message, "failure"),
    raiseNotice: (message: string) => noticeBanner.raise("open-error", message, "problem"),
    announce: (message: string) => noticeBanner.raise("open-error", message, "success"),
    // The preferences panel calls this through `current` on every goal change
    // regardless of what is open (main.ts's `onDailyTarget`); there is
    // nothing here to repaint.
    setDailyTarget: (_target: DailyTarget) => undefined,
    setMarkCastNames: () => undefined,
    persistError: () => null,
    reviewPending: () => false,
    reviewPrivacyChanged: () => undefined,
    prepareToLeave: async () => true,
    cancelLeave: () => undefined,
    menuActions,
    destroy(): void {
      navHeader.removeAttribute("data-empty");
      sentence.remove();
      workspace.remove();
      for (const id of footerIds) {
        const el = document.getElementById(id);
        if (el !== null) el.hidden = false;
      }
      noticeBanner.destroy(["persist-error", "open-error"]);
    },
  };
}
