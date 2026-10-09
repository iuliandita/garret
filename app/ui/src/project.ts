// app/ui/src/project.ts
// Page assembly for one open project: source, navigator, editor, failure
// surface, flush scheduler, session and opener. Extracted from main.ts because
// main.ts ends in `void main()` at module scope and so cannot be imported by a
// test, and because project switching needs the assembly to be a callable unit
// with a teardown.
//
// Nothing here reads `window`: a unit that reads globals is a unit no test can
// drive. Everything the assembly needs arrives through MountDeps.
import { createCreationChooser } from "./creation-chooser";
import { createBibleCreateControl } from "./bible-create-control";
import { bibleParentFor } from "./bible-rows";
import { isCompositionKey } from "./composition-key";
import { formatNumber, plural, t } from "./i18n";
import { createBanner, type Tone } from "./banner";
import { HostCommandError } from "./command-error";
import { createEditor, type DocInput, type Editor, readableBody, bodyText } from "./editor";
import type { FixtureSource } from "./fixture/source";
import { createNavigator, type ManuscriptNavigator } from "./navigator/index";
import { createFlushScheduler, type FlushScheduler } from "./store/flush";
import { loadStoreSource, storeSourceFrom, type ProjectItem } from "./store/source";
import { bodyHash } from "./store/hash";
import { createDocumentOpener, isOpenableType } from "./open";
import { createOutlineView, createOutlineViewTransitions, type OutlineView, type OutlineViewMode, type OutlineViewTransitions } from "./outline-view";
import { createContinuousChapter, type ContinuousChapter } from "./continuous-chapter";
import { createSession, type Session } from "./session";
import { BIBLE_TYPE, TIMELINE_TYPE } from "./item-types";
import { mountTimeline, type TimelineMount } from "./timeline-view";
import { parseTimeline } from "./timeline-model";
import {
  createOutline,
  isTrashedIn,
  liveItemsIn,
  readingOrderItems,
  type MatterKind,
  type MoveDirection,
  type Outline,
  type OutlineOutcome,
} from "./outline";
import { createRenamePanel, type RenamePanel } from "./rename-panel";
import { createSectionMovePrompt } from "./section-move-prompt";
import { createQuickOpen, type QuickOpen } from "./quick-open";
import { createNavHistory, historyChordOf } from "./nav-history";
import { createHistory, type History, type SnapshotRow, type VersionRow } from "./history";
import {
  createMirrorChanges,
  type MirrorAcceptOutcome,
  type MirrorChangeRow,
  type MirrorChanges,
  type MirrorUndoHandle,
} from "./mirror-changes";
import { createSessionWords, type SessionWords } from "./statistics";
import { createStatisticsPanel, type StatisticsPanel } from "./statistics-panel";
import { createAnalyticsWorkspace, type AnalyticsWorkspace } from "./analytics-workspace";
import type { TodayFigures, SourceWordSummary } from "./statistics";
import type { SidebarWordCounts } from "./sidebar-word-counts";
import { countWords } from "./words";
import { createWritingTime, type TimeTracking } from "./writing-time";
import {
  createStatisticsExport,
  type StatisticsExport,
  type StatisticsWritten,
} from "./statistics-export";
import { createRevisionPanel, type RevisionPanel, type RevisionPassRow, type RevisionTaskRow } from "./revision-panel";
import { createReviewPanel, type ReviewPanel } from "./review-panel";
import { setInspectorHost, yieldInspector } from "./inspector";
import type { ReviewAuthor, ReviewDecision, ReviewGroup, ReviewMessage, ReviewState } from "./review-types";
import type { ReviewHunk } from "./review-fragments";
import { ReviewAppliedViewError, ReviewBusyError, type ReviewExportPreview, type ReviewReturnPreview, type ReviewReturnRequest } from "./review-transport-panel";
import { createSynopsisPanel, type SynopsisPanel } from "./synopsis-panel";
import {
  createCastPanel,
  type CastMemberRow,
  type CastPanel,
  type PictureView,
} from "./cast-panel";
import { createAppearancesPanel, type AppearancesPanel } from "./appearances-panel";
import { createAppearancesMap, type AppearancesMap } from "./appearances-map";
import type { ItemAppearances } from "./appearances";
import { createNavContextMenu, type NavContextMenu } from "./nav-context-menu";
import { createCommentsPanel, type CommentsPanel } from "./comments-panel";
import { type CommentRow, flushAnchorsFor, isAddCommentChord } from "./comments";
import { createSceneNotes, type SceneNotes } from "./scene-notes";
import { castNamesFor } from "./cast-marks";
import { createCastCard, isShowCastCardChord, type CastCard } from "./cast-card";
import { rollUpCounts, type DocumentCounts, type DocumentStatisticsCounts } from "./outline-counts";
import { createStatusDot, type StatusDot } from "./status-dot";
import { createTooltip } from "./tooltip";
import { createWordCount, type WordCountView } from "./word-count";
import { DEFAULT_DAILY_TARGET, localDate, type DailyTarget } from "./goals";
import { createExportBar, type ExportBar, type ExportWritten } from "./export-bar";
import { createDesignPanel, type DesignPanel, type DesignTransferPreview } from "./design-panel";
import { createCoversPanel, type CoversPanel } from "./covers-panel";
import { createIdentityPanel, type IdentityPanel } from "./identity-panel";
import { createPreflightPanel, type PreflightPanel } from "./preflight-panel";
import { createPreviewRail, type PreviewRail } from "./preview-rail";
import { createReferenceRail, type ReferenceRail } from "./reference-rail";
import { createCraftPanel, type CraftPanel } from "./craft-panel";
import type { ChapterStyle, ChapterStyleView, EpubPreview, PdfPreview } from "./preview";
import type { CoverPicture, CoversView } from "./covers";
import type { IdentitiesView, Identity, PinPreview, Preflight } from "./identity";
import { createPictureViewer, type PictureViewer } from "./picture-viewer";
import type { BookDesign, BookDesignView } from "./book-design";
import { createFormatBubble, type FormatBubble } from "./format-bubble";
import { createChromeFade, type ChromeFade } from "./chrome-fade";
import { createFindBar, type FindBar, type FindResults } from "./find-bar";
import { createSaveIndicator, type SaveIndicator } from "./save-indicator";
import {
  createArchiveIndicator,
  type Archive,
  type ArchiveIndicator,
  type ArchiveReport,
} from "./archive-indicator";
import {
  createMirrorIndicator,
  MIRROR_EVENT,
  type MirrorIndicator,
  type MirrorReport,
} from "./mirror-indicator";
import {
  createRecoveryIndicator,
  RECOVERY_EVENT,
  type RecoveryIndicator,
  type RecoveryReport,
} from "./recovery-indicator";

/** Restated in app/ui/style.css as the row's `line-height`, in
 *  nav-row-type.test.ts, and in switch-cli.ts and outline-cli.ts, which press at
 *  `BAR_HEIGHT + index * ROW_HEIGHT + ROW_HEIGHT / 2`. Raised from 20 to 24 by
 *  the visual redesign: 16px text in a 20px row fits only exactly, which is why
 *  the line-height had to be pinned to stop `overflow: hidden` cutting
 *  descenders. Every one of those restatements moved with it. */
const ROW_HEIGHT = 24;

/** How long after the last change the navigator's word counts are refreshed.
 *
 *  DEBOUNCED, and generously, because `project_word_counts` is O(documents) -
 *  it is a walk of the index the host already maintains, not a scan of the
 *  manuscript, but at the stress fixture that is a 15,200-entry map built,
 *  serialized to JSON, and parsed again. `project_word_count`, which the bar
 *  calls on every flush ack, is O(1); this one is not, and calling it at the
 *  same cadence would be per-second O(manuscript-structure) work behind a
 *  display element.
 *
 *  That is the shape of the recorded word-count regression rather than its
 *  size, and the reason to be careful about it is the same: `typing_p95` would
 *  not see it and the stall gate would not either. Four seconds is longer than
 *  any pause inside a sentence and shorter than a writer's attention between
 *  paragraphs. */
const COUNT_REFRESH_MS = 4000;
const OVERSCAN = 4;

export type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface MountDeps {
  mode: "virtual" | "naive";
  diagnostics?: boolean;
  seed: string;
  persistMode: "write" | "verify";
  projectPath: string;
  invoke: Invoke | undefined;
  /** Subscribe to a host event. Absent outside the Tauri host, and absent in
   *  every test that does not care. Only the recovery surface uses it: the
   *  close listener is application chrome and is wired once, in main.ts. */
  listen?: (event: string, cb: () => void) => Promise<unknown>;
  /** Which open of which project this mount belongs to. Sent with every flush;
   *  the host refuses one that does not match the project it currently holds. */
  generation: number;
  /** The writer's daily goal, READ AT MOUNT rather than passed as a value: the
   *  preferences panel outlives every project, so a manuscript opened after the
   *  goal changed must start on the new one. Absent in every test that does not
   *  care. */
  dailyTarget?: () => DailyTarget;
  /** Whether the minutes a writer edits in are counted. Same shape and reason
   *  as `dailyTarget`: a getter, held outside the mount. */
  timeTracking?: () => TimeTracking;
  /** Persist the switch. The panel re-reads afterwards. */
  setTimeTracking?: (tracking: TimeTracking) => Promise<void>;
  /** Whether the cast-marks plugin is fed any names at all. Same
   *  shape as `dailyTarget`: a getter, held outside the mount, read once at
   *  mount to seed the plugin -- a live toggle reaches the OPEN mount through
   *  `MountedProject.setMarkCastNames` instead, `current`'s own route in
   *  main.ts. */
  markCastNames?: () => boolean;
  sidebarWordCounts?: () => SidebarWordCounts;
  /** Add one word to the open book's dictionary and answer it as stored
   *  Owned by the preferences panel, which paints the list, so the
   *  panel and the host agree the moment the menu item runs. Absent in every
   *  test that does not care; the menu item then reports it cannot. */
  addToDictionary?: (word: string) => Promise<string>;
  privacyLocked?: () => boolean;
  /** Open the project panel, where the readable folder is turned on. Owned by
   *  the switcher in main.ts; the status dot offers it while the folder is off. */
  openProjectPanel?: () => void;
}

export interface MountedProject {
  navigator: ManuscriptNavigator;
  editor: Editor;
  session: Session | null;
  /** Every structural edit to the manuscript, and the only unit that may make
   *  one. Exposed because the graded rig drives creates, renames and moves
   *  through it: the alternative is synthesizing pointer and key events for a
   *  bar whose wiring is not what that run is measuring. */
  outline: Outline | null;
  source: FixtureSource;
  /** The walk as it was AT BOOT, and only then.
   *
   *  It goes stale the moment anything creates, renames or moves an item: the
   *  outline unit re-reads the walk after every mutation and this field is
   *  never updated from it. Anything that must know the tree's current shape
   *  reads `outline.items()`; this is a seed and a record of what the mount
   *  started from. A consumer that forgets the difference sees a manuscript
   *  frozen at page load - which is exactly how the opener's type lookup went
   *  dead for every item created in the session. */
  storeItems: ProjectItem[] | null;
  activeDocId: string | null;
  activeDocRev: number;
  loadedBodyHash: string;
  flusher: FlushScheduler | null;
  /** `error`, when there is one, keeps the host's diagnostic out of the
   *  headline and behind the banner's Details. */
  raiseFailure(message: string, error?: unknown): void;
  raiseNotice(message: string): void;
  /** A completed action, in the success tone. Exposed for units mounted
   *  outside `mountProject` (the switcher, in main.ts) that still need the
   *  page's one route for their own successes. */
  announce(message: string): void;
  /** The writer chose a different daily goal. */
  setDailyTarget(target: DailyTarget): void;
  /** The writer flipped "Mark cast names in the text". Takes effect on
   *  the open scene at once -- see `preferences.ts`'s own `onMarkCastNames`. */
  setMarkCastNames(on: boolean): void;
  setSidebarWordCounts(counts: SidebarWordCounts): void;
  /** Whether a copy failed, went stale or is paused: the status dot's amber.
   *  The project panel opens Backups and archives by itself on it. */
  copiesNeedAttention?(): boolean;
  /** An accessor, not a snapshot: the latch is set by a failure that can arrive
   *  long after mounting, and the sink payload is written at the very end. */
  persistError(): string | null;
  /** What the application menu offers that belongs to the OPEN project.
   *
   *  The menu bar is built once, in main.ts, and lives across project switches
   *  because it is application chrome. It must therefore reach these through
   *  `current` and never capture them: a captured reference would go on acting
   *  on the project that happened to be open when the menu was built. Exactly
   *  the rule `setDailyTarget` above is written for, and the defect the outline
   *  slice shipped once. */
  menuActions: MenuProjectActions;
  reviewPending(): boolean;
  reviewPrivacyChanged(): void;
  prepareToLeave(): Promise<boolean>;
  cancelLeave(): void;
  destroy(): void;
}

/** Every one of these is a no-op where the unit behind it does not exist: a
 *  menu item that threw during assembly would turn a measurement run into a
 *  page error. */
export interface MenuProjectActions {
  showManuscript(): void;
  showOutlineTable(): void;
  showOutlineCards(): void;
  showReadThrough(): void;
  showContinuousChapter(): void;
  openReference(): void;
  closeReference(): void;
  outlineViewMode(): OutlineViewMode | "continuous";
  exportProject(): void;
  /** Export through the operating system's own save dialog. */
  exportAs(): void;
  /** The DOCX editor handoff, through the same OS save dialog. */
  exportDocx(): void;
  /** Take a recovery point on this device now. */
  backupNow(): void;
  openFind(): void;
  openQuickOpen(): void;
  openReplace(): void;
  openHistory(): void;
  /** Show what the writer changed in the readable folder. Reads nothing back. */
  openMirrorChanges(): void;
  openComments(): void;
  addComment(): void;
  /** The word under the caret into this book's dictionary. */
  addToDictionary(): void;
  openStatistics(): void;
  openAnalytics(): void;
  /** Where the selected row stands in its revision. */
  openRevisionState(): void;
  openReviewProposals(): void;
  /** What the selected row is about. */
  openSynopsis(): void;
  openCast(): void;
  openKnowledge(): void;
  openCraftReports(): void;
  /** How the BOOK is set when it leaves. Per book, unlike Preferences. */
  openBookDesign(): void;
  /** The picture on the front of the book and the one on the back. Beside the
   *  design rather than inside it -- see `covers-panel.ts`. */
  openCovers(): void;
  /** Who the book is by, and which of the library's pen names it is written
   *  under. */
  openIdentities(): void;
  openEpubPreview(): void;
  openPdfPreview(): void;
  openAppearances(): void;
  openAppearancesMap(): void;
  /** Back and forward through the scenes the writer has opened. */
  navBack(): void;
  navForward(): void;
  /** Is there anywhere to go? Read when the menu is PAINTED, so the item can
   *  say it cannot act instead of looking live and doing nothing. */
  canNavBack(): boolean;
  canNavForward(): boolean;
  undo(): void;
  redo(): void;
  /** The outline's structural stack, distinct from the prose undo above. */
  outlineUndo(): void;
  outlineRedo(): void;
  outlineUndoLabel(): string | null;
  outlineRedoLabel(): string | null;
  openCreation(): void;
  create(itemType: string): void;
  /** A free-form document in the bible, section and all. */
  createNote(): void;
  createBibleFolder(): void;
  /** A timeline in the bible, section and all. `createNote`'s own reason. */
  createTimeline(): void;
  /** A dedication, a foreword, an acknowledgements page or an afterword,
   *  section and all. */
  createMatter(kind: MatterKind): void;
  /** Move the selected row. The same act the Alt+Arrow chords perform, reached
   *  from the menu -- which is where a writer looks for it. */
  move(direction: MoveDirection): void;
  beginRename(): void;
  removeOrRestore(): void;
  /** Is the selected row in the bin? Read when the menu is PAINTED so the item
   *  says which of Delete and Restore it will do. */
  selectedTrashed(): boolean;
}

export async function mountProject(deps: MountDeps): Promise<MountedProject> {
  const { mode, persistMode, projectPath, invoke } = deps;

  if (invoke === undefined) throw new Error("APP_PROJECT is set but the Tauri bridge is absent");
  const store = await loadStoreSource(invoke, deps.seed);
  const source: FixtureSource = storeSourceFrom(readingOrderItems(store.items), deps.seed);
  // The boot-time walk, kept for the mutation phase.
  const storeItems: ProjectItem[] = store.items;
  // idAt(0) is the first row of a depth-first walk, which is a part. Only
  // scenes have documents.
  const firstScene = store.items.findIndex((i) => i.type === "scene");
  if (firstScene < 0) {
    throw new Error("project has no scene: nothing to open in the editor");
  }
  const activeDocId: string = store.idAt(firstScene);
  const loadedDoc = (await invoke("doc_load", { itemId: activeDocId })) as {
    body: string;
    rev: number;
  };
  const activeDocRev = loadedDoc.rev;
  // ASKED, NOT ASSUMED. A body written by a NEWER build carries a mark or a
  // node this schema has no type for, and `schema.nodeFromJSON` answers that
  // with a RangeError from inside `createEditor` - a blank window with a
  // ProseMirror sentence behind it. Refusing by name is the cheap half of the
  // migration answer; see `readableBody`.
  const openedJson = readableBody(loadedDoc.body);
  if (openedJson === null) {
    // ONE LITERAL, not a concatenation: the catalog guard exempts the argument
    // to a `throw new Error(...)` by looking at what precedes the quote, and a
    // second fragment joined with `+` is not preceded by one. Every startup
    // throw in this file has the same shape for the same reason.
    throw new Error(
      `${activeDocId} was written by a different build of the application and cannot be opened here`,
    );
  }
  const editorInput: DocInput = { kind: "pmjson", json: openedJson };

  // The shell is in index.html so the stylesheet owns layout. Sizing the
  // navigator from a string here is what made the pane 640px tall regardless of
  // the window, which is a measurement artifact rather than a design.
  const navEl = document.getElementById("nav");
  const editorEl = document.getElementById("editor");
  if (navEl === null || editorEl === null) {
    throw new Error("page shell is missing #nav or #editor: index.html and project.ts disagree");
  }
  const editorPane = editorEl;
  const navColumnEl = navEl.parentElement;
  if (navColumnEl === null) throw new Error("page shell is missing #nav parent");
  // Looked up HERE rather than beside the units that use them, so the throw
  // happens before a navigator and an editor exist to leak on the way out.
  const renameEl = document.getElementById("rename-controls");
  if (renameEl === null) {
    throw new Error("page shell is missing #rename-controls: index.html and project.ts disagree");
  }
  const countEl = document.getElementById("word-count");
  if (countEl === null) {
    throw new Error("page shell is missing #word-count: index.html and project.ts disagree");
  }
  const findEl = document.getElementById("find-controls");
  if (findEl === null) {
    throw new Error("page shell is missing #find-controls: index.html and project.ts disagree");
  }
  const saveEl = document.getElementById("save-controls");
  if (saveEl === null) {
    throw new Error("page shell is missing #save-controls: index.html and project.ts disagree");
  }
  // Its OWN span, immediately before #save-controls. `createSaveIndicator`
  // clears its container on mount and on destroy, so an indicator sharing that
  // element is wiped by the next project's mount.
  const recoveryEl = document.getElementById("recovery-controls");
  if (recoveryEl === null) {
    throw new Error("page shell is missing #recovery-controls: index.html and project.ts disagree");
  }
  // Its OWN span again, for the same reason twice over: the unit on either side
  // of it clears its container on mount and on destroy.
  const archiveEl = document.getElementById("archive-controls");
  if (archiveEl === null) {
    throw new Error("page shell is missing #archive-controls: index.html and project.ts disagree");
  }
  // A third span, and the one that is not about protection at all: whether the
  // readable folder is keeping up with what the writer has typed.
  const mirrorEl = document.getElementById("mirror-controls");
  if (mirrorEl === null) {
    throw new Error("page shell is missing #mirror-controls: index.html and project.ts disagree");
  }
  // The header's one word about where the writer is. Painted from the walk,
  // never from the editor: a document does not know its own title.
  const sceneNameEl = document.getElementById("scene-name");
  if (sceneNameEl === null) {
    throw new Error("page shell is missing #scene-name: index.html and project.ts disagree");
  }
  // The same word again, read-only, at the top of the prose column: the
  // header names the scene in the chrome, this names it on the page itself.
  // Painted alongside sceneNameEl in paintSceneName below, never
  // separately, so the two can never drift apart.
  const sceneHeadingEl = document.getElementById("scene-heading");
  if (sceneHeadingEl === null) {
    throw new Error("page shell is missing #scene-heading: index.html and project.ts disagree");
  }
  // The dot's span, and the popover that is static markup INSIDE it, holding
  // the three anchors above. The popover is looked up through the span rather
  // than by id so a page that moved it out of the span fails here, not in the
  // closer, which treats the span as "inside".
  const statusEl = document.getElementById("status-controls");
  if (statusEl === null) {
    throw new Error("page shell is missing #status-controls: index.html and project.ts disagree");
  }
  const popoverEl = statusEl.querySelector<HTMLElement>("#status-popover");
  if (popoverEl === null) {
    throw new Error(
      "page shell is missing #status-popover inside #status-controls: index.html and project.ts disagree",
    );
  }
  // Required like the count it sits beside: index.html is the one shell every
  // run loads, the measurement run included.
  const goalBarEl = document.getElementById("goal-bar");
  if (goalBarEl === null) {
    throw new Error("page shell is missing #goal-bar: index.html and project.ts disagree");
  }

  // The opener needs the session, which needs the flusher, which is built
  // below; the navigator needs its activation callback at construction. One
  // mutable reference resolves the cycle without reordering page assembly. A
  // click before the session exists is a click during boot, and doing nothing
  // is the correct answer to it.
  let openDocument: ((itemId: string) => Promise<void>) | null = null;
  let undoInFlight = false;
  let inflightOpens = 0;
  /** A saved-word pause, resume or reset is settling saves and updating the
   *  host. Scene opening and mirror undo wait it out. */
  let sourceCommandInFlight = false;
  let historyOperationInFlight = false;
  let historyReconcileFailed = false;
  let reviewDecisionInFlight = false;
  let reviewOpenInFlight = false;
  let reviewTransportInFlight = false;
  let projectLeaving = false;
  let reviewReconcileFailed = false;
  let reviewPanel: ReviewPanel | null = null;
  // Where the writer has been. Per project and it dies with the project: the
  // trail names item ids, and the next manuscript's ids describe different
  // scenes - two projects seeded from the same generator share them outright.
  const navHistory = createNavHistory();
  // Declared before the flusher because the flusher's onStateChange closes over
  // it, and built after it because it opens on the flusher's own answer. The
  // cycle is the same one openDocument resolves, for the same reason.
  let saveIndicator: SaveIndicator | null = null;
  // The same cycle, for the same reason: the navigator reports Alt+Arrow at
  // construction, the outline resolves it against a selection only the
  // navigator knows. An Alt+Arrow before the outline exists is one during boot,
  // and doing nothing is the correct answer to it.
  let moveItem: ((itemId: string, direction: MoveDirection, count?: number) => Promise<OutlineOutcome>) | null = null;
  let removeItem: ((itemId: string) => void) | null = null;
  // The same cycle again, for structural undo/redo: the navigator
  // reports Ctrl+Z at construction, the outline unit holding the stack is
  // built below it. A Ctrl+Z before it exists is one during boot, and doing
  // nothing is the correct answer to it.
  let undoItem: (() => void) | null = null;
  let redoItem: (() => void) | null = null;
  // The same cycle again, and the longest of the three: the navigator reports a
  // right-click at construction, while the menu it opens needs the outline unit,
  // the rename field and the revision panel - all built below it. A right-click
  // before they exist is one during boot, and doing nothing is the right answer.
  let navContextMenu: NavContextMenu | null = null;
  // The walk the page last saw, which is NOT always the one the outline unit
  // holds: during a reload the unit has not committed the new one yet.
  let latestItems: readonly ProjectItem[] = storeItems;
  let outlineView: OutlineView | null = null;
  let outlineViewTransitions: OutlineViewTransitions | null = null;
  let continuousChapter: ContinuousChapter | null = null;
  let outlineCounts: ReadonlyMap<string, number> = new Map();
  /** Armed by anything that can change a count - a flush ack or a tree
   *  mutation - and cleared on teardown, because it holds a live callback into
   *  a project that may be gone. */
  let countTimer: ReturnType<typeof setTimeout> | null = null;
  let countsDestroyed = false;
  /** Words gained and lost since this window opened. PER MOUNT, so a project
   *  switch starts a new session - which is what a writer means by one. Fed from
   *  the two places that already hold a word count off the keystroke path: the
   *  scene figure's throttle, and the count refresh below. */
  const sessionWords: SessionWords = createSessionWords();

  /** Read the per-document counts, roll them up the tree, and hand them to the
   *  navigator.
   *
   *  Failure is SILENT. The counts are informational and the manuscript is
   *  unaffected; a banner for a figure the writer did not ask for would be the
   *  application interrupting them about its own bookkeeping. The rows simply
   *  keep the figures they had, which is the honest rendering of "no newer
   *  answer". */
  async function refreshCounts(): Promise<void> {
    if (invoke === undefined || countsDestroyed) return;
    try {
      const perDoc = (await invoke("project_word_counts")) as DocumentCounts;
      if (countsDestroyed) return;
      // THE OPEN DOCUMENT IS SKIPPED. This map is what the STORE holds; the open
      // scene's live count runs ahead of it by up to a flush debounce, and the
      // scene throttle above has already reported that. Observing both would
      // read the lag as words deleted and then written again.
      sessionWords.observeAll(perDoc, session?.activeDocId() ?? null);
      // The LIVE walk, for the same reason quick open reads it: a scene created
      // a moment ago exists there and nowhere else.
      outlineCounts = rollUpCounts(outline?.items() ?? latestItems, perDoc);
      navigator.setCounts(outlineCounts);
      outlineView?.setCounts(outlineCounts);
    } catch {
      // See above.
    }
  }

  /** Which rows carry a synopsis, for the navigator's mark. Read at mount and
   *  after every save; a failure paints nothing rather than a banner, because a
   *  missing mark is a missing mark and not a lost word. */
  async function refreshSynopses(): Promise<void> {
    if (invoke === undefined || countsDestroyed) return;
    try {
      const ids = (await invoke("synopsis_ids")) as string[];
      if (countsDestroyed) return;
      navigator.setSynopses(new Set(ids));
    } catch {
      // See refreshCounts: a read that fails leaves the previous marks standing.
    }
  }

  let appearancesRead = 0;
  async function refreshAppearanceMarks(): Promise<void> {
    if (invoke === undefined || countsDestroyed) return;
    const mine = ++appearancesRead;
    try {
      const all = (await invoke("appearances_list")) as ItemAppearances;
      if (countsDestroyed || mine !== appearancesRead) return;
      navigator.setAppearances(new Set(
        Object.entries(all).filter(([, members]) => members.length > 0).map(([id]) => id),
      ));
    } catch {
      // Keep the last known marks if this read fails.
    }
  }

  function scheduleCountRefresh(): void {
    if (invoke === undefined || countsDestroyed) return;
    if (countTimer !== null) clearTimeout(countTimer);
    countTimer = setTimeout(() => {
      countTimer = null;
      void refreshCounts();
    }, COUNT_REFRESH_MS);
  }
  // Third leg of the same cycle. The outline unit is assembled below, and it -
  // not this function - holds the walk that the store last reported.
  let outline: Outline | null = null;
  // The LIVE walk, never a boot snapshot. Every outline mutation re-reads the
  // whole walk, so a scene created after boot exists in `outline.items()` and
  // nowhere else; a Map built at mount time answers `undefined` for it, and
  // `undefined` takes the same silent early return as a part or a chapter -
  // the row appears, clicking it does nothing, and nothing says so. Falls back
  // to the boot walk only for the window before the outline is constructed.
  const typeOf = (itemId: string): string | undefined =>
    (outline?.items() ?? storeItems).find((i) => i.id === itemId)?.type;
  // `latestItems`, not `outline.items()`: the one caller that repaints after a
  // rename runs from the outline's reload, BEFORE the unit commits the walk it
  // just handed over, so asking the unit there would paint the old title.
  const titleOf = (itemId: string): string =>
    latestItems.find((i) => i.id === itemId)?.title ?? "";
  const paintSceneName = (itemId: string | undefined): void => {
    const text = itemId === undefined ? "" : titleOf(itemId);
    sceneNameEl.textContent = text;
    // A button with no name is an unnamed tab stop; with nothing open there
    // is nowhere it could say the writer is.
    sceneNameEl.hidden = text === "";
    sceneHeadingEl.textContent = text;
  };
  const navigator = createNavigator({
    sidebarWordCounts: deps.sidebarWordCounts?.(),
    container: navEl,
    source,
    rowHeight: ROW_HEIGHT,
    overscan: OVERSCAN,
    mode,
    onActivate: (itemId) => {
      // switchTo swallows its own failures, but markOpen, focusEditor and the
      // notice path can still throw, and an unhandled rejection here would
      // never reach the sink.
      void openDocument?.(itemId).catch((err: unknown) => {
        raiseNotice(t("project.error.open-document", { error: String(err) }));
      });
    },
    onSelect: (itemId) => outlineView?.selectById(itemId),
    onMove: (itemId, direction) => moveItem?.(itemId, direction),
    onRemove: (itemId) => removeItem?.(itemId),
    onUndo: () => undoItem?.(),
    onRedo: () => redoItem?.(),
    onContextMenu: (itemId, x, y) => navContextMenu?.open(itemId, x, y),
  });
  /** Read the notes on one document into the editor. A no-op until the store is
   *  open and the comments panel is built. */
  let loadComments: (itemId: string) => Promise<void> = async () => undefined;
  // A fixed body control, deliberately outside the fading chrome. It receives
  // only successful comment reads, so a slow outgoing scene cannot paint a
  // count over the incoming one.
  let sceneNotes: SceneNotes | null = null;
  let projectDestroyed = false;
  /** The count is only meaningful for the live document the editor currently
   *  names. Unlike editor anchors, it must not survive binning that document or
   *  a panel callback carrying rows from another scene. */
  const updateSceneNotes = (itemId: string, rows: readonly CommentRow[]): void => {
    if (session?.activeDocId() !== itemId) return;
    if (!liveItemsIn(latestItems).some((item) => item.id === itemId)) return;
    if (rows.some((row) => row.item_id !== itemId)) return;
    sceneNotes?.setRows(rows);
  };
  // The cast list this mount last read, held for two readers: the marks
  // plugin's feed and the hover card's `memberFor` -- one read serves both,
  // and neither makes a host call of its own.
  let castMembers: readonly CastMemberRow[] = [];
  // Read once at mount, on `dailyTarget`'s own reasoning; a live toggle
  // reaches this mount through `setMarkCastNames` below instead.
  let markCastNamesOn = deps.markCastNames?.() ?? true;
  // Built after the editor, from the editor's own comment-anchor style
  // wiring; null until then so the chord below is correctly a no-op.
  let castCard: CastCard | null = null;
  // The session does not exist yet: the flush scheduler needs the document id
  // and revision that are only known a few lines below. Until it does, a change
  // is correctly a no-op.
  let session: Session | null = null;
  // Built below, after the editor it reads and the flusher whose acks refresh
  // it. Null until then.
  let wordCount: WordCountView | null = null;
  // Built immediately after the editor, from the editor's own commands. Null
  // until then so the onStateChange below is correctly a no-op.
  let formatBubble: FormatBubble | null = null;
  // Built after the bubble, once #editor exists to give it as the pane. Null
  // until then so the keystroke feed below is correctly a no-op.
  let chromeFade: ChromeFade | null = null;
  // The open timeline, or null while the open document is prose. Built
  // and torn down from session's onTimelineDoc/the prose branch of
  // sessionEditor.replaceDoc below -- ONE variable, so "is a timeline open"
  // has one answer for focusEditor, markOpen, commentsOf and Add comment
  // alike, rather than four places that could disagree about it.
  let timelineMount: TimelineMount | null = null;
  const editor = createEditor(editorEl, editorInput, {
    onChange: (change) => {
      // Once per document-changing transaction, same as the word count
      // above: the module arms once and returns early after, so the
      // per-keystroke cost past the first is an attribute read and a class
      // check.
      chromeFade?.onType();
      // A card floating over prose that just changed under it would be
      // describing text that may no longer be there.
      castCard?.onDocChanged();
      // Outside the persistMode fork on purpose: the scene figure is a display
      // of what is on screen, and verify mode shows a document too.
      //
      // THROTTLED, and that is what this call site is for. onChange fires once
      // per document-changing transaction, so once per keystroke, and counting
      // the scene here synchronously put a whole-document scan inside every
      // typed character: dispatch p95 went 1 -> 2 ms across both graded stress
      // runs and back to 1 with this. refreshScene books a repaint; it does not
      // take one. It did NOT move the 40-100 ms frame tail - that belongs to
      // the project scan below, see word-count.ts.
      wordCount?.refreshScene();
      if (persistMode === "write") {
        session?.noteChange(change);
        writingTime.touch();
      }
    },
    // EVERY transaction, a caret move included: a writer who clicks into an
    // underlined word must see the control pressed, and that transaction
    // changes no document. Cheap by construction - `activeMarks` reads the
    // marks at a collapsed caret and walks only the selected range otherwise,
    // and `setActive` writes nothing when the reading has not changed. The
    // word-count rescan is the recorded precedent for what per-keystroke work
    // on this path costs while every scalar gate stays green.
    //
    // `onSelection` re-arms the bubble's own debounce against wherever this
    // transaction leaves the selection -- a caret move included, since a
    // selection collapsing to one is exactly the signal that hides it.
    onStateChange: () => {
      formatBubble?.setActive(editor.activeMarks());
      formatBubble?.onSelection();
    },
    onFocus: () => formatBubble?.onFocus(),
    onBlur: (event) => formatBubble?.onBlur(event),
  });
  formatBubble = createFormatBubble({
    container: document.body,
    pane: () => editorEl.getBoundingClientRect(),
    selection: () => editor.selection(),
    selectionRect: () => editor.selectionRect(),
    selectedText: () => {
      const { from, to } = editor.selection();
      return editor.textIn(from, to);
    },
    // SECOND CALLERS of the commands Mod-b/Mod-i/Mod-u are bound to, exactly as
    // the Edit menu's Undo is a second caller of Mod-z. The bubble must not own
    // a keystroke, or the chord the shortcuts panel advertises and the chord
    // that works become two things that can drift.
    toggleBold: () => {
      if (continuousChapter?.crossBoundarySelection()) return;
      editor.toggleBold();
      // The press cancelled its own mousedown, so the caret never left the
      // prose; this is for the keyboard route, where the button really does
      // hold focus and the writer's next keystroke belongs in their manuscript.
      editor.focus();
    },
    toggleItalic: () => {
      if (continuousChapter?.crossBoundarySelection()) return;
      editor.toggleItalic();
      editor.focus();
    },
    toggleUnderline: () => {
      if (continuousChapter?.crossBoundarySelection()) return;
      editor.toggleUnderline();
      editor.focus();
    },
    // Deferred lookups: `comments` and `findBar` are built later in this
    // function, from units the bubble does not need to exist yet to be wired
    // to. Neither is ever pressed before both are built, because pressing
    // either means a selection exists, which means the editor already has
    // focus and the panels below it are already up.
    addComment: () => { if (!continuousChapter?.crossBoundarySelection()) void comments?.open("compose"); },
    blocked: () => continuousChapter?.crossBoundarySelection() === true,
    findInBook: (query) => findBar?.openWith(query),
    addToDictionary: (word) => addWordToDictionary(word),
  });
  formatBubble.setActive(editor.activeMarks());

  /** One body for the bubble's control and the Edit item: the host
   *  stores the word, the preferences panel repaints its list, and the writer
   *  hears which word landed -- the checker's underline is WebKit's and goes
   *  on its own schedule. A refusal (already there, nothing open) is reported
   *  as a problem in the writer's words, `prefs.dict.error.add`'s own key. */
  function addWordToDictionary(word: string): void {
    const add = deps.addToDictionary;
    if (add === undefined) {
      raiseNotice(t("prefs.dict.error.add", { word, error: t("library.nothing-open") }));
      return;
    }
    // Where the word is NOW, read before the round trip: the marker to
    // clear is on the occurrence the writer pointed at, and the caret may
    // have moved by the time the host answers.
    const at = editor.wordAtCaret();
    add(word)
      .then((stored) => {
        if (projectDestroyed) return;
        if (at !== null && at.text === word) editor.redrawSpelling(at.from, at.to);
        announce(t("dict.added", { word: stored }));
      })
      .catch((err: unknown) => {
        if (projectDestroyed) return;
        raiseNotice(t("prefs.dict.error.add", { word, error: String(err) }));
      });
  }
  // The bubble is fixed on body and placed from the selection's own
  // coordinates; sliding #editor to recentre while it rests on screen
  // would detach it from the text it is next to.
  // formatBubble is already built above, so no optional chaining is needed
  // to read it here -- kept anyway because destroy() nulls neither, and a
  // future reorder should not silently start reading a stale null.
  chromeFade = createChromeFade({
    root: document.documentElement,
    body: document.body,
    pane: editorEl,
    blocked: () => formatBubble?.shown() === true,
  });

  // NO HOST CALL ON HOVER: the card reads `castMembers`,
  // the same list `namesForCast` below feeds the editor plugin from, loaded
  // once at mount and refreshed only when the cast panel reports a change.
  castCard = createCastCard({
    container: document.body,
    memberFor: (id) => castMembers.find((m) => m.id === id),
    // A DEFERRED LOOKUP, `formatBubble`'s own `addComment` reason: `castPanel`
    // is built later in this function, from units this card does not need to
    // exist yet to be wired to, and the button is never pressed before both
    // are built.
    openInCast: (id) => {
      // A DELIBERATE CLICK, `openDocument`'s own reason for surfacing its
      // failure rather than swallowing it: the writer pressed "Open in
      // Cast" and asked for something to happen, so a rejection here must
      // say so rather than leave the button looking like it did nothing.
      void castPanel?.open(id).catch((err: unknown) => {
        raiseNotice(t("cast.card.error.open", { error: String(err) }));
      });
    },
  });

  /** Which (text, memberId) pairs the plugin should look for right now.
   *  EMPTY when the preference is off -- decision 3's own words -- so an
   *  off writer costs the plugin nothing beyond the one length check its own
   *  `apply` already makes on every keystroke. */
  function namesForCast(list: readonly CastMemberRow[]) {
    if (!markCastNamesOn) return [];
    return castNamesFor(list);
  }

  /** Read the book's cast and feed both readers of it: the plugin's matcher
   *  and the hover card's lookup. Called once at mount and again whenever the
   *  cast panel reports a change -- see `castPanel`'s own `onDone` below.
   *  SWALLOWS ITS OWN FAILURE, `loadComments`'s own rule: a book whose cast
   *  could not be read is still a book the writer can write in. */
  async function loadCastNames(): Promise<void> {
    if (invoke === undefined) return;
    try {
      const members = (await invoke("cast_list")) as CastMemberRow[];
      if (projectDestroyed) return;
      castMembers = members;
    } catch {
      return;
    }
    editor.setCastNames(namesForCast(castMembers));
  }
  void loadCastNames();

  /** Ctrl+Shift+I with the caret inside a marked run: the keyboard route to
   * the same card a hover shows. On the DOCUMENT, `onCommentChord`'s
   *  own reason: the editor's keymap only fires while the editor has focus. */
  const onCastCardChord = (event: Event): void => {
    if (!(event instanceof KeyboardEvent) || isCompositionKey(event)) return;
    if (!isShowCastCardChord(event)) return;
    const target = event.target;
    if (target instanceof Element && target.closest("input, textarea, [role='dialog']") !== null) {
      return;
    }
    const hit = editor.castMarkAtCaret();
    // Not inside a marked run. Silent, `beginRename`'s own rule for a chord
    // pressed somewhere it has nothing to act on.
    if (hit === null) return;
    event.preventDefault();
    castCard?.showFor(hit.element, hit.memberId);
  };
  document.addEventListener("keydown", onCastCardChord);

  editor.focus();

  // The failure surface. One element, role=alert, raised once. The rescue copy
  // the spec also describes is deferred to the history slice.
  let persistError: string | null = null;
  // Extracted to banner.ts so the empty workspace can raise into the
  // SAME surface with nothing mounted - see that module for the shape and for
  // why each mount holds its own instance rather than a shared one.
  const noticeBanner = createBanner();
  function banner(id: string, text: string, tone: Tone, detail?: string): void {
    noticeBanner.raise(id, text, tone, detail);
  }
  function raiseFailure(message: string, error?: unknown): void {
    if (persistError !== null) return;
    persistError = message;
    // The host's sentence names its own recovery; the diagnostic goes behind
    // Details rather than into the one line that says automatic saving stopped.
    if (error instanceof HostCommandError) {
      banner("persist-error", t("project.error.persist", { message: error.problem }), "failure", error.detail);
    } else {
      banner("persist-error", t("project.error.persist", { message }), "failure");
    }
  }
  // A failed OPEN is not a failed save, and must not go through raiseFailure:
  // that latches persistError, so the first unopenable document would suppress
  // the banner for a genuine autosave failure afterwards - the one case the
  // surface exists for - and would report itself as a persistence error in the
  // sink payload. Nothing was lost here; the editor still holds the document it
  // had.
  function raiseNotice(message: string): void {
    banner("open-error", message, "problem");
  }
  /** A completed action: an export that wrote a file, a replace that changed
   *  some words. Polite, dismissible, and it takes itself away. */
  function announce(message: string): void {
    banner("open-error", message, "success");
  }
  /** News that is not an outcome of anything the writer asked to be done. */
  function inform(message: string): void {
    banner("open-error", message, "info");
  }

  // The document as loaded THIS run, before any typing. Doubles as the verify
  // payload's body_hash (nothing is typed in verify mode, so "loaded" and
  // "current" are the same thing) and as the write payload's baseline.
  const loadedBodyHash = bodyHash(editor.serialize());
  let referenceRail: ReferenceRail | null = null;
  let craftPanel: CraftPanel | null = null;
  const flusher = createFlushScheduler({
    wordCountOf: (body) => countWords(bodyText(body)),
    localDay: () => localDate(new Date()),
    // The generation the page believed it was writing to. The host refuses
    // a flush that does not match, which is what makes a swap safe even
    // when the page's ordering is wrong: two projects seeded from the same
    // generator share item ids, so a stale flush would otherwise land on a
    // real row in the wrong manuscript with no error anywhere.
    invoke: async (entries, sources) => {
      const acks = (await invoke("doc_flush", { entries, sources, generation: deps.generation })) as {
        item_id: string;
        rev: number;
      }[];
      // The scheduler reports failures and nothing else - it has no
      // success hook, and adding one would put a display concern inside
      // the unit that owns the save path. Here is the least invasive
      // place that still means "a flush landed": after the await, so a
      // rejected flush throws past it and never refreshes, and inside
      // the closure the scheduler already calls, so nothing new is
      // scheduled or awaited on the keystroke path.
      //
      // THIS CALL ONCE OWNED THE SLICE'S TYPING TAIL, and the history is
      // worth keeping because the shape of it recurs. Flushes land about
      // once a second while someone types - 291 of them in the 5-minute
      // persistence run at stress - and `project_word_count` answered each
      // one with a full scan of every document in the manuscript, measured
      // at ~58 ms over 15,200 documents. That put 116 frames into the
      // 40-100 ms bucket and frame p99 at 43 ms, against a pre-slice 0 and
      // 34. Being off the keystroke path is not enough when the work is
      // this big and this frequent.
      //
      // It was fixed on the HOST side, not here: the host keeps a
      // per-document word index built once at open and moved by the delta
      // of each accepted flush, so this command is now O(1) and the same
      // runs record 0 frames in the 40-100 ms bucket with p99 at 33-34.
      // Throttling this call would have been the band-aid - a slower scan
      // still costs a pass over the whole manuscript. The cadence here is
      // therefore free again, and the thing to protect is the host's
      // invariant: anything that changes a stored body must move the index
      // with it, or this number silently drifts.
      void wordCount?.refreshProject();
      // NOT refreshed here, only ARMED. The bar's total is O(1) in the
      // host; the per-item map is O(documents), and running it at this
      // cadence would be per-second work over the whole manuscript's
      // structure behind a figure nobody is watching change.
      scheduleCountRefresh();
      for (const ack of acks) { referenceRail?.sourceChanged(ack.item_id); craftPanel?.sourceChanged(ack.item_id); }
      return acks;
    },
    // WHERE THE OPEN SCENE'S NOTES NOW ARE, read at flush time so a
    // position and the prose it describes reach the file in one
    // transaction. `session` and `editor` are both in scope by the time
    // this runs - a flush cannot happen before the first keystroke, and
    // the session is built immediately below.
    //
    // undefined for anything that is not the open document (nothing else
    // can have been edited) and for the open one once mapping has been
    // capped, so the last positions known to be right are the ones that
    // stay.
    // A TIMELINE'S ITEM ID IS CHECKED BEFORE `flushAnchorsFor` EVER RUNS.
    // `flushAnchorsFor` answers by comparing `itemId` against
    // `session.activeDocId()`, and a timeline's id EQUALS that once it is
    // open -- `session.ts`'s own `docId` moves for either document kind. The
    // ProseMirror editor stays hidden and unchanged underneath it, so
    // `editor.commentAnchors()` still answers with whatever the PREVIOUS
    // scene's notes were; without this guard the timeline's own flush entry
    // would carry that scene's positions, silently, the first time a writer
    // typed into an event's title.
    commentsOf: (itemId) =>
      typeOf(itemId) === TIMELINE_TYPE
        ? undefined
        : flushAnchorsFor(
            session?.activeDocId(),
            itemId,
            editor.commentsCapped(),
            editor.commentAnchors(),
          ),
    onFailure: raiseFailure,
    // The indicator is built below, after the flusher it reads. A
    // transition arriving before then has nothing to draw on and nothing
    // to lose: the indicator opens on `flusher.saveState()`, so it starts
    // from the truth rather than from whatever it missed.
    onStateChange: (state) => saveIndicator?.set(state),
  });
  {
    flusher.register(activeDocId, activeDocRev);
    session = createSession({
      // Keep the outgoing timeline visible until replaceDoc accepts the
      // prose schema. It can throw before updating the editor, and session
      // restores the outgoing id on failure. replaceDoc fires no onChange.
      // `serialize` is never called while a timeline is open (see below).
      editor: {
        serialize: () => editor.serialize(),
        replaceDoc: (input) => {
          editor.replaceDoc(input);
          timelineMount?.destroy();
          timelineMount = null;
          editor.setHidden(false);
        },
      },
      flusher,
      docId: activeDocId,
      loadDoc: async (itemId) =>
        (await invoke("doc_load", { itemId })) as { body: string; rev: number },
      isTimelineDoc: (itemId) => typeOf(itemId) === TIMELINE_TYPE,
      beforeSwap: (itemId, body) => continuousChapter?.beforeSwap(itemId, body),
      // The second document kind's own apply step. Hides the ProseMirror DOM
      // (its EditorState is untouched -- the writer's place in whatever
      // scene they left is exactly where they left it) and mounts the
      // lanes into #editor. `onDirty` routes STRAIGHT into
      // `flusher.markDirty`, never through `session.noteChange()`: that
      // function reads `editor.serialize()`, which would re-flush the
      // HIDDEN prose document under the timeline's own id -- and going
      // around it is also what keeps a timeline edit off the session's
      // word-attribution path, which only ever sees the editor's own
      // onChange (which a hidden, untouched ProseMirror view never fires).
      onTimelineDoc: (itemId, body) => {
        timelineMount?.destroy();
        editor.setHidden(true);
        timelineMount = mountTimeline({
          container: editorEl,
          diagnostics: deps.diagnostics === true,
          body,
          onDirty: (b) => flusher.markDirty(itemId, b),
          canEdit: () => !historyOperationInFlight && !historyReconcileFailed && !projectDestroyed && !projectLeaving &&
            !sourceCommandInFlight && !undoInFlight && !reviewDecisionInFlight && !reviewOpenInFlight && !reviewTransportInFlight,
          openScene: (sceneId) => {
            void openDocument?.(sceneId).catch((err: unknown) => {
              raiseNotice(t("project.error.open-document", { error: String(err) }));
            });
          },
          cast: () => castMembers,
          items: () => liveItemsIn(outline?.items() ?? latestItems),
          onNotice: raiseNotice,
          onDone: announce,
          // NOT onType: chrome-fade's own mousemove listener wakes on
          // every pointer move in the SAME dispatch, so calling onType per
          // event would arm and immediately undo itself. The view already
          // debounces this to "the pointer has actually stopped for a
          // while" before calling it -- onPointerStill is the arm that
          // needs no focus check, design section 4's own reason a
          // timeline's chrome fade keys off stillness rather than typing.
          onActivity: () => chromeFade?.onPointerStill(),
        });
      },
    });
    sceneNotes = createSceneNotes(document.body, () => {
      const panel = comments;
      if (panel === null) return;
      void panel.open("list").catch((err: unknown) => {
        raiseNotice(t("comments.error.read", { error: String(err) }));
      });
    });
    // The open scene's notes, into the editor that draws them.
    //
    // SWALLOWS ITS OWN FAILURE with a banner and no throw: a scene whose notes
    // could not be read is still a scene the writer can write in, and turning a
    // comment listing into a failed document open would be the larger loss.
    loadComments = async (itemId: string): Promise<void> => {
      if (invoke === undefined) return;
      try {
        const listed = (await invoke("comment_list", { itemId })) as CommentRow[];
        // The document may have moved on while this was in flight. Anchors for
        // the wrong scene would underline whatever prose happens to sit at
        // those positions, which is the one failure this feature must not have.
        if (projectDestroyed || session?.activeDocId() !== itemId) return;
        editor.setCommentAnchors(
          listed.map((row) => ({
            id: row.id,
            from: row.anchor_from,
            to: row.anchor_to,
            resolved: row.resolved,
          })),
        );
        updateSceneNotes(itemId, listed);
      } catch (err: unknown) {
        if (!projectDestroyed) raiseNotice(t("comments.error.read", { error: String(err) }));
      }
    };
    void loadComments(activeDocId);

    const open = createDocumentOpener({
      session,
      typeOf,
      markOpen: (itemId) => {
        if (typeOf(itemId) === "scene") continuousChapter?.activeChanged(itemId);
        else continuousChapter?.exit();
        navigator.setOpen(itemId);
        paintSceneName(itemId);
        // ON ACTIVATION, and only here. markOpen is the success path of an
        // actual switch - the "same" and "busy" outcomes never reach it - so
        // this is exactly "a document opened". A selection change is not: the
        // navigator moves it on every arrow key, and the synthetic workload
        // drives that directly tens of thousands of times a soak.
        //
        // A back or forward navigation also comes through here, and records
        // nothing: navHistory is already standing on the entry it just returned.
        navHistory.record(itemId);
        // The new scene has no established note count until its own read
        // succeeds. Clearing before that read prevents the outgoing count from
        // being actionable during the switch.
        sceneNotes?.clear();
        // EVERYTHING BELOW IS PROSE-ONLY. A timeline has no scene word
        // count, no comment anchors and no cast marks -- `sessionEditor`'s
        // own `onTimelineDoc` branch is what actually mounted it, and
        // reaching any of these three would either read the HIDDEN
        // ProseMirror doc's stale state (word count, cast marks) or cost a
        // round trip for a document type comment_list already refuses
        // (comments). `markOpen`'s three lines above still ran: the row is
        // marked open, the header names it, and it is reachable by Back.
        if (typeOf(itemId) === TIMELINE_TYPE) return;
        // The scene figure belongs to the OPEN document, and a switch reaches
        // the editor through replaceDoc, which uses updateState specifically so
        // no onChange fires. onChange is the only other thing that repaints the
        // figure, so without this the bar keeps the previous scene's number
        // until the writer types - and a writer who opens a scene to read it
        // never sees a correct one. Here rather than beside navigator.setOpen's
        // boot call because this is the success path of every switch; the boot
        // figure is correct already, since createWordCount reads sceneWords()
        // when it mounts. `wordCount` is still the mutable let the assembly
        // cycle needs: this closure runs on activation, long after it is set.
        //
        // NOW, bypassing the keystroke throttle. A switch is not a keystroke:
        // it happens once, and it is the moment the figure stops being about
        // the scene it names. Left to the throttle, a switch landing inside an
        // open window would show the OUTGOING scene's number under the
        // incoming document until the window closed.
        wordCount?.refreshSceneNow();
        // The incoming scene's notes. `replaceDoc` builds a fresh EditorState,
        // so the plugin's anchors are empty and the marks belong to nobody
        // until this lands - which is why it is here rather than only when the
        // panel opens: the underlines are the surface a writer sees WITHOUT
        // asking, and a scene that opened with none of them says there are none.
        //
        // Not awaited, for the same reason the count refresh above is not: the
        // prose is what the writer is waiting for.
        void loadComments(itemId);
        // `replaceDoc` builds a fresh EditorState, so the cast-marks plugin
        // re-inits with an empty names list too - the same defect as the
        // comment anchors above, and without this line every scene switch
        // silently turns the marks, the card and Ctrl+Shift+I off for the
        // rest of the session, since nothing else ever calls setCastNames
        // again after the initial load.
        editor.setCastNames(namesForCast(castMembers));
      },
      // A timeline is its own pane's content, not the ProseMirror editor:
      // focus goes wherever the writer can actually type or press
      // something, which `timelineMount.focus()` puts on the first event.
      focusEditor: () => (timelineMount !== null ? timelineMount.focus() : editor.focus()),
      onFailure: (message) => raiseNotice(t("project.error.open-document", { error: message })),
    });
    openDocument = async (itemId: string): Promise<void> => {
      if (undoInFlight || sourceCommandInFlight || historyOperationInFlight || reviewDecisionInFlight || reviewOpenInFlight || reviewTransportInFlight || projectLeaving) return;
      if (outlineView?.mode() !== "manuscript" && isOpenableType(latestItems.find((item) => item.id === itemId)?.type ?? "")) {
        showManuscript();
      }
      inflightOpens += 1;
      try {
        await open(itemId);
      } finally {
        inflightOpens -= 1;
      }
    };
    // ONE IMMEDIATE READ at mount, so a manuscript opens with its figures rather
  // than four seconds of blank counts. Not awaited: the walk and the first
  // document are what the writer is waiting for, and a figure that arrives a
  // moment later is a figure, not a delay.
  void refreshCounts();
  void refreshSynopses();
  void refreshAppearanceMarks();

  // Open with the open document selected and marked, rather than with row 0
    // selected and nothing marked. This scrolls the pane when the first scene
    // sits below the fold, which moves the mounted-row count - expected, and
    // the reason the hierarchy run is re-recorded for this slice.
    navigator.selectById(activeDocId);
    navigator.setOpen(activeDocId);
    paintSceneName(activeDocId);
    // The boot document is the trail's first entry. It does not go through
    // markOpen - nothing switched, the page opened it - so without this the
    // first Back after one jump would find an empty trail and the scene the
    // writer started in would be unreachable by the feature that exists to
    // return them to it.
    navHistory.record(activeDocId);
  }

  // The store is the single source of tree truth: every mutation is
  // command -> project_items -> navigator.reload, and the page neither patches
  // its own walk nor computes a position nor caches a revision.
  let renamePanel: RenamePanel | null = null;
  // Which row the keyboard is on. Read live, never captured: the writer moves
  // the selection between opening the bar and pressing a button.
  //
  // Declared out here rather than inside the block below because the
  // application menu reads it too, through menuActions, and it depends on
  // nothing but the navigator.
  const selectedId = (): string | null =>
    navigator.rows()[navigator.activeIndex()]?.id ?? null;
  const creationChooser = createCreationChooser({
    create: (type) => { void outline?.create(type).catch(() => undefined); },
    matter: (kind) => { void outline?.createMatter(kind).catch(() => undefined); },
    returnFocus: () => {
      if (navEl.getClientRects().length > 0) navEl.focus();
      else if ((outlineView?.mode() ?? "manuscript") !== "manuscript") outlineView?.element.querySelector<HTMLElement>("h1")?.focus();
      else if (timelineMount !== null) timelineMount.focus();
      else editor.focus();
    },
    bible: () => {
      const selected = selectedId();
      const root = latestItems.find((item) => item.parent_id === null && item.type === BIBLE_TYPE);
      const parent = root === undefined ? undefined : latestItems.find((item) =>
        item.id === bibleParentFor(latestItems, selected, root.id));
      const anchor = parent?.id ?? null;
      return {
        destination: parent?.title ?? t("outline.bible-title"),
        entry: () => { void outline?.createNote(anchor).catch(() => undefined); },
        folder: () => { void outline?.createBibleFolder(anchor).catch(() => undefined); },
        timeline: () => { void outline?.createTimeline(anchor).catch(() => undefined); },
      };
    },
  });
  const bibleCreate = createBibleCreateControl(navEl, () => creationChooser.open(true));
  /** What the Outline menu's one context item is currently OFFERING.
   *
   *  Held rather than re-derived when the item runs, so the action taken is the
   *  one the writer READ: the label is painted from `selectedTrashed`, and a
   *  selection change between that paint and the click would otherwise turn a
   *  Restore into a Delete. Inherited from the outline bar, which held the same
   *  answer for the same reason before it was retired. */
  let offering: "delete" | "restore" = "delete";
  const sectionMovePrompt = createSectionMovePrompt(document.body);
  {
    const unit = createOutline({
      generation: deps.generation,
      canMutate: () => !projectDestroyed && !projectLeaving && !historyOperationInFlight && !deps.privacyLocked?.(),
      invoke,
      confirmSectionMove: (title, change) => sectionMovePrompt.open(title, change),
      // The walk loadStoreSource already read. Calling refresh() here instead
      // would re-read 20,060 rows at the stress fixture for no new information.
      initialItems: storeItems,
      reload: (items) => {
        // BEFORE the bar is told to re-read. The outline unit hands the new
        // walk over here and commits it to its own field only afterwards, so
        // asking the unit would answer about the tree that was on screen a
        // moment ago - which painted "Delete" on a row that had just been
        // deleted. Only the graded run could see that; every unit test passed.
        latestItems = items;
        craftPanel?.invalidateAll();
        continuousChapter?.setItems(items);
        referenceRail?.setItems(liveItemsIn(items));
        // Removing the open scene moves it under the bin without opening a
        // replacement document, so markOpen never runs. Its old count must not
        // remain as a route into a scene that is no longer live.
        const openId = session?.activeDocId();
        if (openId !== undefined && !liveItemsIn(items).some((item) => item.id === openId)) {
          sceneNotes?.clear();
        }
        navigator.reload(storeSourceFrom(readingOrderItems(items), deps.seed));
        outlineView?.setItems(items);
        // The ONE place the header follows a rename. Every route to one - the
        // rename panel from the menu or the row's context menu - ends in the
        // unit's rename, and the unit re-reads on both of its outcomes, so a
        // repaint here covers each route and a rename that failed after the
        // store took it. Painting from the panel's callback instead would
        // show the title the writer typed before the store confirmed it.
        paintSceneName(session?.activeDocId());
        // A mutation can create a scene, and a created scene carries a document
        // row, so the project total the store would answer with is no longer
        // the one on screen. Fired from the re-read rather than from each
        // command so a failed mutation that nonetheless committed is covered
        // too - the outline re-reads on both paths.
        void wordCount?.refreshProject();
        // The tree's SHAPE changed, so a container's roll-up did too even if no
        // document did. Same debounce: a held Alt+Arrow is a burst of these.
        scheduleCountRefresh();
      },
      selectedId,
      // The selection FOLLOWS a created row. Placement is relative to the
      // selection, so a selection that stays put makes every create land in the
      // same slot and three creates come out in reverse order -- measured on a
      // live window, and the reason this dep exists at all.
      //
      // Then OPEN it, through the same opener a click takes, so the trail, the
      // flush of the previous document and the focus move are the click's.
      // Owner's call of 2026-09-01, reversing the 2026-08-28 stance that a
      // create must not swap the document: pressing New scene and then typing
      // wrote into the PREVIOUS scene, and every writer who tried it read that
      // as a defect. A chapter or part is not openable and stays selected only,
      // by the opener's own rule.
      onCreated: (id) => {
        navigator.selectById(id);
        void openDocument?.(id);
      },
      // NOT raiseFailure. That latches, so one refused rename would suppress
      // the banner for every genuine autosave failure after it - and a failed
      // outline edit is not a failed save: nothing was lost, and the tree the
      // writer is looking at has already been re-read from the store.
      onFailure: raiseNotice,
      // The name eleven other units use for "a background act finished and
      // the writer should hear about it" - "Undone: moving s2." is that class
      // of banner, not a failure.
      onDone: announce,
    });
    outline = unit;
    moveItem = (itemId, direction, count = 1) => {
      // The navigator's listener is synchronous and the outline is not; an
      // unhandled rejection here would never reach the sink. The unit reports
      // its own failures through onFailure. The outcome is handed back for the
      // outline view's drag, which announces only a run that moved something.
      // A drag's run is ONE undo entry, so it goes through moveBy.
      const moved = count === 1 ? unit.move(itemId, direction) : unit.moveBy(itemId, direction, count);
      return moved.catch(() => "failed" as const);
    };
    undoItem = () => {
      void unit.undo().catch(() => undefined);
    };
    redoItem = () => {
      void unit.redo().catch(() => undefined);
    };
    removeItem = (itemId) => {
      // Same reason as moveItem: a synchronous listener calling into an async
      // unit that reports its own failures.
      void unit.remove(itemId).catch(() => undefined);
    };
    renamePanel = createRenamePanel({
      container: renameEl,
      rename: (id, title) => unit.rename(id, title),
      // #nav, never the row: the tree is an aria-activedescendant surface and a
      // row is not a tab stop, so `.focus()` on one drops focus to <body>.
      returnFocus: () => navEl.focus(),
    });
  }

  function showManuscript(): void {
    continuousChapter?.exit();
    outlineViewTransitions?.returnToEditor();
  }

  outlineView = createOutlineView({
    editor: editorPane,
    items: latestItems,
    readSynopses: async (ids) => invoke === undefined ? [] : await invoke("synopsis_batch", { ids }) as { item_id: string; body: string }[],
    readDocument: async (id) => (await invoke("doc_load", { itemId: id })) as { body: string; rev: number },
    onSelect: (id) => navigator.revealAndSelectById?.(id),
    onOpen: (id) => { navigator.revealAndSelectById?.(id); showManuscript(); void openDocument?.(id); },
    onMove: (id, direction, count) => moveItem?.(id, direction, count),
    onUndo: () => undoItem?.(),
    onRedo: () => redoItem?.(),
    onReturn: showManuscript,
    onAnnounce: announce,
    onRefuse: raiseNotice,
    onError: (error) => raiseNotice(t("outline-view.synopsis-error", { error: String(error) })),
  });
  outlineView.setCounts(outlineCounts);
  outlineView.selectById(navigator.rows()[navigator.activeIndex()]?.id ?? null);
  outlineViewTransitions = createOutlineViewTransitions({
    mode: () => outlineView?.mode() ?? "manuscript",
    drain: () => flusher.drain(),
    failed: () => flusher.failed() || persistError !== null || projectDestroyed,
    show: (mode) => { continuousChapter?.exit(); editorPane.hidden = true; outlineView?.show(mode); },
    returnToEditor: () => { outlineView?.hide(); editorPane.hidden = false; if (timelineMount !== null) timelineMount.focus(); else editor.focus(); },
  });

  const pmElement = editorEl.querySelector<HTMLElement>(".ProseMirror");
  const sceneHeading = editorEl.querySelector<HTMLElement>("#scene-heading");
  if (pmElement === null || sceneHeading === null) throw new Error("continuous chapter needs the existing prose editor and heading");
  continuousChapter = createContinuousChapter({
    heading: sceneHeading, editor: pmElement, items: latestItems,
    activeId: () => session?.activeDocId() ?? "",
    readDocument: async (id) => (await invoke("doc_load", { itemId: id })) as { body: string; rev: number },
    activate: async (id) => { await openDocument?.(id); },
    onReturn: showManuscript,
    onError: (error) => raiseNotice(t("continuous.error", { error: String(error) })),
  });

  {
    wordCount = createWordCount({
      container: countEl,
      goalBar: goalBarEl,
      sceneWords: () => editor.wordCount(),
      // The figure this view just computed, attributed to the document it is
      // about. Keyed by id, so a switch cannot read the incoming scene's length
      // as words written into the outgoing one.
      onSceneWords: (count) => {
        const id = session?.activeDocId();
        if (id !== undefined) sessionWords.observe(id, count);
      },
      dailyTarget: deps.dailyTarget?.() ?? DEFAULT_DAILY_TARGET,
      // The DATE IS THE PAGE'S, computed per call rather than at mount: a
      // window left open overnight would otherwise go on reporting yesterday
      // forever, and the whole point of asking per flush is that the day turns
      // under a writer who never closed the application.
      //
      projectProgress: async () =>
        (await invoke("project_progress", {
          today: localDate(new Date()),
        })) as { total: number; today: number | null; collecting: boolean },
    });
    // Not awaited: the count is informational, and a mount that waited on it
    // would hold the page open on a scan of every document in the manuscript.
    void wordCount.refreshProject();
    // THE OPEN DOCUMENT'S BASELINE, at mount. `refreshCounts` deliberately skips
    // it, and `createWordCount` reads `sceneWords()` in its initializer rather
    // than through the painting path, so without this line the open scene has no
    // baseline until its first repaint - and the words that repaint was
    // triggered by would be charged to this session as though somebody had just
    // written them.
    const openAtMount = session?.activeDocId();
    if (openAtMount !== undefined) sessionWords.observe(openAtMount, editor.wordCount());
  }

  // Opened on `flusher.saveState()` rather than on `"saved"`: the scheduler is
  // built before this and a project mounted with work already dirty would
  // otherwise be drawn as saved until the next transition.
  if (saveEl !== null && flusher !== null) {
    saveIndicator = createSaveIndicator({
      container: saveEl,
      initial: flusher.saveState(),
    });
  }

  // The second copy, and how old it is. Same conditions as the save indicator,
  // plus a host to ask.
  //
  // NOT AWAITED at mount. The first answer is one round trip away and holding
  // the page open on a status read would put a directory listing in front of
  // the writer's manuscript; the element opens on the negative until it lands.
  // The dot is mounted even where the indicators below are not (the
  // measurement run has no host to ask): with nothing reported it stays amber,
  // which is the honest answer about copies nobody has checked.
  let mirrorChanges: MirrorChanges | null = null;
  const statusDot: StatusDot = createStatusDot({
    container: statusEl,
    popover: popoverEl,
    openChanges: invoke === undefined || flusher === null
      ? undefined
      : () => void mirrorChanges?.setOpen(true),
    // The same units the menus and the project panel call. Each reports its
    // own outcome through the notice channels, so nothing here awaits.
    backupNow: invoke === undefined ? undefined : () => void recoveryIndicator?.backupNow(),
    makeArchive: invoke === undefined ? undefined : () => void archiveIndicator?.archiveNow(),
    openMirrorSetup: invoke === undefined ? undefined : deps.openProjectPanel,
  });

  let recoveryIndicator: RecoveryIndicator | null = null;
  if (recoveryEl !== null && invoke !== undefined) {
    recoveryIndicator = createRecoveryIndicator({
      container: recoveryEl,
      onState: (state) => statusDot.report("recovery", state),
      status: async () => (await invoke("recovery_status")) as RecoveryReport,
      backup: () => invoke("project_backup_now"),
      // The host emits on both outcomes of every attempt, scheduled or manual.
      // No payload: the files are the source of truth and the page re-reads
      // them, rather than trusting a payload that can disagree with them.
      subscribe:
        deps.listen === undefined
          ? undefined
          : (cb) => (deps.listen as NonNullable<MountDeps["listen"]>)(RECOVERY_EVENT, cb),
      onDone: announce,
      // NOT raiseFailure. That latches persistError, so one failed backup would
      // suppress the banner for a genuine autosave failure afterwards - and a
      // failed backup is not a failed save: the manuscript is untouched.
      onNotice: raiseNotice,
    });
    void recoveryIndicator.refresh();
  }

  // The copy that could leave this computer. Same conditions, same reasons, and
  // deliberately a SECOND unit rather than a second state on the one above:
  // they describe two different files with two different promises, and the
  // design's section 6 forbids a surface that blurs them.
  let archiveIndicator: ArchiveIndicator | null = null;
  if (archiveEl !== null && invoke !== undefined) {
    archiveIndicator = createArchiveIndicator({
      container: archiveEl,
      onState: (state) => statusDot.report("archive", state),
      status: async () => (await invoke("archive_status")) as ArchiveReport,
      archive: async () => {
        if (projectDestroyed || session === null || flusher === null) throw new Error(t("archive.error.closed"));
        await session.flushPending();
        if (flusher.failed() || persistError !== null) throw new Error(t("archive.error.unsaved"));
        if (projectDestroyed) throw new Error(t("archive.error.changed"));
        return (await invoke("project_archive_now", { generation: deps.generation })) as Archive;
      },
      // `archives/` sits inside the directory this event describes, so the host
      // emits on an archive too. No payload: the files are the source of truth.
      subscribe:
        deps.listen === undefined
          ? undefined
          : (cb) => (deps.listen as NonNullable<MountDeps["listen"]>)(RECOVERY_EVENT, cb),
      onDone: announce,
      // NOT raiseFailure: a failed save is already latched, while an archive
      // failure must not latch a second save failure.
      onNotice: raiseNotice,
    });
    void archiveIndicator.refresh();
  }

  // The bar's currency statement. A THIRD unit rather than a state on either of
  // the two above, and the separation is the design's section 6 argument
  // applied one step further: those two describe copies that exist to survive
  // something, and this describes a projection that survives nothing. A surface
  // that blurred them would let a writer read "current" as "safe".
  let mirrorIndicator: MirrorIndicator | null = null;
  if (invoke !== undefined) {
    mirrorIndicator = createMirrorIndicator({
      container: mirrorEl,
      onState: (state) => statusDot.report("mirror", state),
      status: async () => (await invoke("mirror_status")) as MirrorReport,
      subscribe:
        deps.listen === undefined
          ? undefined
          : (cb) => (deps.listen as NonNullable<MountDeps["listen"]>)(MIRROR_EVENT, cb),
    });
    void mirrorIndicator.refresh();
  }

  // The flusher is what makes the export "as saved" mean "as the writer sees
  // it", so the command exists only where there is one to drain. On the store
  // path there always is - it is built above from the same two conditions.
  async function drainForPublishing(kind: "export" | "preview"): Promise<void> {
    const unavailable = (): boolean => projectDestroyed || projectLeaving || (deps.privacyLocked?.() ?? false);
    if (unavailable()) throw new Error(t("publishing.error.unavailable"));
    await flusher.drain();
    if (flusher.failed() || persistError !== null) throw new Error(t(`${kind}.error.unsaved`));
    if (unavailable()) throw new Error(t("publishing.error.unavailable"));
  }

  let exportBar: ExportBar | null = null;
  if (invoke !== undefined && flusher !== null) {
    exportBar = createExportBar({
      drain: () => drainForPublishing("export"),
      // The host writes Markdown and says so; the page does not tell it which
      // format to write, because there is only one command. When a
      // second is added, the format the bar was asked for is what chooses the command.
      exportProject: async () => (await invoke("project_export")) as ExportWritten,
      // The host returns null when the writer cancelled. It is carried through
      // as null rather than mapped to an error, because it is not one.
      // THE FORMAT IS AN ARGUMENT NOW, and it is the one the design record
      // said would arrive: a word out of a narrow enum this build owns, which
      // the host refuses if it does not know it. Nothing about the export
      // slice's refusal of a page-named PATH is weakened by naming which of two
      // renderers to run.
      exportProjectAs: async (format) =>
        (await invoke("project_export_as", { format })) as ExportWritten | null,
      // NOT raiseFailure. That latches persistError, so one failed export would
      // suppress the banner for every genuine autosave failure after it - and a
      // failed export is not a failed save: the manuscript is untouched.
      onNotice: raiseNotice,
      onDone: announce,
    });
  }

  /** Put the open document back in step with the store, and refresh every
   *  figure that describes it.
   *
   *  For the two operations that rewrite documents the page is not editing: a
   *  snapshot restore and a manuscript-wide replace. Both bump revisions in the
   *  host, so a scheduler still holding the old one would refuse the writer's
   *  very next keystroke as a Conflict; and both change the open scene's body
   *  underneath the editor, which `replaceDoc` swaps WITHOUT firing onChange -
   *  so nothing else repaints the figures.
   *
   *  A function declaration rather than a const, so both call sites can reach
   *  it whichever of them the assembly cycle builds first.
   */
  async function reloadOpenDocument(strict = false): Promise<void> {
    if (invoke === undefined || session === null || flusher === null) return;
    continuousChapter?.sourceChanged();
    const itemId = session.activeDocId();
    const doc = (await invoke("doc_load", { itemId })) as { body: string; rev: number };
    if (projectDestroyed) return;
    if (session.activeDocId() !== itemId) {
      if (strict) throw new Error(t("history.error.changed"));
      return;
    }
    if (strict && !Number.isSafeInteger(doc.rev)) throw new Error(t("project.error.unreadable-body", { item: itemId }));
    // A TIMELINE'S BODY IS NEVER READABLE-AS-PROSE, and reaching
    // readableBody with one raised a false "could not be read" for every
    // snapshot restore or mirror accept that touched an open timeline, AND
    // skipped flusher.register below -- so the scheduler kept the PRE-
    // restore rev and refused the writer's very next edit as a Conflict,
    // even though the host had already written the restore. Registered
    // FIRST, unconditionally, exactly as the prose branch does after its own
    // read succeeds: this is the fix for that half, not an afterthought.
    if (typeOf(itemId) === TIMELINE_TYPE) {
      if (strict) {
        const parsed = parseTimeline(doc.body);
        if ("invalid" in parsed || "newer" in parsed) throw new Error(t("project.error.unreadable-body", { item: itemId }));
      }
      flusher.register(itemId, doc.rev);
      timelineMount?.setBody(doc.body);
      return;
    }
    // Same question as the mount asks, and a REPORT rather than a throw: this
    // runs after a restore and after a manuscript-wide replace, where an
    // exception would be an unhandled rejection and nothing on screen at all.
    // The open document is left exactly as it was, which is the only safe
    // answer: an editor holding a document it could not read would write
    // whatever it managed to keep over the writer's scene on the first
    // keystroke.
    const json = readableBody(doc.body);
    if (json === null) {
      if (strict) throw new Error(t("project.error.unreadable-body", { item: itemId }));
      raiseNotice(t("project.error.unreadable-body", { item: itemId }));
      return;
    }
    editor.replaceDoc({ kind: "pmjson", json });
    flusher.register(itemId, doc.rev);
    // `replaceDoc` builds a fresh EditorState, so the comment plugin's anchors
    // are gone - the same reason an activation reloads them. Without this the
    // underlines vanish until the writer switches scenes and back, and the
    // store has just collapsed the anchors of a restored body, so this is also
    // how the writer is told which notes their restore orphaned.
    if (strict) await loadComments(itemId);
    else void loadComments(itemId);
    if (projectDestroyed) return;
    // Same fresh EditorState, same empty names list until this runs: a
    // restore or a manuscript-wide replace must not leave the marks off for
    // whatever the writer opens next.
    editor.setCastNames(namesForCast(castMembers));
    wordCount?.refreshProject();
    wordCount?.refreshSceneNow();
    await refreshCounts();
  }

  // Same conditions as the export command, and for the same reason: search
  // reads the store, and "as saved" is only equal to what the writer sees
  // because there is a scheduler to drain.
  let findBar: FindBar | null = null;
  if (invoke !== undefined && findEl !== null && flusher !== null) {
    findBar = createFindBar({
      container: findEl,
      // Back to the manuscript. The panel used to hand focus to the Find button
      // beside it; with that button retired there is nowhere in the bar to go,
      // and <body> is not an answer - a writer who pressed Escape wants to
      // write, not to be nowhere.
      onDismiss: () => editor.focus(),
      // Straight onto the editor, so a replacement is an ordinary transaction:
      // it lands in the undo history that is already there and the flush
      // scheduler persists it by the same path as typing. The scope is the open
      // scene and nothing wider -- see replace.ts.
      replaceMatch: (query, replacement) => timelineMount === null && editor.replaceMatch(query, replacement),
      replaceAll: (query, replacement) => timelineMount === null
        ? editor.replaceAll(query, replacement)
        : { replaced: 0, spanning: 0 },
      // THE WHOLE MANUSCRIPT, in the host, behind a second confirming press.
      // This was refused earlier because it had no inverse; the host takes a named
      // snapshot of every document in the same transaction, which is the
      // inverse, and the report names it so the writer can find it.
      replaceEverywhere: async (query, replacement) => {
        if (projectDestroyed || projectLeaving || outline?.busy() || historyOperationInFlight || historyReconcileFailed || reviewReconcileFailed ||
            sourceCommandInFlight || undoInFlight || reviewDecisionInFlight || reviewOpenInFlight || reviewTransportInFlight ||
            inflightOpens > 0 || reviewPanel?.busy() || deps.privacyLocked?.()) throw new Error(t("history.error.busy"));
        historyOperationInFlight = true;
        editor.setEditable(false);
        timelineMount?.setEditable(false);
        try {
          await flusher.drain();
          if (flusher.failed() || persistError !== null) throw new Error(t("find.error.unsaved"));
          if (projectDestroyed || projectLeaving || deps.privacyLocked?.()) throw new Error(t("history.error.busy"));
          const report = (await invoke("project_replace", { query, replacement })) as {
            replaced: number;
            spanning: number;
            documents: number;
            snapshot: { label: string };
          };
          if (report.documents > 0) { referenceRail?.invalidateAll(); craftPanel?.invalidateAll(); continuousChapter?.sourceChanged(); }
          try {
            await reloadOpenDocument(true);
          } catch (error) {
            historyReconcileFailed = true;
            throw new Error(t("history.error.reconcile"), { cause: error });
          }
          return report;
        } finally {
          historyOperationInFlight = false;
          if (!projectDestroyed && !projectLeaving && !historyReconcileFailed && !reviewReconcileFailed) {
            editor.setEditable(true);
            timelineMount?.setEditable(true);
          }
        }
      },
      drain: () => flusher.drain(),
      find: async (query, limit) =>
        (await invoke("project_find", { query, limit })) as FindResults,
      // Straight through the navigator's own activation path rather than a
      // second opener: everything already true about opening -- the fixed
      // order in session.switchTo, the undo scope, the word-count refresh --
      // stays true and is not restated here.
      openItem: (itemId, query) => {
        navigator.selectById(itemId);
        void openDocument?.(itemId)
          .then(() => {
            // AFTER the open resolves, so the document being searched is the
            // one now in the editor. A reveal fired alongside the open would
            // race it and, on the losing side, select a word in the scene the
            // writer was leaving.
            //
            // The return value is deliberately dropped. A miss is not something
            // to tell the writer about: they asked to go to a scene and they
            // are in that scene, with the caret where it was.
            editor.revealMatch(query);
          })
          .catch((err: unknown) => {
            raiseNotice(t("project.error.open-document", { error: String(err) }));
          });
      },
      // A part or a chapter holds no document. Selecting is the whole of what
      // can honestly happen, and it is more than hiding the row would be.
      selectItem: (itemId) => navigator.selectById(itemId),
      // NOT raiseFailure, which latches: a failed search is not a failed save.
      onNotice: raiseNotice,
      onDone: announce,
    });
  }

  // Ctrl+P.
  let quickOpen: QuickOpen | null = null;
  const quickOpenEl = document.getElementById("quick-open-controls");
  if (quickOpenEl === null) {
    throw new Error("page shell is missing #quick-open-controls: index.html and project.ts disagree");
  }
  {
    quickOpen = createQuickOpen({
      container: quickOpenEl,
      // The LIVE walk, never a boot snapshot - the same rule `typeOf` follows
      // above, and for the same reason: a scene created a moment ago exists in
      // the outline's walk and nowhere else, and a panel that cannot reach it
      // is a panel that silently forgets what the writer just made.
      //
      // FILTERED, because the raw walk includes the Trash root and everything
      // the writer has deleted, indistinguishable from live rows. The host
      // already excludes them from search, export and the word count by deriving
      // the set from the walk; this is the same rule applied to the one surface
      // the page filters itself.
      items: () => liveItemsIn(outline?.items() ?? latestItems),
      openItem: (itemId) => {
        void openDocument?.(itemId).catch((err: unknown) => {
          raiseNotice(t("project.error.open-document", { error: String(err) }));
        });
      },
      selectItem: (itemId) => navigator.selectById(itemId),
      onDismiss: () => editor.focus(),
    });
  }

  // THE SCENE'S NAME OPENS GO TO. Ctrl+P was reachable only from the
  // Outline menu and Help; the name of where the writer is, is where a writer
  // clicks to go somewhere else. Its own text stays its accessible name; the
  // tip says what a press does and names the chord, on hover and on focus.
  const onSceneNameClick = (): void => quickOpen?.open();
  sceneNameEl.addEventListener("click", onSceneNameClick);
  sceneNameEl.setAttribute("aria-keyshortcuts", t("menu.shortcut.go-to"));
  const sceneNameSlot = sceneNameEl.nextSibling;
  const sceneNameParent = sceneNameEl.parentElement;
  const sceneNameTip = createTooltip({
    control: sceneNameEl,
    name: t("menu.go-to"),
    hint: t("menu.shortcut.go-to"),
  });
  sceneNameParent?.insertBefore(sceneNameTip.anchor, sceneNameSlot);

  /** Every scene the trail could still take the writer to.
   *
   *  The LIVE walk, filtered, on EVERY navigation - the same rule quick open and
   *  `typeOf` follow. A boot snapshot forgets what the writer has made since,
   *  and the raw walk carries the Trash root and everything under it, which is
   *  indistinguishable from a live row.
   *
   *  DELIBERATELY NOT ALSO FILTERED TO SCENES. Only a scene can be on the trail
   *  in the first place - `record` is called from the opener's success path,
   *  which never fires for a part or a chapter - so a type filter here is a
   *  clause no input can reach, and a reader would credit it for a refusal
   *  nothing performs. */
  const openableIds = (): ReadonlySet<string> => {
    const ids = new Set<string>();
    for (const item of liveItemsIn(outline?.items() ?? latestItems)) ids.add(item.id);
    return ids;
  };

  function goHistory(direction: "back" | "forward"): void {
    const live = openableIds();
    const target = direction === "back" ? navHistory.back(live) : navHistory.forward(live);
    if (target === null) {
      // SAID, not silent. A chord and a menu item that both appear to work and
      // do nothing teach a writer the feature is broken; this is the honest
      // answer, in the info tone, and it goes away on its own.
      inform(direction === "back" ? t("nav.history.no-back") : t("nav.history.no-forward"));
      return;
    }
    // The selection moves first, for the reason quick open records: every
    // selection-driven command - Delete, a create, Alt+Arrow - acts on the row
    // the keyboard is on, so a jump that moved the open document and not the
    // selection would leave them pointing at the scene the writer left.
    navigator.selectById(target);
    void openDocument?.(target).catch((err: unknown) => {
      raiseNotice(t("project.error.open-document", { error: String(err) }));
    });
  }

  /** Alt+Left / Alt+Right, on the DOCUMENT.
   *
   *  On the document for the reasons Ctrl+F and Ctrl+P are: the editor's keymap
   *  only fires while the editor holds focus, and `navigator.handleKey` is
   *  driven directly by the synthetic workload.
   *
   *  THE NAVIGATOR ALSO BINDS THESE TWO, to outdent and indent, and has since
   *  the outline slice. It takes them with preventDefault while the outline has
   *  focus, and `historyChordOf` refuses an event whose default is already
   *  prevented - so the outline keeps its structural chords and everywhere else
   *  gets the browser-conventional pair. The explicit #nav check below is the
   *  same rule stated once more for the case the navigator declines to move a
   *  row at all (an empty tree), where it prevents nothing and the trail would
   *  otherwise answer a keystroke aimed at the outline. */
  const onHistoryChord = (event: Event): void => {
    if (!(event instanceof KeyboardEvent) || isCompositionKey(event)) return;
    const direction = historyChordOf(event);
    if (direction === null) return;
    const target = event.target;
    if (target instanceof Element) {
      if (target.closest("#nav") !== null) return;
      // A text field and any open panel keep their own keys: Alt+Left in a
      // rename field or a find query is caret movement, and taking the writer
      // to another scene from under a panel they are typing in is not what they
      // asked for. `contenteditable` is deliberately NOT excluded - the prose is
      // where the writer is, and it is the whole point of the chord.
      if (target.closest("input, textarea, [role='dialog']") !== null) return;
    }
    event.preventDefault();
    goHistory(direction);
  };
  document.addEventListener("keydown", onHistoryChord);

  // Ctrl+E: File > Export manuscript (Markdown), the one export a writer
  // repeats. On the document for Ctrl+P's reasons. Everywhere, the prose and a
  // text field included: no field here has its own Ctrl+E, and the export
  // drains first, so a keystroke typed just before is in the file.
  const onExportChord = (event: Event): void => {
    if (!(event instanceof KeyboardEvent) || isCompositionKey(event)) return;
    if (event.key !== "e" && event.key !== "E") return;
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    event.preventDefault();
    exportBar?.run("markdown");
  };
  document.addEventListener("keydown", onExportChord);

  // Version history.
  // The readable folder's change set. Mounted whether or not the mirror is on
  // for this project: the host answers an empty list when it is off, and a
  // panel that only existed for mirrored projects would make the menu item
  // appear and disappear.
  const mirrorChangesEl = document.getElementById("mirror-changes-controls");
  if (mirrorChangesEl === null) {
    throw new Error(
      "page shell is missing #mirror-changes-controls: index.html and project.ts disagree",
    );
  }
  mirrorChanges = createMirrorChanges({
    container: mirrorChangesEl,
    changes: async () => (await invoke("mirror_changes")) as MirrorChangeRow[],
    drain: async () => {
      await flusher.drain();
      if (flusher.failed() || persistError !== null) throw new Error(t("mirror.changes.accept.error.unsaved"));
      if (projectDestroyed || projectLeaving || deps.privacyLocked?.()) throw new Error(t("history.error.busy"));
    },
    withOperation: async (operation) => {
      if (projectDestroyed || projectLeaving || outline?.busy() || historyOperationInFlight || historyReconcileFailed || reviewReconcileFailed ||
          sourceCommandInFlight || undoInFlight || reviewDecisionInFlight || reviewOpenInFlight || reviewTransportInFlight ||
          inflightOpens > 0 || reviewPanel?.busy() || deps.privacyLocked?.()) throw new Error(t("history.error.busy"));
      historyOperationInFlight = true;
      editor.setEditable(false);
      timelineMount?.setEditable(false);
      try {
        return await operation();
      } finally {
        historyOperationInFlight = false;
        if (!projectDestroyed && !projectLeaving && !historyReconcileFailed && !reviewReconcileFailed) {
          editor.setEditable(true);
          timelineMount?.setEditable(true);
        }
      }
    },
    // IDS AND NOTHING ELSE cross this boundary. No body, no path and no
    // revision is sent, so nothing the page holds can decide what is written --
    // only which of the rows the host itself derived is taken. The host rebuilds
    // the change set and refuses any id whose row is not applicable.
    accept: async (ids) =>
      (await invoke("mirror_accept", { ids: [...ids] })) as MirrorAcceptOutcome,
    // THE FOURTH `replaceDoc` PATH, and an earlier plan's write-back names it before
    // it existed: "THERE ARE NOW THREE `replaceDoc` PATHS. A
    // fourth is where this comes back." `reloadOpenDocument` is the third and
    // it already carries the whole obligation -- it swaps the body, registers
    // the new revision with the scheduler, reloads the notes the swap left the
    // comment plugin holding nothing of, and repaints every figure. Reusing it
    // rather than restating it is what stops there being a fourth answer to
    // what a body rewrite owes the page.
    //
    // The notes are the load-bearing half: the host has just collapsed the
    // anchors of every accepted body, and this reload is how the writer is told
    // which of their notes the acceptance orphaned.
    onAccepted: async (outcome) => {
      for (const changed of outcome.report.documents) { referenceRail?.sourceChanged(changed.item_id); craftPanel?.sourceChanged(changed.item_id); continuousChapter?.sourceChanged(changed.item_id); }
      if (outcome.report.documents.some((changed) => changed.item_id === session?.activeDocId())) {
        try {
          await reloadOpenDocument(true);
        } catch (error) {
          historyReconcileFailed = true;
          throw new Error(t("history.error.reconcile"), { cause: error });
        }
      }
      announce(
        plural("mirror.changes.accepted", outcome.report.documents.length, {
          count: formatNumber(outcome.report.documents.length),
          label: outcome.report.snapshot.label,
        }),
      );
      if (outcome.underlined > 0) {
        // SAID AGAIN, and it is not a repetition of the row: the row warned
        // about one file and this counts what the whole acceptance dropped.
        raiseNotice(
          plural("mirror.changes.accepted.underline", outcome.underlined, {
            count: formatNumber(outcome.underlined),
          }),
        );
      }
    },
    undo: async (handle: MirrorUndoHandle) => {
      if (projectDestroyed || invoke === undefined || session === null || flusher === null) {
        throw new Error(t("mirror.changes.undo.error.destroyed"));
      }
      if (undoInFlight || sourceCommandInFlight || historyOperationInFlight || reviewDecisionInFlight || reviewOpenInFlight || reviewTransportInFlight || projectLeaving) throw new Error(t("mirror.changes.undo.error.busy"));
      if (inflightOpens > 0) throw new Error(t("mirror.changes.undo.error.opening"));
      undoInFlight = true;
      const activeTarget = session.activeDocId() === handle.itemId;
      const proseTarget = activeTarget && typeOf(handle.itemId) !== TIMELINE_TYPE;
      if (proseTarget) editor.setEditable(false);
      try {
        await flusher.drain();
        if (flusher.failed()) {
          throw new Error(t("mirror.changes.undo.error.unsaved"));
        }
        if (projectDestroyed) return;
        const restored = (await invoke("mirror_undo_accept", {
          generation: deps.generation,
          itemId: handle.itemId,
          versionId: handle.versionId,
          snapshotId: handle.snapshotId,
          acceptedRev: handle.acceptedRev,
        })) as { rev: number; body: string };
        if (projectDestroyed) return;
        referenceRail?.sourceChanged(handle.itemId);
        craftPanel?.sourceChanged(handle.itemId);
        continuousChapter?.sourceChanged(handle.itemId);
        flusher.register(handle.itemId, restored.rev);
        if (activeTarget && session.activeDocId() === handle.itemId) {
          if (typeOf(handle.itemId) === TIMELINE_TYPE) {
            timelineMount?.setBody(restored.body);
          } else {
            const json = readableBody(restored.body);
            if (json === null) {
              raiseNotice(t("project.error.unreadable-body", { item: handle.itemId }));
            } else {
              editor.replaceDoc({ kind: "pmjson", json });
              void loadComments(handle.itemId);
              editor.setCastNames(namesForCast(castMembers));
              wordCount?.refreshSceneNow();
            }
          }
        }
        void refreshCounts();
      } finally {
        if (!projectDestroyed && !historyOperationInFlight && !historyReconcileFailed && proseTarget) editor.setEditable(true);
        undoInFlight = false;
      }
    },
    onDismiss: () => editor.focus(),
    onNotice: raiseNotice,
  });

  let history: History | null = null;
  const historyEl = document.getElementById("history-controls");
  if (historyEl === null) {
    throw new Error("page shell is missing #history-controls: index.html and project.ts disagree");
  }
  if (session !== null) {
    const theSession = session;
    const theFlusher = flusher;
    history = createHistory({
      container: historyEl,
      drain: async () => {
        await theFlusher.drain();
        if (theFlusher.failed() || persistError !== null) throw new Error(t("history.error.unsaved"));
        if (projectDestroyed || projectLeaving || deps.privacyLocked?.()) throw new Error(t("history.error.busy"));
      },
      withOperation: async (operation) => {
        if (projectDestroyed || projectLeaving || outline?.busy() || historyOperationInFlight || historyReconcileFailed || reviewReconcileFailed ||
            sourceCommandInFlight || undoInFlight || reviewDecisionInFlight || reviewOpenInFlight || reviewTransportInFlight ||
            inflightOpens > 0 || reviewPanel?.busy() || deps.privacyLocked?.()) throw new Error(t("history.error.busy"));
        historyOperationInFlight = true;
        try {
          editor.setEditable(false);
          timelineMount?.setEditable(false);
          return await operation();
        } finally {
          historyOperationInFlight = false;
          if (!projectDestroyed && !projectLeaving && !historyReconcileFailed && !reviewReconcileFailed) {
            editor.setEditable(true);
            timelineMount?.setEditable(true);
          }
        }
      },
      activeDocId: () => theSession.activeDocId(),
      revOf: (itemId) => theFlusher.revOf(itemId),
      versions: async (itemId) =>
        (await invoke("doc_versions", { itemId })) as VersionRow[],
      restore: async (itemId, versionId, baseRev) =>
        (await invoke("doc_restore", { itemId, versionId, baseRev })) as {
          rev: number;
          body: string;
        },
      // THE STORE'S ANSWER, not the editor's. The panel drains before it asks,
      // so by the time this runs the two agree - and if they ever do not, the
      // store is the one the writer will still have tomorrow.
      currentBody: async (itemId) =>
        ((await invoke("doc_load", { itemId })) as { body: string; rev: number }).body,
      versionBody: async (versionId) =>
        (await invoke("doc_version_body", { versionId })) as string,
      snapshots: async () => (await invoke("snapshot_list")) as SnapshotRow[],
      takeSnapshot: async (label) =>
        (await invoke("snapshot_create", { label })) as SnapshotRow,
      restoreSnapshot: async (snapshotId) => {
        const restored = (await invoke("snapshot_restore", { snapshotId })) as {
          documents: number;
          covered: number;
        };
        if (restored.documents > 0) { referenceRail?.invalidateAll(); craftPanel?.invalidateAll(); continuousChapter?.sourceChanged(); }
        return restored;
      },
      // THROUGH THE EDITOR AND THE SCHEDULER TOGETHER. `replaceDoc` uses
      // updateState, so no onChange fires and the document is not marked dirty
      // by the swap - which is right, because the host already wrote it. But
      // the rev moved, and a scheduler still holding the old one would refuse
      // the writer's very next keystroke as a Conflict.
      applyRestored: async (itemId, body, rev) => {
        if (projectDestroyed) return;
        try {
          if (theSession.activeDocId() !== itemId) throw new Error(t("history.error.changed"));
          if (!Number.isSafeInteger(rev)) throw new Error(t("project.error.unreadable-body", { item: itemId }));
          if (typeOf(itemId) === TIMELINE_TYPE) {
            const parsed = parseTimeline(body);
            if ("invalid" in parsed || "newer" in parsed) throw new Error(t("project.error.unreadable-body", { item: itemId }));
            timelineMount?.setBody(body);
            theFlusher.register(itemId, rev);
          } else {
            const json = readableBody(body);
            if (json === null) throw new Error(t("project.error.unreadable-body", { item: itemId }));
            editor.replaceDoc({ kind: "pmjson", json });
            theFlusher.register(itemId, rev);
            await loadComments(itemId);
            if (projectDestroyed) return;
            editor.setCastNames(namesForCast(castMembers));
            wordCount?.refreshSceneNow();
          }
          referenceRail?.sourceChanged(itemId);
          craftPanel?.sourceChanged(itemId);
          continuousChapter?.sourceChanged(itemId);
          void refreshCounts();
        } catch (error) {
          // The host changed the body; an unreconciled editor must not save over it.
          historyReconcileFailed = true;
          throw new Error(t("history.error.reconcile"), { cause: error });
        }
      },
      // A snapshot restore can move every document in the book, so every
      // figure on screen is stale: the project total, the navigator's roll-ups,
      // and the body of whatever scene is open.
      reloadProject: async () => {
        try {
          await reloadOpenDocument(true);
        } catch (error) {
          historyReconcileFailed = true;
          throw new Error(t("history.error.reconcile"), { cause: error });
        }
      },
      onDone: announce,
      onNotice: raiseNotice,
      onDismiss: () => timelineMount !== null ? timelineMount.focus() : editor.focus(),
    });
  }

  // Comments. A note is a row in the store attached to a stored document.
  let comments: CommentsPanel | null = null;
  const commentsEl = document.getElementById("comments-controls");
  if (commentsEl === null) {
    throw new Error("page shell is missing #comments-controls: index.html and project.ts disagree");
  }
  if (session !== null) {
    const theSession = session;
    const theFlusher = flusher;
    comments = createCommentsPanel({
      container: commentsEl,
      drain: () => theFlusher.drain(),
      activeDocId: () => theSession.activeDocId(),
      list: async (itemId) => (await invoke("comment_list", { itemId })) as CommentRow[],
      create: async (itemId, body, from, to, quote) =>
        (await invoke("comment_create", {
          itemId,
          body,
          anchorFrom: from,
          anchorTo: to,
          quote,
        })) as CommentRow,
      setBody: async (id, body) => {
        await invoke("comment_set_body", { id, body });
      },
      setResolved: async (id, resolved) => {
        await invoke("comment_set_resolved", { id, resolved });
      },
      // THE EDITOR'S ANSWER, not the store's. The store holds where a note was
      // at the last flush; the editor has been mapping it through every
      // transaction since, and the panel is read beside the prose.
      anchorOf: (id) => editor.commentAnchors().find((a) => a.id === id),
      quoteAt: (from, to) => editor.textIn(from, to),
      selectionRange: () => editor.selection(),
      reveal: (from, to) => {
        const landed = editor.selectRange(from, to);
        // Focus follows the selection: a selection nobody can see the caret in
        // is a selection the next keystroke does not act on.
        if (landed) editor.focus();
        return landed;
      },
      capped: () => editor.commentsCapped(),
      // ONE READ FEEDS BOTH the panel's rows and the editor's marks, so the two
      // cannot describe different sets of notes - which they would the moment a
      // create or a resolve refreshed one and not the other.
      syncEditor: (rows) => {
        editor.setCommentAnchors(
          rows.map((row) => ({
            id: row.id,
            from: row.anchor_from,
            to: row.anchor_to,
            resolved: row.resolved,
          })),
        );
        updateSceneNotes(theSession.activeDocId(), rows);
      },
      onDone: announce,
      onNotice: raiseNotice,
      onDismiss: () => editor.focus(),
    });
  }

  /** Ctrl+Alt+M, on the DOCUMENT.
   *
   *  On the document for the reasons Ctrl+F, Ctrl+P and Alt+Left are: the
   *  editor's keymap only fires while the editor holds focus, and
   *  `navigator.handleKey` is driven directly by the synthetic workload. */
  const onCommentChord = (event: Event): void => {
    if (!(event instanceof KeyboardEvent) || isCompositionKey(event)) return;
    if (!isAddCommentChord(event)) return;
    const target = event.target;
    // A field and an open panel keep their own keys, the same exclusion the
    // navigation chord makes - and `contenteditable` is deliberately NOT
    // excluded, because the prose is exactly where this chord is meant to be
    // pressed.
    if (target instanceof Element && target.closest("input, textarea, [role='dialog']") !== null) {
      return;
    }
    event.preventDefault();
    void comments?.open("compose");
  };
  document.addEventListener("keydown", onCommentChord);

  const onContinuousInput = (event: Event): void => {
    if (!continuousChapter?.isOpen()) return;
    if (event instanceof KeyboardEvent && !isCompositionKey(event) && event.altKey && !event.ctrlKey && !event.metaKey &&
        (event.key === "PageDown" || event.key === "PageUp") && pmElement?.contains(event.target as Node)) {
      event.preventDefault();
      continuousChapter.neighbor(event.key === "PageDown" ? 1 : -1);
      return;
    }
    // A retained browser selection must not intercept typing in another panel
    // or trap Tab/menu navigation. Only mutations aimed at the writer need this
    // guard; read-only neighbors cannot edit through their own DOM.
    if (!(event.target instanceof Node) || !pmElement.contains(event.target) || !continuousChapter.crossBoundarySelection()) return;
    if (event instanceof KeyboardEvent) {
      const copy = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c";
      const navigation = event.key === "Tab" || event.altKey || event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Escape" || event.key === "Home" || event.key === "End";
      if (copy || navigation) return;
    }
    event.preventDefault();
    event.stopPropagation();
  };
  for (const type of ["beforeinput", "paste", "keydown", "cut", "drop"] as const) document.addEventListener(type, onContinuousInput, true);

  // Statistics. Every figure is arithmetic over the host's per-document word
  // index.
  let statistics: StatisticsPanel | null = null;
  let analytics: AnalyticsWorkspace | null = null;
  // Once per minute at most, and never while the writer has it off. The
  // host refuses to count a minute twice, so this is a courtesy to the
  // keystroke path, not the rule.
  const writingTime = createWritingTime({
    tracking: () => deps.timeTracking?.() ?? "on",
    note: async (today) => (await invoke("writing_time_note", { today })) as number,
    minute: () => Math.floor(Date.now() / 60_000),
  });
  const todayFigures = async (): Promise<TodayFigures> => ({
    writingMinutes: (await invoke("writing_time_today", { today: localDate(new Date()) })) as number,
    tracking: deps.timeTracking?.() ?? "on",
    sources: (await invoke("project_source_words", { today: localDate(new Date()) })) as SourceWordSummary,
  });
  const documentCounts = async (): Promise<DocumentStatisticsCounts> =>
    (await invoke("project_document_counts")) as DocumentStatisticsCounts;
  // THE CHECKPOINT. Edits made before the command are saved under the old
  // state and edits after it under the new one; with the editor locked and
  // every pending save drained first, nothing lands on the wrong side.
  const sourceWordsCommand = async (command: string, args: Record<string, unknown>): Promise<void> => {
    if (projectDestroyed || flusher === null) throw new Error(t("stats.sources.error.closed"));
    if (sourceCommandInFlight || historyOperationInFlight || undoInFlight || reviewDecisionInFlight || reviewOpenInFlight || reviewTransportInFlight || projectLeaving || inflightOpens > 0) {
      throw new Error(t("stats.sources.error.busy"));
    }
    sourceCommandInFlight = true;
    editor.setEditable(false);
    try {
      await flusher.drain();
      if (flusher.failed()) throw new Error(t("stats.sources.error.unsaved"));
      if (projectDestroyed) throw new Error(t("stats.sources.error.closed"));
      await invoke(command, { generation: deps.generation, ...args });
      if (!projectDestroyed) void wordCount?.refreshProject();
    } finally {
      if (!projectDestroyed && !historyOperationInFlight && !historyReconcileFailed) editor.setEditable(true);
      sourceCommandInFlight = false;
    }
  };

  const statsEl = document.getElementById("stats-controls");
  if (statsEl === null) {
    throw new Error("page shell is missing #stats-controls: index.html and project.ts disagree");
  }
  {
    const theFlusher = flusher;
    statistics = createStatisticsPanel({
      container: statsEl,
      drain: () => theFlusher.drain(),
      // The LIVE walk, for the same reason quick open and the count refresh read
      // it: a scene created a moment ago exists there and nowhere else.
      items: () => outline?.items() ?? latestItems,
      documentCounts,
      // Read afresh on every open, never held: the panel outlives any number of
      // document switches.
      openItemId: () => session?.activeDocId() ?? null,
      session: () => sessionWords.totals(),
      today: todayFigures,
      setTracking: async (tracking) => {
        await deps.setTimeTracking?.(tracking);
      },
      setCollecting: (collecting) =>
        sourceWordsCommand("project_source_words_collecting", { collecting }),
      resetSources: () => sourceWordsCommand("project_source_words_reset", {}),
      exportFile: invoke === undefined ? undefined : (kind) => statisticsExport?.run(kind),
      onDismiss: () => editor.focus(),
    });
  }
  {
    const theFlusher = flusher;
    analytics = createAnalyticsWorkspace({
      invoke: (command, args) => invoke(command, args),
      drain: () => theFlusher.drain(),
      bookWords: async () => (await invoke("project_word_count")) as number,
      openStatistics: () => void statistics?.open(),
      onDismiss: () => (timelineMount !== null ? timelineMount.focus() : editor.focus()),
    });
  }
  // The same figures as a file. Same deps as the panel, read the same way, so
  // the file and the panel cannot disagree about what was measured.
  let statisticsExport: StatisticsExport | null = null;
  {
    const theFlusher = flusher;
    statisticsExport = createStatisticsExport({
      drain: () => theFlusher.drain(),
      items: () => outline?.items() ?? latestItems,
      documentCounts,
      openItemId: () => session?.activeDocId() ?? null,
      session: () => sessionWords.totals(),
      today: todayFigures,
      // The host picks the path and writes; the page never names a file.
      write: async (kind, text) =>
        (await invoke("statistics_export_as", { kind, text })) as StatisticsWritten | null,
      onNotice: raiseNotice,
      onDone: announce,
    });
  }

  // Revision states. The state lives on a store item.
  let revisionPanel: RevisionPanel | null = null;
  const stateEl = document.getElementById("state-controls");
  if (stateEl === null) {
    throw new Error("page shell is missing #state-controls: index.html and project.ts disagree");
  }
  {
    revisionPanel = createRevisionPanel({
      container: stateEl,
      // READ LIVE, at every paint. Both halves matter: the selection moves while
      // the panel is open (an arrow key still reaches the navigator), and the
      // state moves when the panel itself sets it. The walk is the outline
      // unit's own, for the same reason quick open and the count refresh read
      // it - a row marked a moment ago is current there and nowhere else.
      selected: () => {
        const id = selectedId();
        if (id === null) return null;
        const row = (outline?.items() ?? latestItems).find((item) => item.id === id);
        if (row === undefined) return null;
        return { id: row.id, title: row.title, state: row.state, type: row.type };
      },
      // Through the outline unit, which owns every tree mutation: it holds the
      // walk each base_rev is read from, serializes against a move already in
      // flight, re-reads afterwards and raises its own banner on a refusal.
      setState: async (itemId, state) =>
        (await outline?.setState(itemId, state)) ?? "failed",
      planning: {
        passes: async () => (await invoke("revision_pass_list")) as RevisionPassRow[],
        tasks: async () => (await invoke("revision_task_list")) as RevisionTaskRow[],
        createPass: (name, purpose) => invoke("revision_pass_create", { name, purpose }),
        updatePass: (id, name, purpose) => invoke("revision_pass_update", { id, name, purpose }),
        deletePass: (id) => invoke("revision_pass_delete", { id }),
        createTask: (body, itemId, passId) => invoke("revision_task_create", { body, itemId, passId }),
        updateTask: (id, body, passId) => invoke("revision_task_update", { id, body, passId }),
        setDone: (id, done) => invoke("revision_task_set_done", { id, done }),
        deleteTask: (id) => invoke("revision_task_delete", { id }),
      },
      onDismiss: () => editor.focus(),
    });
  }

  async function openReviewProposals(): Promise<void> {
    if (session === null || reviewPanel === null || projectDestroyed || projectLeaving ||
        reviewDecisionInFlight || reviewOpenInFlight || reviewTransportInFlight || undoInFlight || sourceCommandInFlight || historyOperationInFlight || inflightOpens > 0 ||
        deps.privacyLocked?.()) return;
    const itemId = session.activeDocId();
    if (typeOf(itemId) === TIMELINE_TYPE) {
      raiseNotice(t("review.no-prose"));
      return;
    }
    const title = titleOf(itemId);
    reviewOpenInFlight = true;
    editor.setEditable(false);
    try {
      await flusher.drain();
      if (flusher.failed() || persistError !== null) throw new Error(t("review.unsaved-prose"));
      if (projectDestroyed || projectLeaving || session.activeDocId() !== itemId || deps.privacyLocked?.()) return;
      await reviewPanel.open(itemId, title);
    } catch (error) {
      raiseNotice(String(error));
    } finally {
      reviewOpenInFlight = false;
      if (!projectDestroyed && !projectLeaving && !reviewDecisionInFlight && !reviewTransportInFlight && !reviewReconcileFailed && !historyOperationInFlight && !historyReconcileFailed && inflightOpens === 0) editor.setEditable(true);
    }
  }

  async function withReviewTransport<T>(itemId: string, operation: () => Promise<T>): Promise<T> {
    if (projectDestroyed || projectLeaving || deps.privacyLocked?.()) throw new Error(t("review.busy"));
    if (reviewOpenInFlight || reviewDecisionInFlight || reviewTransportInFlight ||
        undoInFlight || sourceCommandInFlight || historyOperationInFlight || inflightOpens > 0) throw new ReviewBusyError(t("review.busy"));
    reviewTransportInFlight = true;
    const activeTarget = session?.activeDocId() === itemId;
    if (activeTarget) editor.setEditable(false);
    try {
      await flusher.drain();
      if (flusher.failed() || persistError !== null) throw new Error(t("review.unsaved-prose"));
      if (projectDestroyed || projectLeaving || deps.privacyLocked?.()) throw new Error(t("review.busy"));
      return await operation();
    } finally {
      reviewTransportInFlight = false;
      if (!projectDestroyed && !projectLeaving && !reviewReconcileFailed && !historyOperationInFlight && !historyReconcileFailed && activeTarget &&
          session?.activeDocId() === itemId && !reviewDecisionInFlight && !reviewOpenInFlight && inflightOpens === 0) editor.setEditable(true);
    }
  }

  const reviewEl = document.getElementById("review-controls");
  if (reviewEl === null) throw new Error("page shell is missing #review-controls");
  reviewPanel = createReviewPanel({
    container: reviewEl,
    load: async (itemId, beforeId, pendingOnly) =>
      (await invoke("review_state", { generation: deps.generation, itemId, beforeId, pendingOnly })) as ReviewState,
    group: async (groupId) =>
      (await invoke("review_group", { generation: deps.generation, groupId })) as ReviewGroup,
    messages: async (groupId) =>
      (await invoke("review_messages", { generation: deps.generation, groupId })) as ReviewMessage[],
    createAuthor: async (displayName) => {
      if (projectLeaving || projectDestroyed) throw new Error(t("review.save-failed"));
      return (await invoke("review_author_create", { generation: deps.generation, displayName })) as ReviewAuthor;
    },
    createGroup: async (itemId, expectedDocRev, authorId, hunks: ReviewHunk[]) => {
      if (projectLeaving || projectDestroyed) throw new Error(t("review.save-failed"));
      await flusher.drain();
      if (flusher.failed() || persistError !== null || projectLeaving || projectDestroyed) throw new Error(t("review.unsaved-prose"));
      return invoke("review_group_create", { generation: deps.generation, itemId, expectedDocRev, authorId, hunks });
    },
    addMessage: (groupId, expectedGroupRev, authorId, body) => {
      if (projectLeaving || projectDestroyed) return Promise.reject(new Error(t("review.save-failed")));
      return invoke("review_message_add", { generation: deps.generation, groupId, expectedGroupRev, authorId, body });
    },
    decide: async (itemId, groupId, expectedGroupRev, expectedDocRev, ids, decision: ReviewDecision, authorId) => {
      if (projectLeaving || projectDestroyed || reviewDecisionInFlight || reviewOpenInFlight || reviewTransportInFlight || undoInFlight || sourceCommandInFlight || historyOperationInFlight || inflightOpens > 0) {
        throw new Error(t("review.busy"));
      }
      reviewDecisionInFlight = true;
      const activeTarget = session?.activeDocId() === itemId;
      if (activeTarget) editor.setEditable(false);
      try {
        await flusher.drain();
        if (flusher.failed() || persistError !== null) throw new Error(t("review.unsaved-prose"));
        if (projectDestroyed || projectLeaving || deps.privacyLocked?.()) throw new Error(t("review.busy"));
        const result = (await invoke("review_decide", { request: {
          generation: deps.generation,
          item_id: itemId,
          group_id: groupId,
          expected_group_rev: expectedGroupRev,
          expected_doc_rev: expectedDocRev,
          selected_ids: ids,
          decision,
          author_id: authorId,
        } })) as { doc_rev: number; body: string | null };
        if (projectDestroyed) return;
        if (result.body !== null) {
          if (typeof result.body !== "string") {
            reviewReconcileFailed = true;
            throw new Error(t("review.invalid-result"));
          }
          const json = readableBody(result.body);
          if (json === null || !Number.isSafeInteger(result.doc_rev)) {
            reviewReconcileFailed = true;
            throw new Error(t("review.invalid-result"));
          }
          // The host computed the only accepted body. Install it with its revision
          // before yielding so an edit cannot be saved against the old pair.
          if (activeTarget && session?.activeDocId() === itemId) editor.replaceDoc({ kind: "pmjson", json });
          flusher.register(itemId, result.doc_rev);
          referenceRail?.sourceChanged(itemId);
          craftPanel?.sourceChanged(itemId);
          continuousChapter?.sourceChanged(itemId);
          if (activeTarget && session?.activeDocId() === itemId) {
            await loadComments(itemId);
            editor.setCastNames(namesForCast(castMembers));
            wordCount?.refreshSceneNow();
          }
          void wordCount?.refreshProject();
          void refreshCounts();
        }
      } finally {
        reviewDecisionInFlight = false;
        if (!projectDestroyed && !projectLeaving && !reviewTransportInFlight && !reviewReconcileFailed && !historyOperationInFlight && !historyReconcileFailed && activeTarget) editor.setEditable(true);
      }
    },
    transport: {
      exportPreview: (itemId) => withReviewTransport(itemId, async () =>
        (await invoke("review_export_preview", { generation: deps.generation, itemId })) as ReviewExportPreview),
      exportSave: (token, itemId) => withReviewTransport(itemId, async () =>
        (await invoke("review_export_save", { token })) as boolean),
      returnPreview: (itemId) => withReviewTransport(itemId, async () =>
        (await invoke("review_return_preview", { generation: deps.generation, itemId })) as ReviewReturnPreview | null),
      returnApply: (request: ReviewReturnRequest, itemId) => withReviewTransport(itemId, async () => {
        const activeTarget = session?.activeDocId() === itemId;
        const result = (await invoke("review_return_apply", { request })) as { item_id: string; doc_rev: number; body: string | null };
        if (projectDestroyed) return;
        try {
          if (result.item_id !== itemId || !Number.isSafeInteger(result.doc_rev) ||
              (result.body !== null && typeof result.body !== "string")) throw new Error(t("review.invalid-result"));
          if (result.body !== null) {
            const json = readableBody(result.body);
            if (json === null) throw new Error(t("review.invalid-result"));
            if (activeTarget && session?.activeDocId() === itemId) editor.replaceDoc({ kind: "pmjson", json });
            flusher.register(itemId, result.doc_rev);
            referenceRail?.sourceChanged(itemId);
            craftPanel?.sourceChanged(itemId);
            continuousChapter?.sourceChanged(itemId);
            if (activeTarget && session?.activeDocId() === itemId) {
              await loadComments(itemId);
              editor.setCastNames(namesForCast(castMembers));
              wordCount?.refreshSceneNow();
            }
            void wordCount?.refreshProject();
            void refreshCounts();
          }
        } catch (error) {
          reviewReconcileFailed = true;
          throw new ReviewAppliedViewError(String(error));
        }
      }),
      cancel: async (token) => { await invoke("review_transport_cancel", { token }); },
      isLocked: () => deps.privacyLocked?.() ?? false,
      onNotice: raiseNotice,
      onSuccess: announce,
    },
    isLocked: () => deps.privacyLocked?.() ?? false,
    onDone: () => announce(t("review.saved")),
    onNotice: raiseNotice,
    onDismiss: () => { if (!projectLeaving && !projectDestroyed) editor.focus(); },
  });

  // The synopsis. A row in a table of its own, keyed on the item -- not a second
  // document and not a column on the item, both for reasons the design record
  // argues at length. It is NOT prose: the word count, find and replace, the
  // export and the readable folder all miss it by construction, because every
  // one of them walks the `doc` table and this is not in it.
  let synopsisPanel: SynopsisPanel | null = null;
  const synopsisEl = document.getElementById("synopsis-controls");
  if (synopsisEl === null) {
    throw new Error("page shell is missing #synopsis-controls: index.html and project.ts disagree");
  }
  {
    synopsisPanel = createSynopsisPanel({
      container: synopsisEl,
      // `body` comes back as null when the item has none, and the host returns
      // the whole row rather than the string - so the page reads one field and
      // never has to know what a synopsis revision is.
      read: async (itemId) => {
        const row = (await invoke("synopsis_get", { itemId })) as { body: string } | null;
        return row?.body ?? null;
      },
      write: async (itemId, body) => {
        await invoke("synopsis_set", { itemId, body });
        // The mark on the row follows the save, not a timer: one query, and
        // the navigator repaints what is mounted.
        void refreshSynopses();
      },
      onDone: announce,
      onNotice: raiseNotice,
      onDismiss: () => editor.focus(),
    });
  }

  // The cast: the characters, places and points of interest of this book. Rows
  // in two tables of their own, keyed on nothing in the outline -- so unlike the
  // bible they are not items, and unlike a synopsis they are not about an item
  // either. Nothing in the manuscript can see them: the word count, find and
  // replace, the export, the readable folder and the snapshots all walk the
  // `doc` table, and these are not in it.
  let castPanel: CastPanel | null = null;
  const castEl = document.getElementById("cast-controls");
  if (castEl === null) {
    throw new Error("page shell is missing #cast-controls: index.html and project.ts disagree");
  }
  {
    castPanel = createCastPanel({
      container: castEl,
      list: async () => (await invoke("cast_list")) as CastMemberRow[],
      listDeleted: async () => (await invoke("cast_deleted")) as CastMemberRow[],
      restore: async (id) => (await invoke("cast_restore", { id })) as CastMemberRow,
      create: async (kind, name) =>
        (await invoke("cast_create", { kind, name })) as CastMemberRow,
      // The WHOLE record, because the host writes it in one transaction: a
      // command per field would make one press of Save several writes with
      // several chances to half-apply.
      save: async (id, kind, name, summary, fields, aliases) =>
        (await invoke("cast_set", { id, kind, name, summary, fields, aliases })) as CastMemberRow,
      remove: async (id) => {
        await invoke("cast_remove", { id });
      },
      // THE PICTURE IS THREE COMMANDS OF ITS OWN AND NOT PART OF `cast_set`.
      // The page never names a path in either direction: it sends an id, the
      // writer chooses a file in the HOST's own dialog, and what comes back is
      // a state word and at most a thumbnail. So `picture_path` can never hold
      // a value the webview composed -- `project_export_as`'s argument, on a
      // value that goes into the database rather than onto the disk.
      picture: async (id) => (await invoke("cast_picture_view", { id })) as PictureView,
      pickPicture: async (id) =>
        (await invoke("cast_picture_pick", { id })) as CastMemberRow | null,
      clearPicture: async (id) =>
        (await invoke("cast_picture_clear", { id })) as CastMemberRow,
      // A FOURTH COMMAND, and it is the one recorded as missing: there was
      // no way to see a picture full size at all. It is a separate read and not
      // a bigger thumbnail on the panel's own read, because it is megabytes
      // rather than kilobytes and nobody should pay for it by opening a panel.
      fullPicture: async (id) => (await invoke("cast_picture_full", { id })) as PictureView,
      showFullSize: (dataUri, label) => pictureViewer?.show(dataUri, label),
      // EVERY "DONE" FROM THIS PANEL IS A CAST CHANGE: a
      // create, a save, a remove or a picture edit can all change what the
      // plugin should be looking for or what the card should show, and the
      // panel reports every one of them through this one channel.
      onDone: (message) => {
        announce(message);
        craftPanel?.invalidateAll();
        void loadCastNames();
      },
      onNotice: raiseNotice,
      onDismiss: () => editor.focus(),
    });
  }

  // ONE FULL-SIZE VIEWER FOR THE WHOLE PROJECT, and one is the point. Nothing
  // in this application could show a picture full size;
  // both the cast panel and the covers panel need to, and two viewers would be
  // two answers to how big "full size" is and two places to forget to drop the
  // bytes on close. Its anchor is its own rather than either panel's, because a
  // viewer owned by one would go with that panel's teardown.
  let pictureViewer: PictureViewer | null = null;
  const viewerEl = document.getElementById("picture-viewer-controls");
  if (viewerEl === null) {
    throw new Error(
      "page shell is missing #picture-viewer-controls: index.html and project.ts disagree",
    );
  }
  pictureViewer = createPictureViewer({
    container: viewerEl,
    onDismiss: () => editor.focus(),
  });

  // HOW THE BOOK IS SET WHEN IT LEAVES: the body font, the page and the four
  // margins. PER BOOK, in the project's own `meta` rows -- not in
  // `settings.json`, which is per machine, and not in the preferences panel,
  // which is per writer. Nothing consumes it yet: the EPUB export needs the font and
  // the PDF export needs all three, and the publishing track's design record is
  // explicit that the mechanism is built first and alone rather than shaped by
  // whichever renderer needed it.
  let designPanel: DesignPanel | null = null;
  const designEl = document.getElementById("design-controls");
  if (designEl === null) {
    throw new Error("page shell is missing #design-controls: index.html and project.ts disagree");
  }
  {
    designPanel = createDesignPanel({
      container: designEl,
      // READ ON EVERY OPEN, which is what makes this panel per-book without a
      // repaint hook: it can only ever be showing whichever project answered
      // last. The offerings ride along, so this page holds no measurement.
      read: async () => (await invoke("book_design_get")) as BookDesignView,
      // The WHOLE design every time, because the host checks all of it before
      // writing any of it -- margins that do not fit the page must change
      // nothing rather than the font and nothing else. What comes back is what
      // landed in the file, and it is what the panel repaints from.
      write: async (design: BookDesign) =>
        (await invoke("book_design_set", {
          font: design.font,
          pageWidthUm: design.page.width_um,
          pageHeightUm: design.page.height_um,
          pageName: design.page.name,
          marginInnerUm: design.margins.inner_um,
          marginOuterUm: design.margins.outer_um,
          marginTopUm: design.margins.top_um,
          marginBottomUm: design.margins.bottom_um,
        })) as BookDesign,
      exportDesign: async () => (await invoke("design_export_as")) as string | null,
      previewDesign: async () => (await invoke("design_import_preview")) as DesignTransferPreview | null,
      applyDesign: async (token) => (await invoke("design_import_apply", { token })) as DesignTransferPreview,
      onDone: announce,
      onNotice: raiseNotice,
      onDismiss: () => editor.focus(),
    });
  }

  // THE PICTURE ON THE FRONT OF THE BOOK AND THE ONE ON THE BACK. Beside the
  // design and not inside it: that panel holds nothing that can grow and has
  // no scroll for exactly that reason, and two cover previews are tall enough to
  // push its margin fields under the fold of a default window. The two are
  // coupled in FACT -- a cover is judged against the design's page size, which
  // this panel states -- and separate in SURFACE.
  //
  // A COVER IS NOT AN ARGUMENT TO `book_design_set`. Every axis of that command
  // is a value the page composed; a cover name is a filename on disk, and
  // "the page never names a path, in either direction" is what keeps the two
  // apart. Three commands of its own, exactly as a cast member's picture has.
  let coversPanel: CoversPanel | null = null;
  const coversEl = document.getElementById("covers-controls");
  if (coversEl === null) {
    throw new Error("page shell is missing #covers-controls: index.html and project.ts disagree");
  }
  coversPanel = createCoversPanel({
    container: coversEl,
    // READ ON EVERY OPEN, for the design panel's reason and one of its own: the
    // findings are computed against the page size, which the writer can have
    // changed in the other panel since this one last looked.
    read: async () => (await invoke("covers_get")) as CoversView,
    pick: async (side) => (await invoke("covers_pick", { side })) as CoversView | null,
    clear: async (side) => (await invoke("covers_clear", { side })) as CoversView,
    setFit: async (side, fit) => (await invoke("covers_fit_set", { side, fit })) as CoversView,
    full: async (side) => (await invoke("cover_full", { side })) as CoverPicture,
    showFullSize: (dataUri, label) => pictureViewer?.show(dataUri, label),
    onDone: announce,
    onNotice: raiseNotice,
    onDismiss: () => editor.focus(),
  });

  // PEN NAMES, AND THE REPORT THE EXPORT CHECKS PRODUCE. Two panels and
  // one menu item: the report is opened FROM the pen-names panel, so it is
  // reachable without spending a second File slot -- and it is a separate unit
  // because it is the one surface here whose lists grow with the book.
  //
  // THE PANEL SENDS AN ID AND NEVER A PIN. `identity_pin` takes the identity's
  // id and the host reads that identity out of the vault itself, which is the
  // containment rule one surface further in: a page-composed pin is a
  // page-composed byline.
  let identityPanel: IdentityPanel | null = null;
  let preflightPanel: PreflightPanel | null = null;
  const preflightEl = document.getElementById("preflight-controls");
  if (preflightEl === null) {
    throw new Error(
      "page shell is missing #preflight-controls: index.html and project.ts disagree",
    );
  }
  preflightPanel = createPreflightPanel({
    container: preflightEl,
    read: async (format) => (await invoke("preflight_get", { format })) as Preflight,
    append: async (format, token, reason) =>
      (await invoke("preflight_reason_add", {
        format,
        token,
        reason,
        generation: deps.generation,
      })) as Preflight,
    onNotice: raiseNotice,
    onDismiss: () => editor.focus(),
  });
  const identityEl = document.getElementById("identity-controls");
  if (identityEl === null) {
    throw new Error(
      "page shell is missing #identity-controls: index.html and project.ts disagree",
    );
  }
  identityPanel = createIdentityPanel({
    container: identityEl,
    // READ ON EVERY OPEN. The vault is library-level and the pin is per book,
    // so a panel that painted from a cached read could be showing one book's
    // pin over another book's manuscript.
    read: async () => (await invoke("identities_get")) as IdentitiesView,
    save: async (identity: Identity) =>
      (await invoke("identity_save", { identity })) as IdentitiesView,
    remove: async (id: string) => (await invoke("identity_remove", { id })) as IdentitiesView,
    previewPin: async (id: string) => (await invoke("identity_pin_preview", { id })) as PinPreview,
    pin: async (id: string, token: string) =>
      (await invoke("identity_pin", { id, token })) as IdentitiesView,
    unpin: async () => (await invoke("identity_unpin")) as IdentitiesView,
    // MARKDOWN, because it is the format File > Export manuscript writes and
    // therefore the one a writer means by "an export". The other two are read
    // from the rail, which reports its own refusal.
    showChecks: () => {
      void preflightPanel?.open("markdown").catch(() => undefined);
    },
    onDone: announce,
    onNotice: raiseNotice,
    onDismiss: () => editor.focus(),
  });

  // THE EPUB RAIL. NOT A PANEL, and mounted here rather than beside them for
  // that reason: it takes a grid column of its own, it registers no
  // document-level outside-click listener, and closing it is a control the
  // writer presses rather than something that happens when they look away.
  //
  // BUILT ONLY WHERE THERE IS A HOST AND A FLUSHER, exactly as the export bar
  // is and for the same reason: a preview is a rendering of the book AS SAVED,
  // and "as saved" means nothing without a scheduler to drain.
  let previewRail: PreviewRail | null = null;
  const epubEl = document.getElementById("preview-controls");
  if (epubEl === null) {
    throw new Error("page shell is missing #preview-controls: index.html and project.ts disagree");
  }
  if (invoke !== undefined && flusher !== null) {
    previewRail = createPreviewRail({
      container: epubEl,
      drain: () => drainForPublishing("preview"),
      read: async () => (await invoke("epub_preview")) as EpubPreview,
      readProof: async () => (await invoke("pdf_preview")) as PdfPreview,
      readStyle: async () => (await invoke("chapter_style_get")) as ChapterStyleView,
      readDesign: async () => (await invoke("book_design_get")) as BookDesignView,
      writeDesign: async (design) =>
        (await invoke("book_layout_set", {
          pageWidthUm: design.page.width_um,
          pageHeightUm: design.page.height_um,
          pageName: design.page.name,
          marginInnerUm: design.margins.inner_um,
          marginOuterUm: design.margins.outer_um,
          marginTopUm: design.margins.top_um,
          marginBottomUm: design.margins.bottom_um,
        })) as BookDesign,
      writeStyle: async (style) =>
        (await invoke("chapter_style_set", {
          glyph: style.glyph,
          newPage: style.new_page,
          capsTitle: style.caps_title,
          dropCap: style.drop_cap,
        })) as ChapterStyle,
      // THE EXPORT BAR'S OWN ROUTE, as EPUB. Not a second export path: that
      // unit owns the drain, the single-flight latch and both notices, and a
      // rail with an export of its own would be a second answer to what
      // happened to the writer's file.
      saveAs: (format) => exportBar?.runAs(format),
      onNotice: raiseNotice,
      onDismiss: () => editor.focus(),
    });
  }

  const referenceEl = document.getElementById("reference-controls");
  if (referenceEl === null) throw new Error("page shell is missing #reference-controls");
  if (invoke !== undefined) {
    referenceRail = createReferenceRail({
      container: referenceEl,
      drain: () => flusher.drain(),
      failed: () => flusher.failed() || persistError !== null || projectDestroyed,
      load: async (id) => (await invoke("doc_load", { itemId: id })) as { body: string; rev: number },
      openSource: (id) => { showManuscript(); navigator.revealAndSelectById?.(id); void openDocument?.(id); },
      onDismiss: () => {
        if (outlineView?.mode() !== "manuscript") outlineView?.element.querySelector<HTMLElement>("h1")?.focus();
        else if (timelineMount !== null) timelineMount.focus();
        else editor.focus();
      },
      onNotice: raiseNotice,
    });
    referenceRail.setItems(liveItemsIn(latestItems));
  }

  // THE COLUMN IS SHARED: an inspector opening closes whichever rail is
  // showing, and F6 moves between it and the prose.
  const uninstallInspector = setInspectorHost({
    closeRails: () => {
      previewRail?.close();
      referenceRail?.close();
    },
    focusProse: () => editor.focus(),
  });

  const craftEl = document.getElementById("craft-controls");
  if (craftEl === null) throw new Error("page shell is missing #craft-controls");
  if (invoke !== undefined) {
    craftPanel = createCraftPanel({
      container: craftEl,
      invoke,
      generation: deps.generation,
      items: () => outline?.items() ?? latestItems,
      selectedId,
      drain: () => flusher.drain(),
      failed: () => flusher.failed() || persistError !== null || projectDestroyed,
      anchor: () => {
        const item_id = session?.activeDocId();
        const range = editor.selection();
        if (item_id === null || item_id === undefined || range.from >= range.to) return null;
        const quote = editor.textIn(range.from, range.to);
        return quote ? { item_id, from: range.from, to: range.to, quote } : null;
      },
      openPassage: async (link) => {
        const anchor = link.anchor;
        if (anchor === null || projectDestroyed) return false;
        await flusher.drain();
        if (flusher.failed() || projectDestroyed) return false;
        const saved = await invoke("doc_load", { itemId: anchor.item_id }) as { rev: number };
        if (link.anchor_stale || saved.rev !== anchor.doc_rev) return false;
        showManuscript();
        navigator.revealAndSelectById?.(anchor.item_id);
        await openDocument?.(anchor.item_id);
        if (projectDestroyed || session?.activeDocId() !== anchor.item_id) return false;
        const current = await invoke("doc_load", { itemId: anchor.item_id }) as { rev: number };
        return current.rev === anchor.doc_rev && flusher.saveState() === "saved"
          && editor.textIn(anchor.from, anchor.to) === anchor.quote
          && editor.selectRange(anchor.from, anchor.to);
      },
      openFinding: async (finding) => {
        if (projectDestroyed) return false;
        await flusher.drain();
        if (flusher.failed() || projectDestroyed) return false;
        const saved = await invoke("doc_load", { itemId: finding.item_id }) as { rev: number };
        if (saved.rev !== finding.rev) return false;
        showManuscript();
        navigator.revealAndSelectById?.(finding.item_id);
        await openDocument?.(finding.item_id);
        if (projectDestroyed || session?.activeDocId() !== finding.item_id) return false;
        const current = await invoke("doc_load", { itemId: finding.item_id }) as { rev: number };
        return current.rev === finding.rev && flusher.saveState() === "saved"
          && editor.textIn(finding.from, finding.to) === finding.matched
          && editor.selectRange(finding.from, finding.to);
      },
      onNotice: raiseNotice,
      onDismiss: () => {
        if (outlineView?.mode() !== "manuscript") outlineView?.element.querySelector<HTMLElement>("h1")?.focus();
        else if (timelineMount !== null) timelineMount.focus();
        else editor.focus();
      },
    });
  }

  // Who appears where. TWO PANELS AND ONE JOIN TABLE: the first tags one row
  // and captures it at open (the synopsis panel's rule, because the selection
  // stays live behind it); the second is about the BOOK and reads no selection
  // at all (the cast panel's rule). The ROLLUP IS DERIVED ON READ, in the page,
  // from the walk the page already holds -- nothing per container is stored, so
  // there is nothing to invalidate on a move, a create, a delete, a restore or
  // an adoption.
  let appearancesPanel: AppearancesPanel | null = null;
  let appearancesMap: AppearancesMap | null = null;
  const appearsEl = document.getElementById("appears-controls");
  const appearsMapEl = document.getElementById("appears-map-controls");
  if (appearsEl === null || appearsMapEl === null) {
    throw new Error(
      "page shell is missing #appears-controls or #appears-map-controls: index.html and project.ts disagree",
    );
  }
  {
    // ONE COMMAND FOR THE WHOLE PROJECT, which is the host's own rule: the map
    // panel rolls a chapter's scenes up into the chapter and needs every row at
    // once, so a per-item read would be one round trip per row of the walk. The
    // tagging panel takes its own row out of the same answer rather than having
    // a second command of its own.
    const readAll = async (): Promise<ItemAppearances> =>
      (await invoke("appearances_list")) as ItemAppearances;
    appearancesPanel = createAppearancesPanel({
      container: appearsEl,
      cast: async () => (await invoke("cast_list")) as CastMemberRow[],
      read: async (itemId) => (await readAll())[itemId] ?? [],
      write: async (itemId, memberIds) => {
        await invoke("appearances_set", { itemId, memberIds });
        void refreshAppearanceMarks();
      },
      onDone: (message) => { announce(message); craftPanel?.invalidateAll(); },
      onNotice: raiseNotice,
      onDismiss: () => editor.focus(),
    });
    appearancesMap = createAppearancesMap({
      container: appearsMapEl,
      // THE LIVE WALK, read at the moment the panel opens, exactly as
      // `refreshCounts` reads one. The outline unit owns it once it exists;
      // before that the page's own boot walk is the answer.
      items: () => outline?.items() ?? latestItems,
      cast: async () => (await invoke("cast_list")) as CastMemberRow[],
      read: readAll,
      onNotice: raiseNotice,
      onDismiss: () => editor.focus(),
    });
  }

  // The navigator's context menu. A SECOND ROUTE to operations the Outline menu
  // already offers, so every dep here delegates to the unit that owns the action
  // rather than reimplementing it.
  //
  // EVERY DEP TAKES THE ROW'S ID. That is the difference between this surface
  // and the application menu, whose items act on "the selection": a context menu
  // is opened ON something, and the id it was opened on is captured at open and
  // closed over. Nothing here re-reads the selection.
  if (outline !== null) {
    const unit = outline;
    navContextMenu = createNavContextMenu({
      // The BODY, not #nav: the panel is positioned at the pointer in viewport
      // coordinates and a row near the foot of the pane opens a menu that has to
      // be allowed to stand outside the navigator's scroll box.
      container: document.body,
      create: (relativeTo, itemType) => {
        // RELATIVE TO THE ROW THE MENU OPENED ON, not "as a child of" it. The
        // context menu and the Outline menu now run the same placement rule
        // against different anchors, which is what keeps them from being two
        // answers to one question.
        //
        // Swallowed for the same reason the bar and the menu swallow it: the
        // outline unit turns a failure into a banner of its own, and a rejection
        // escaping a synchronous menu handler would be unhandled.
        void unit.create(itemType, relativeTo).catch(() => undefined);
      },
      beginRename: (itemId) => {
        const row = (unit.items() as readonly ProjectItem[]).find((i) => i.id === itemId);
        // A row the walk no longer holds cannot be renamed and must not open a
        // field prefilled with nothing, which reads as a title that has been
        // erased.
        if (row === undefined) return;
        renamePanel?.open(row.id, row.title);
      },
      remove: (itemId) => void unit.remove(itemId).catch(() => undefined),
      restore: (itemId) => void unit.restore(itemId).catch(() => undefined),
      trashed: (itemId) => isTrashedIn(latestItems, itemId),
      typeOf: (itemId) =>
        (unit.items() as readonly ProjectItem[]).find((i) => i.id === itemId)?.type ?? null,
      openRevisionState: (itemId) => {
        // The panel reads the SELECTION live, deliberately - it stays open while
        // the writer arrows around. So the captured row is made the selection
        // before it opens, rather than the panel being taught a second way to be
        // told which row it is about. The navigator has already selected this
        // row (that is rule one of this surface); this is what makes the
        // captured id, and not whatever happened since, authoritative.
        navigator.selectById(itemId);
        revisionPanel?.open();
      },
      // Synopsis and Who appears here, both the same shape as
      // Revision state above: the two panels read the SELECTION and the
      // navigator's own `activeTitle()`, so the captured row is made the
      // selection first. Swallowed like every other panel opener in this file:
      // each panel reports its own failure through `onNotice`.
      openSynopsis: (itemId) => {
        navigator.selectById(itemId);
        void synopsisPanel?.open(itemId, navigator.activeTitle()).catch(() => undefined);
      },
      openAppears: (itemId) => {
        navigator.selectById(itemId);
        void appearancesPanel?.open(itemId, navigator.activeTitle()).catch(() => undefined);
      },
      // THE TREE IS AN aria-activedescendant SURFACE: DOM focus lives on #nav
      // and the "focused row" is the one aria-activedescendant names. So
      // returning focus to the row IS focusing the container - a row element is
      // not a tab stop and `.focus()` on it is a no-op that drops focus to
      // <body>, a recorded defect this exists to avoid rather than repeat.
      returnFocus: () => navEl.focus(),
    });
  }

  const mounted: MountedProject = {
    navigator,
    editor,
    session,
    outline,
    source,
    storeItems,
    activeDocId,
    activeDocRev,
    loadedBodyHash,
    flusher,
    raiseFailure,
    raiseNotice,
    announce,
    setDailyTarget(target: DailyTarget): void {
      // Optional chaining, not a guard: the word count is built below the point
      // a mount can fail, so a goal set before then is a preference recorded for
      // the next project rather than an error.
      wordCount?.setDailyTarget(target);
    },
    setSidebarWordCounts(counts) { navigator.setSidebarWordCounts(counts); },
    setMarkCastNames(on: boolean): void {
      markCastNamesOn = on;
      editor.setCastNames(namesForCast(castMembers));
    },
    persistError: () => persistError,
    copiesNeedAttention: () => statusDot.state() === "amber",
    reviewPending: () => historyOperationInFlight || projectLeaving || reviewOpenInFlight || reviewDecisionInFlight || reviewTransportInFlight || (reviewPanel?.busy() ?? false) || (reviewPanel?.hasUnsaved() ?? false),
    reviewPrivacyChanged: () => reviewPanel?.invalidateTransport(),
    async prepareToLeave(): Promise<boolean> {
      if (projectDestroyed || projectLeaving || outline?.busy() || reviewOpenInFlight || reviewDecisionInFlight || reviewTransportInFlight || undoInFlight || sourceCommandInFlight || historyOperationInFlight || inflightOpens > 0 || reviewPanel?.busy() || deps.privacyLocked?.()) return false;
      projectLeaving = true;
      editor.setEditable(false);
      try {
        const allowed = await reviewPanel?.confirmLeave() ?? true;
        if (!allowed || projectDestroyed || deps.privacyLocked?.()) {
          mounted.cancelLeave();
          return false;
        }
        reviewPanel?.setLeaving(true);
        return true;
      } catch {
        mounted.cancelLeave();
        return false;
      }
    },
    cancelLeave(): void {
      projectLeaving = false;
      reviewPanel?.setLeaving(false);
      if (!projectDestroyed && !reviewDecisionInFlight && !reviewOpenInFlight && !reviewTransportInFlight && !undoInFlight && !sourceCommandInFlight && !historyOperationInFlight && !historyReconcileFailed && inflightOpens === 0 && !reviewReconcileFailed) editor.setEditable(true);
    },
    // Each one delegates to the unit that already owns the action, rather than
    // reimplementing it. The menu is a second SURFACE, not a second
    // implementation.
    menuActions: {
      exportProject: () => exportBar?.run("markdown"),
      exportAs: () => exportBar?.runAs("markdown"),
      exportDocx: () => exportBar?.runAs("docx"),
      // Swallowed like the panel openers: the unit reports both of its own
      // outcomes through the notice channel, and a rejection escaping a
      // synchronous menu handler would be unhandled.
      backupNow: () => void recoveryIndicator?.backupNow(),
      openFind: () => findBar?.open(),
      openQuickOpen: () => quickOpen?.open(),
      openReplace: () => findBar?.openReplace(),
      openHistory: () => void history?.open(),
      // Swallowed like the other panel openers: the panel reports its own
      // failure in its own status line, and a rejection escaping a synchronous
      // menu handler would be unhandled.
      openMirrorChanges: () => void mirrorChanges?.setOpen(true),
      // Swallowed like the other panel openers: the panel reports its own
      // failure in its own status line, and a rejection escaping a synchronous
      // menu handler would be unhandled.
      openComments: () => void comments?.open("list"),
      // A timeline carries no comment (comment_create refuses the type
      // server-side); the format bubble's own Comment cannot reach this
      // state at all, since it shows only over a ProseMirror selection and
      // that view is hidden while a timeline is open. The menu item is the
      // one route left, so it is the one that raises the sentence.
      addComment: () => {
        if (continuousChapter?.crossBoundarySelection()) return;
        if (timelineMount !== null) {
          raiseNotice(t("timeline.no-comments"));
          return;
        }
        void comments?.open("compose");
      },
      addToDictionary: () => {
        const word = timelineMount === null ? editor.wordAtCaret() : null;
        if (word === null) {
          raiseNotice(t("dict.no-word"));
          return;
        }
        addWordToDictionary(word.text);
      },
      // Swallowed like the other panel openers: the panel reports its own
      // failure in its own status line, and a rejection escaping a synchronous
      // menu handler would be unhandled.
      openStatistics: () => void statistics?.open(),
      openAnalytics: () => void analytics?.open(),
      openRevisionState: () => revisionPanel?.open(),
      openReviewProposals: () => { void openReviewProposals(); },
      openSynopsis: () => {
        const id = selectedId();
        // Nothing selected is not an error - there is simply no row to write
        // about - and this is the same silent return `beginRename`, `move` and
        // `removeOrRestore` all take, deliberately rather than by copying. A
        // FIRST DRAFT RAISED A NOTICE HERE and the notice was deleted with its
        // catalog string: an empty project cannot mount at all
        // (`storeSourceFrom` refuses one), so the only way to reach this is a
        // selection index transiently outside a non-empty walk, and no test can
        // produce it. A sentence no writer can read is the `import_name_ok`
        // shape - a reader credits it for a behaviour nothing performs.
        //
        // The null check itself is not decorative: `selectedId()` is
        // `string | null` and the compiler requires it, so it cannot be
        // mutated away.
        if (id === null) return;
        // The TITLE as well as the id, exactly as `beginRename` sends it: the
        // panel holds no walk, and the caller that knows which row this is
        // about is the one that knows what it is called.
        //
        // Swallowed like every other panel opener here: the panel reports its
        // own failure through `onNotice`, and a rejection escaping a
        // synchronous menu handler would be unhandled.
        void synopsisPanel?.open(id, navigator.activeTitle()).catch(() => undefined);
      },
      // NO SELECTION IS READ. Unlike every other item in the Outline menu, the
      // cast is not about the row the writer is on -- it is about the book -- so
      // there is nothing here to capture and nothing to be wrong about.
      //
      // Swallowed like every other panel opener here: the panel reports its own
      // failure through `onNotice`, and a rejection escaping a synchronous menu
      // handler would be unhandled.
      openCast: () => {
        void castPanel?.open().catch(() => undefined);
      },
      openKnowledge: () => { void craftPanel?.open("knowledge"); },
      openCraftReports: () => { void craftPanel?.open("reports"); },
      // NO SELECTION EITHER: this is about the whole book, the same as the cast.
      // Swallowed like every other panel opener here.
      openBookDesign: () => {
        void designPanel?.open().catch(() => undefined);
      },
      // NO SELECTION EITHER, and for the same reason: a book has one front
      // cover, not one per row. Swallowed like every other panel opener here.
      openCovers: () => {
        void coversPanel?.open().catch(() => undefined);
      },
      // NO SELECTION EITHER: a book has one byline, not one per row. Swallowed
      // like every other panel opener here.
      openIdentities: () => {
        void identityPanel?.open().catch(() => undefined);
      },
      // NO SELECTION EITHER: a preview is of the whole book. Swallowed like
      // every other opener here -- the rail reports both of its own outcomes
      // through the notice channel, and a rejection escaping a synchronous menu
      // handler would be unhandled.
      openEpubPreview: () => {
        if (!yieldInspector()) return;
        continuousChapter?.exit();
        referenceRail?.close();
        void previewRail?.open("epub").catch(() => undefined);
      },
      // THE SAME RAIL IN THE OTHER FORMAT, not a second surface. What the
      // format decides is what the rail reads, what it paints and what a Save
      // writes; the four options are the book's design and are the same
      // options in both.
      openPdfPreview: () => {
        if (!yieldInspector()) return;
        continuousChapter?.exit();
        referenceRail?.close();
        void previewRail?.open("pdf").catch(() => undefined);
      },
      openReference: () => {
        const id = selectedId();
        const item = liveItemsIn(latestItems).find((row) => row.id === id);
        if (item === undefined) return;
        if (!yieldInspector()) return;
        previewRail?.close();
        void referenceRail?.open(item);
      },
      closeReference: () => referenceRail?.close(),
      // THE SELECTION IS READ, exactly as `openSynopsis` reads it and for the
      // same reason and with the same silent return on nothing selected: there
      // is simply no row to say who appears in. See `openSynopsis` above for
      // why that branch carries no sentence.
      openAppearances: () => {
        const id = selectedId();
        if (id === null) return;
        // The TITLE as well as the id, exactly as `openSynopsis` sends it: the
        // panel holds no walk, and the caller that knows which row this is
        // about is the one that knows what it is called.
        void appearancesPanel?.open(id, navigator.activeTitle()).catch(() => undefined);
      },
      // NO SELECTION IS READ, exactly as `openCast` reads none: this one is
      // about the whole book, so there is nothing here to capture and nothing
      // to be wrong about.
      openAppearancesMap: () => {
        void appearancesMap?.open().catch(() => undefined);
      },
      navBack: () => goHistory("back"),
      navForward: () => goHistory("forward"),
      canNavBack: () => navHistory.canGoBack(openableIds()),
      canNavForward: () => navHistory.canGoForward(openableIds()),
      undo: () => { if (timelineMount === null && !continuousChapter?.crossBoundarySelection()) editor.undo(); },
      redo: () => { if (timelineMount === null && !continuousChapter?.crossBoundarySelection()) editor.redo(); },
      // The outline's structural stack, distinct from the editor's prose undo above.
      // Swallowed like every other outline call from a synchronous menu
      // handler: the unit banners its own failures.
      outlineUndo: () => void outline?.undo().catch(() => undefined),
      outlineRedo: () => void outline?.redo().catch(() => undefined),
      outlineUndoLabel: () => outline?.undoLabel() ?? null,
      outlineRedoLabel: () => outline?.redoLabel() ?? null,
      showManuscript,
      showContinuousChapter: () => {
        previewRail?.close();
        outlineViewTransitions?.returnToEditor();
        if (!continuousChapter?.enter()) raiseNotice(t("continuous.need-scene"));
      },
      showOutlineTable: () => { void outlineViewTransitions?.show("table"); },
      showOutlineCards: () => { void outlineViewTransitions?.show("cards"); },
      showReadThrough: () => { void outlineViewTransitions?.show("reading"); },
      outlineViewMode: () => continuousChapter?.isOpen() ? "continuous" : outlineView?.mode() ?? "manuscript",
      openCreation: () => creationChooser.open(),
      create: (itemType) => {
        // No title and no parent: both are properties of the walk, and the
        // outline unit reads the walk inside its own serialized body. A title
        // computed here would be numbered against a tree that may have changed
        // by the time the command lands.
        //
        // Swallowed for the same reason the bar swallows it: the outline unit
        // turns a failure into a banner of its own, and a rejection escaping a
        // synchronous menu handler would be unhandled.
        void outline?.create(itemType).catch(() => undefined);
      },
      createNote: () => {
        // Swallowed exactly as `create` is: the outline unit turns a failure
        // into a banner of its own, and a rejection escaping a synchronous menu
        // handler would be unhandled.
        void outline?.createNote().catch(() => undefined);
      },
      createBibleFolder: () => {
        void outline?.createBibleFolder().catch(() => undefined);
      },
      createTimeline: () => {
        // Swallowed exactly as `createNote` is.
        void outline?.createTimeline().catch(() => undefined);
      },
      createMatter: (kind) => {
        // Swallowed exactly as `createNote` is.
        void outline?.createMatter(kind).catch(() => undefined);
      },
      move: (direction) => {
        const id = selectedId();
        // Nothing selected is not an error - there is simply no row to move,
        // exactly as for rename.
        if (id === null) return;
        // Swallowed like every other menu action here: the outline unit turns a
        // failure into a banner of its own.
        void outline?.move(id, direction).catch(() => undefined);
      },
      beginRename: () => {
        const id = selectedId();
        // Nothing selected is not an error - there is simply no row to name.
        if (id === null) return;
        renamePanel?.open(id, navigator.activeTitle());
      },
      // THE ACTION TAKEN IS THE ONE THE WRITER READ. `offering` is written by
      // `selectedTrashed` below, which the menu calls when it PAINTS the item's
      // label, and read here when the item runs. Deriving it again at run time
      // would let a selection change between paint and click silently turn a
      // Restore into a Delete - which is the outline bar's recorded rule, kept
      // now that the bar that held it is gone.
      removeOrRestore: () => {
        const id = selectedId();
        // Nothing selected is not an error, exactly as for rename.
        if (id === null) return;
        const act = offering === "restore" ? outline?.restore : outline?.remove;
        // Swallowed like every other outline call from a synchronous menu
        // handler: the unit banners its own failures.
        void act?.(id).catch(() => undefined);
      },
      selectedTrashed: () => {
        const id = selectedId();
        offering = id !== null && isTrashedIn(latestItems, id) ? "restore" : "delete";
        return offering === "restore";
      },
    },
    destroy(): void {
      projectDestroyed = true;
      timelineMount?.destroy();
      timelineMount = null;
      uninstallInspector();
      reviewPanel?.destroy();
      outlineViewTransitions?.cancel();
      outlineView?.destroy();
      referenceRail?.destroy();
      craftPanel?.destroy();
      editorPane.hidden = false;
      // Deliberately does NOT flush. The caller drains first, so a teardown can
      // never be the thing that decides whether the user's text was saved: a
      // flush from here would be an unawaited write racing the next mount, and
      // its failure would have no surface left to report on.
      // First, and before anything else can arm it again. Nulling the field
      // below only drops one reference: the session closes over the same
      // scheduler, and an armed debounce timer holds a live callback that would
      // fire into a store these item ids no longer describe.
      flusher?.stop();
      // Before the navigator, for the same reason the bar is: an outline
      // operation already in flight cannot be cancelled, and when it lands its
      // reload calls navigator.reload on a DESTROYED navigator. That does not
      // throw, and the navigator's container is still #nav - the element the
      // next project mounts into - so the dead project's walk would set the live
      // navigator's scroll position and point its aria-activedescendant at a row
      // computed from a tree nobody is looking at. Nulling the field below drops
      // one reference only; the bar and the navigator's onMove both close over
      // the same unit.
      history?.destroy();
      // Latches and unregisters its document-level outside-click listener,
      // which would otherwise outlive every element this mount owns and
      // accumulate one live closure per project switch.
      mirrorChanges?.destroy();
      comments?.destroy();
      sceneNotes?.destroy();
      sceneNotes = null;
      document.removeEventListener("keydown", onCommentChord);
      for (const type of ["beforeinput", "paste", "keydown", "cut", "drop"] as const) document.removeEventListener(type, onContinuousInput, true);
      continuousChapter?.destroy();
      // Latches and unregisters its document-level outside-click listener, which
      // would otherwise outlive every element this mount owns and accumulate one
      // live closure per project switch - the recorded menu-bar shape that only
      // counting finds.
      statistics?.destroy();
      analytics?.destroy();
      // Before the outline unit it calls into, and latching for the same reason
      // the statistics panel does: it registers a document-level outside-click
      // listener that would otherwise outlive every element this mount owns.
      revisionPanel?.destroy();
      // Latching for the reason the panel above does: it registers a
      // document-level outside-click listener that would otherwise outlive
      // every element this mount owns and accumulate one live closure per
      // project switch.
      synopsisPanel?.destroy();
      // Latching for the reason the panel above does: it registers a
      // document-level outside-click listener that would otherwise outlive every
      // element this mount owns and accumulate one live closure per project
      // switch.
      castPanel?.destroy();
      appearancesPanel?.destroy();
      appearancesMap?.destroy();
      // Latching for the reason the panels above do: it registers a
      // document-level outside-click listener that would otherwise outlive every
      // element this mount owns.
      designPanel?.destroy();
      // Latching for the reason the panels above do, and the viewer as well:
      // both register a document-level outside-click listener that would
      // otherwise outlive every element this mount owns, and the viewer holds
      // the largest bytes this page ever carries.
      coversPanel?.destroy();
      identityPanel?.destroy();
      preflightPanel?.destroy();
      pictureViewer?.destroy();
      // No document-level listener to unregister -- the rail deliberately has
      // none -- but it holds a whole rendered book in its DOM, which is the
      // largest thing in this page after the manuscript itself.
      previewRail?.destroy();
      // Before the navigator whose rows it acts on, and latching for the reason
      // the two panels above do: it registers a document-level keydown and a
      // document-level outside-click listener, either of which would otherwise
      // outlive every element this mount owns.
      navContextMenu?.destroy();
      outline?.destroy();
      sectionMovePrompt.destroy();
      // Latches and unregisters its document-level outside-click listener, which
      // would otherwise outlive every element this mount owns and accumulate one
      // live closure per project switch.
      creationChooser.destroy();
      bibleCreate.destroy();
      renamePanel?.destroy();
      // Latches too: a project_word_count issued before this and answered after
      // it would otherwise paint a dead project's total into the element the
      // next mount has already taken over.
      wordCount?.destroy();
      // Latches for the same reason: an export issued before this and answered
      // after it would re-enable and report through a dead project's callbacks,
      // into the element the next mount has already taken over.
      exportBar?.destroy();
      // Latches: an onSelection call arriving after this (the editor is torn
      // down a few lines below, not before) would otherwise arm a debounce
      // timer whose show() later styles and un-hides an element already
      // removed from the document. Also removes its own document- and
      // window-level scroll, resize and focusout listeners, which would
      // otherwise outlive every element this mount owns and accumulate one
      // handler per project switch, the same shape the outline bar's own
      // outside-click listener has above.
      formatBubble?.destroy();
      // Wakes the chrome (never leaves a hidden header behind a torn-down
      // editor) and removes its own document-level listeners and observer,
      // same shape as the bubble's own teardown just above.
      chromeFade?.destroy();
      // Removes its own document-level pointer, keydown and scroll listeners,
      // the bubble's own reason: leaked, they would outlive every element
      // this mount owns and accumulate one live set per project switch.
      castCard?.destroy();
      document.removeEventListener("keydown", onCastCardChord);
      // Latches for the same reason, AND removes a listener on `document` that
      // would otherwise outlive every element this mount owns: a leaked copy
      // answers Ctrl+F after a switch by focusing an input no longer in the
      // page, and accumulates one handler per project switch. Before the
      // navigator, because a result click landing between the two teardowns
      // would ask a destroyed navigator to select a row.
      findBar?.destroy();
      // Binds TWO document-level listeners (Ctrl+P and the outside-click closer),
      // so leaking it accumulates one live pair per project switch.
      quickOpen?.destroy();
      // ON THE DOCUMENT, so it outlives every element this mount owns. A leaked
      // copy answers Alt+Left after a switch by opening an item id from the
      // previous manuscript in the navigator the NEXT project has mounted, and
      // accumulates one live closure per switch. Nothing in the DOM would show
      // it: the recorded menu-bar defect, where only counting found it.
      document.removeEventListener("keydown", onHistoryChord);
      document.removeEventListener("keydown", onExportChord);
      // A live callback into a project that is going away, and its result would
      // reach the navigator the NEXT project has already mounted - the defect
      // the outline slice shipped once. The latch covers a request already in
      // flight, which the timer cannot.
      countsDestroyed = true;
      if (countTimer !== null) {
        clearTimeout(countTimer);
        countTimer = null;
      }
      // Latches for the same reason as the others, and it matters more here: the
      // scheduler's onStateChange closure outlives this mount, so a flush
      // settling after teardown would paint a dead project's save state into the
      // element the next mount has already taken over - and "Saved" about the
      // wrong manuscript is the one thing this surface must never say.
      saveIndicator?.destroy();
      // AND ITS HOST SUBSCRIPTION. Unlike the save indicator this unit holds
      // one, so a switch that left it attached would stack one live closure per
      // project - the recorded shape of the menu bar's leaked document handler,
      // which no behavioural test could see.
      recoveryIndicator?.destroy();
      // Holds a host subscription too, and leaks the same way if it is not
      // released.
      archiveIndicator?.destroy();
      // Third subscription, third leak if it is not released.
      mirrorIndicator?.destroy();
      // After the three that report into it, so a state landing during their
      // teardown has a dot to land on rather than a torn-down one.
      statusDot.destroy();
      sceneNameEl.textContent = "";
      sceneNameEl.hidden = true;
      sceneNameEl.removeEventListener("click", onSceneNameClick);
      sceneNameTip.anchor.replaceWith(sceneNameEl);
      sceneNameTip.destroy();
      sceneHeadingEl.textContent = "";
      navigator.destroy();
      editor.destroy();
      mounted.flusher = null;
      mounted.outline = null;
      // The banners belong to the project that raised them. Leaving one standing
      // across a remount would tell the writer their NEW manuscript failed to
      // save, and the latch means the next mount could never replace it.
      noticeBanner.destroy(["persist-error", "open-error"]);
    },
  };
  return mounted;
}
