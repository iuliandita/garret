import { localizedInvoke } from "./command-error";
import { createPrivacyStartupInvoke, waitForPrivacyUnlock, type PrivacyStatus } from "./privacy";
// app/ui/src/main.ts
// Page assembly and the soak loop. Mode comes from the HOST at runtime, not
// from a build-time define: discovery baked variants into separate bundles, so
// its control and test ran different code. One bundle, one switch, is the whole
// point of a negative control.
import { t } from "./i18n";
import { createMutationPlanner } from "./measure/mutation-plan";
import { createOnsetTracker } from "./measure/onset";
import { measure, type Sample } from "./measure/recorder";
import { percentiles } from "./measure/stats";
import { summarize } from "./measure/summary";
import { ACTION_EFFECTS, buildWorkload, WORKLOAD_SCRIPT } from "./measure/workload";
import { type ProjectItem } from "./store/source";
import { bodyHash } from "./store/hash";
import { dailyTargetFrom } from "./goals";
import { timeTrackingFrom } from "./writing-time";
import { wireLifecycle } from "./lifecycle";
import { createClosePrompt } from "./close-prompt";
import { mountProject, type MountedProject } from "./project";
import { mountEmpty } from "./empty-project";
import { createBookCopyPrompt, type BookCopyConflict } from "./book-copy-prompt";
import { createProjectSwitcher } from "./project-switch";
import { createSwitcher, lossesNotice, type Switcher, type ProjectSummary } from "./switcher";
import {
  createLibrary,
  type Library,
  type LibraryIdentity,
  type LibraryOverview,
  type LibraryWordsAnswer,
} from "./library";
import {
  createPreferences,
  isLocale,
  isStart,
  type Locale,
  type Preferences,
  type Start,
} from "./preferences";
import { createFocusToggle, createOutlineToggle, type FocusToggle } from "./chrome-toggles";
import { createMenuBar } from "./menu-bar";
import { createQuit } from "./quit";
import { createHelpPanel } from "./help";
import { themeFamilyFrom, themeFrom, type Theme } from "./theme";
import { typographyFrom, type Typography } from "./typography";
import { showProjectLoading } from "./loading";
import { writingModesFrom } from "./writing-modes";
import { installZoomKeys, zoomFrom, type Zoom } from "./zoom";
import type { Archive, ArchiveReport } from "./archive-indicator";
import type { ImportOutcome, ImportReport, MirrorCheck, MirrorPreview, MirrorReport } from "./switcher";
import {
  readRecoveryReport,
  startupRecoverySentence,
  type RecoveryPoint,
} from "./recovery-indicator";

export { SLOW_FRAME_MS } from "./measure/summary";

declare global {
  interface Window {
    __appPrivacyLocked?: boolean;
    __appCandidate?: string;
    __appSeed?: string;
    __appMode?: string;
    __appSoakMs?: number;
    __appTypingChars?: number;
    __appNavJumps?: number;
    __appActionDelayMs?: number;
    __appSink?: (payload: unknown) => void;
    __appFocusMode?: string;
    __appTypewriter?: string;
    __appSpelling?: string;
    __appThemeFamily?: string;
    /** The language tag the host writes in, from settings.json. Read by
     *  `i18n/index.ts` to choose the catalog; listed here because this
     *  interface is where the host-to-page channel is enumerated. */
    __appLocale?: string;
    /** Whether minutes with an edit are counted, from settings.json. */
    __appTimeTracking?: string;
    /** Whether a cast member's name is marked in the open scene's prose,
     *  from settings.json. A bare boolean, unlike every other
     *  injected preference: there is no spelling of it to validate. */
    __appMarkCastNames?: boolean;
    __appProject?: string;
    /** A copied book the host deferred until the page can ask whether it is
     *  the same book or a separate one. */
    __appPendingProject?: string;
    /** What the window opened onto, from settings.json's `start`: "home" |
     *  "last" | "blank". Two readers: this function tells an old
     *  host (`__appProject` AND this both absent) from an empty boot
     *  (`__appProject` the empty string, this a real word), and the
     *  preferences panel's new group reads it for its initial selection. */
    __appStart?: string;
    __appPersistMode?: string;
    /** The writer's palette preference, from settings.json. Also read by the
     *  head script in index.html, which applies it before first paint. */
    __appTheme?: string;
    /** The interface zoom word, from settings.json. The host applies this as
     *  WebKit page zoom itself; the page only reads it back to paint the
     *  preferences row it agrees with. */
    __appZoom?: string;
    // Narrowed per axis by typographyFrom, not trusted as written: the host
    // validates what it injects, so a value arriving here that is not one of
    // the known words means the injection was lost.
    __appProseFamily?: string;
    __appProseSize?: string;
    __appProseMeasure?: string;
    /** How many words a day the writer is aiming for. NOT read by the head
     *  script: a goal cannot flash, so it does not have to be on the root
     *  before first paint. */
    __appDailyTarget?: string;
    __appMutations?: number;
    __appRun?: string;
    /** Which open of which project the host currently holds. Sent with every
     *  flush and refused by the host when it does not match. */
    __appGeneration?: number;
    __TAURI__?: {
      core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
      event?: { listen: (event: string, cb: (event?: { payload: number }) => void | Promise<void>) => Promise<unknown> };
    };
  }
}

interface CycleRecord {
  cycle: number;
  atMs: number;
  typingP95Ms: number;
  charsTyped: number;
  partial: boolean;
}

async function main(): Promise<void> {
  const transport = window.__TAURI__?.core.invoke;
  const rawInvoke = transport ? localizedInvoke(transport) : undefined;
  if (rawInvoke && window.__TAURI__?.event?.listen) {
    await waitForPrivacyUnlock(rawInvoke, window.__TAURI__.event.listen);
  }
  const entryAt = performance.now();
  const mode = window.__appMode === "naive" ? "naive" : "virtual";
  const soakMs = typeof window.__appSoakMs === "number" ? window.__appSoakMs : 60_000;
  const typingChars = typeof window.__appTypingChars === "number" ? window.__appTypingChars : 400;
  const navJumps = typeof window.__appNavJumps === "number" ? window.__appNavJumps : 60;
  // Every action awaits a double-rAF, which pins the loop at ~33 ms/action, so
  // total actions and elapsed time are the same axis in every run recorded so
  // far and no rerun of this workload can tell them apart. A per-action delay
  // is the one knob that separates them: it changes ms/action without changing
  // what an action does.
  const actionDelayMs =
    typeof window.__appActionDelayMs === "number" ? window.__appActionDelayMs : 0;

  // Since 2026-08-10 the host opened the library's project or created a default,
  // so there was no boot without a project on disk; this adds one, with
  // `start` "home" or "blank" and no `APP_PROJECT`. The two are told apart by
  // `__appStart`, injected on every launch: an EMPTY project path
  // together with a real start word is the empty boot, and only the absence of
  // BOTH is the old failure this always threw for -- a host built before this
  // slice, or no host at all. The page's separate corpus.json boot path is
  // still gone rather than revived (it built no export bar, no find, no save
  // indicator, no word count and no rename panel, so it graded a screen the
  // product does not have) -- this is not that path back.
  const projectPath = window.__appProject ?? "";
  if (window.__appProject === undefined && window.__appStart === undefined) {
    throw new Error("the host reported no project path: there is nothing to open");
  }
  // A measurement run needs a real manuscript to type into and navigate --
  // the empty workspace has no navigator rows and no ProseMirror document
  // behind it, both inert stubs (empty-project.ts). Without this guard the
  // soak below would run its full workload over those stubs and sink a
  // payload that reads as "a healthy run that measured nothing", the exact
  // failure mode this application has cost five retracted instruments to.
  // Checked before anything mounts: `run` does not depend on the mount, and
  // there is no reason to build the empty workspace only to throw past it.
  const run = window.__appRun === "measure" ? "measure" : "interactive";
  if (run !== "interactive" && projectPath === "") {
    throw new Error(
      "a measurement run needs APP_PROJECT: the empty workspace has no manuscript to soak",
    );
  }
  const persistMode = window.__appPersistMode === "verify" ? "verify" : "write";
  const startup = rawInvoke && window.__TAURI__?.event?.listen
    ? createPrivacyStartupInvoke(rawInvoke, window.__TAURI__.event.listen) : undefined;
  const invoke = startup?.invoke ?? rawInvoke;

  // Held here rather than inside a mount, because the preferences panel outlives
  // every project: it is mounted once and a switch tears the manuscript down
  // around it. A getter rather than a value, so a project mounted after the
  // writer changes their goal starts on the new one instead of on the one the
  // window launched with.
  let dailyTarget = dailyTargetFrom(window.__appDailyTarget);
  // The same shape, for the same reason: the switch is read per edit and a
  // project mounted after it was flipped must see the new state.
  let timeTracking = timeTrackingFrom(window.__appTimeTracking);
  // Follows what the host has applied to this webview. The page never draws
  // this itself -- see zoom.ts -- it only needs the current word so the Ctrl
  // chords and the preferences panel can agree on where they are; when the
  // host refuses a change (settings_set_zoom rejects) both call sites below
  // put this back to what it was, because the host records first and applies
  // only on success and a page ahead of a refused write is a phantom word the
  // next chord would step from.
  let zoom: Zoom = zoomFrom(window.__appZoom);
  // The same shape as `dailyTarget` and `timeTracking`, and for the same
  // reason: a project mounted after the writer flips this must start on the
  // new value. Absent reads as on -- the host's own default.
  let markCastNames = window.__appMarkCastNames !== false;
  let privacyStatus: PrivacyStatus = { enabled: false, locked: true, recovery: false, shortcut: "ctrl_alt_l" };
  // The preferences panel's dictionary route, set once the panel exists
  // (below, beside the menu bar): the mount hands it to every project.
  let addWordToDictionary: ((word: string) => Promise<string>) | undefined;

  const mountAt = async (generation: number): Promise<MountedProject> =>
    mountProject({
      mode,
      seed: window.__appSeed ?? "unknown",
      persistMode,
      projectPath,
      invoke,
      markCastNames: () => markCastNames,
      privacyLocked: () => privacyStatus.locked || privacyStatus.recovery,
      openProjectPanel: () => switcherHandle?.open("copies"),
      // Through the panel, not straight to the host: the panel holds the
      // list it paints, and a word that reached the host behind its back
      // would be missing from Preferences until the next project switch.
      addToDictionary: (word) => {
        if (addWordToDictionary === undefined) throw new Error("preferences not mounted");
        return addWordToDictionary(word);
      },
      // The recovery surface re-reads the files whenever the host says they
      // changed. Handed in rather than reached for, because project.ts takes
      // every capability it uses as a dependency.
      listen: window.__TAURI__?.event?.listen,
      generation,
      dailyTarget: () => dailyTarget,
      timeTracking: () => timeTracking,
      setTimeTracking: async (tracking) => {
        // PERSIST FIRST, then the module's copy: a switch that reached the
        // page and not the file would read as on again next launch. No host
        // (a browser run) keeps the switch for the window only.
        if (invoke !== undefined) await invoke("settings_set_time_tracking", { tracking });
        timeTracking = tracking;
      },
    });

  // Bound once the switcher exists, below; `mountEmpty`'s "Open the library"
  // button is built and can be pressed before that, so this starts undefined
  // and the callback reads whatever it has been set to by the time a writer
  // actually presses it - the same late-binding `openHelp: () => help.open()`
  // relies on further down this function.
  let switcherHandle: Switcher | undefined;
  // Same reason, same shape: the library screen is built beside the
  // switcher, once `invoke` is known to exist, but `mountEmpty`'s button is
  // built before that.
  let libraryHandle: Library | undefined;

  // THE FIRST MOUNT SAYS SO TOO, not only a switch. index.html ships an empty
  // #nav and an empty #editor and every unit builds its own content, so until
  // the walk and the first document arrive the window is blank - and the cost
  // scales with the manuscript, so it is longest for the writers with the most
  // in it. Removed in a `finally`, because a mount that throws is caught by
  // main()'s handler and must not leave a loading state under the failure it
  // renders.
  showProjectLoading(true);
  let mounted: MountedProject;
  try {
    // An empty `projectPath` is the no-project boot: the empty
    // workspace stands in for a book rather than throwing, `mountProject`'s
    // own reason for existing.
    mounted =
      projectPath === ""
        ? mountEmpty({ openLibrary: () => libraryHandle?.open() })
        : await mountAt(window.__appGeneration ?? 1);
  } finally {
    showProjectLoading(false);
  }
  const {
    navigator,
    editor,
    session,
    source,
    storeItems,
    activeDocId,
    activeDocRev,
    loadedBodyHash,
    flusher,
    raiseFailure,
  } = mounted;

  // The human's path. No soak, no mutation phase, no expectation payload: this
  // is the application, and everything below this block is instrumentation.
  if (run === "interactive") {
    // `current` is the only thing a project switch replaces. The measure fork
    // below destructured `mounted` into consts, which is safe precisely because
    // it returns before any switcher exists: a soak never switches projects.
    let current = mounted;
    let currentPath = projectPath;
    let currentGeneration = window.__appGeneration ?? 1;
    // "project" is the earlier placeholder, overwritten below the instant
    // `project_current` answers; at an empty boot nothing ever answers, so an
    // empty boot starts on the empty string instead, which is what a real
    // switch's own name updates land on top of just the same.
    let currentName = projectPath === "" ? "" : "project";

    const prepareArchive = async (purpose: "archive" | "mirror" = "archive"): Promise<number> => {
      const project = current;
      const path = currentPath;
      const generation = currentGeneration;
      const session = project.session;
      const flusher = project.flusher;
      if (path === "" || session === null || flusher === null) throw new Error(t(purpose === "archive" ? "archive.error.closed" : "mirror.error.closed"));
      await session.flushPending();
      if (flusher.failed() || project.persistError() !== null) throw new Error(t(purpose === "archive" ? "archive.error.unsaved" : "mirror.error.unsaved"));
      if (current !== project || currentPath !== path || currentGeneration !== generation || project.flusher !== flusher) {
        throw new Error(t(purpose === "archive" ? "archive.error.changed" : "mirror.error.changed"));
      }
      return generation;
    };

    if (invoke !== undefined) {
      // The switcher's own element, not the whole strip: it clears its
      // container on construction and on teardown, and the word count shares
      // the bar with it.
      const bar = document.getElementById("project-controls");
      if (bar === null) {
        throw new Error("page shell is missing #project-controls: index.html and main.ts disagree");
      }
      // The strip above the outline, where the book's NAME lives as of slice
      // Thrown for rather than defaulted: a missing header would leave the
      // application with no title anywhere and no rename at all, silently.
      const navHeader = document.getElementById("nav-header");
      if (navHeader === null) {
        throw new Error("page shell is missing #nav-header: index.html and main.ts disagree");
      }
      const opened = (await invoke("project_current")) as ProjectSummary | null;
      currentPath = opened?.path ?? currentPath;
      currentName = opened?.name ?? currentName;

      // Read once, here, for the same reason the palette and typography are:
      // this is the FIRST project's list, injected into the panel at
      // construction rather than fetched by it. `preferences` does not exist
      // yet, so a later switch cannot go through this constant - it goes
      // through `onSwitched` below instead, which is why that mutable binding
      // exists rather than a `const`.
      //
      // `null` AT AN EMPTY BOOT: `dict_list` answers the OPEN project's own
      // dictionary and errors with nothing open, so it is not called at all -
      // `Preferences.setDictionary`'s own doc comment names the same rule.
      const initialDictionary: string[] | null =
        projectPath === ""
          ? null
          : ((await invoke("dict_list")) as { word: string }[]).map((w) => w.word);
      // The header's Focus button, built once beside the menu bar below. The
      // panel reports every writing-mode change through `onWritingModes`, and
      // that callback is wired at construction, before the button exists -
      // hence a mutable binding and the optional call, not a `const`.
      let focusToggle: FocusToggle | null = null;
      // Parsed ONCE: the panel and the header's Focus button both start from
      // this value, and parsing the host's words twice would be two chances to
      // disagree about the default.
      const initialWritingModes = writingModesFrom({
        focus: window.__appFocusMode,
        typewriter: window.__appTypewriter,
      });
      const bookCopyPrompt = createBookCopyPrompt(document.body);

      const switchProject = createProjectSwitcher<MountedProject>({
        current: () => current,
        setCurrent: (next) => {
          current = next;
        },
        currentPath: () => currentPath,
        prepareOpen: async (path) => {
          const conflict = (await invoke("project_open_check", { path })) as BookCopyConflict | null;
          return conflict === null ? undefined : bookCopyPrompt.choose(conflict);
        },
        openProject: async (path, decision) =>
          (await invoke("project_open", { path, decision: decision ?? null })) as {
            path: string;
            name: string;
            generation: number;
          },
        mount: mountAt,
        // Only once the new project is actually mounted, and taken from the
        // host's answer rather than the requested path. Recording it when
        // project_open resolved would name a project that then failed to
        // mount: the header would show it, and both the switcher's and the
        // switcher-of-projects' `same` checks would swallow every retry.
        onSwitched: (opened) => {
          currentPath = opened.path;
          currentName = opened.name;
          currentGeneration = opened.generation;
          // A book is open now, whether or not one was a moment ago: undoes
          // the empty boot's own setBookOpen(false) below, the one case that
          // matters (a switch out of a real book into another leaves this
          // already true and the call a no-op).
          switcher.setBookOpen(true);
          // The dictionary is per-project and the panel is mounted once (see
          // its construction below), so a switch has to repaint this one group
          // by hand rather than being torn down and rebuilt with the rest of
          // the mount. Swallowed on failure: a stale word list is a lesser
          // problem than a notice competing with the switch's own.
          void invoke("dict_list")
            .then((words) => {
              preferences?.setDictionary((words as { word: string }[]).map((w) => w.word));
            })
            .catch(() => undefined);
        },
        // The loading state. `mountAt` tears the page down before it opens the
        // next project, so without this the writer watches a completely blank
        // application for as long as the open and the mount take - longest for
        // the manuscripts that matter most.
        onBusy: showProjectLoading,
        onFailure: (message) => {
          // switchProject destroys the outgoing mount BEFORE opening the next
          // one (project-switch.ts's own step 3); on failure `setCurrent` is
          // never called, so `current` is left pointing at that
          // already-destroyed object. Starting from a real book this reads
          // fine -- destroy() already restored the footer, and the banner
          // over it says "nothing is open, choose a project to continue"
          // (switch.error.closed). Starting from the EMPTY workspace it does
          // not: that destroy() also restored the footer, but there is no
          // book behind it either, so the writer would see live chrome (word
          // count, save state) around a bare #editor with no prompt and no
          // "Open the library" button. Remounting the empty workspace is
          // what a failed switch out of it always meant to fall back to.
          if (currentPath === "") {
            current = mountEmpty({ openLibrary: () => libraryHandle?.open() });
          }
          current.raiseNotice(message);
        },
      });

      const switcher = createSwitcher({
        container: bar,
        nameContainer: navHeader,
        listProjects: async () => (await invoke("project_list")) as ProjectSummary[],
        createProject: async (name) =>
          (await invoke("project_create", { name })) as ProjectSummary,
        // `null` is the writer cancelling the folder dialog, which the host
        // reports as `Ok(None)` and which is an answer rather than a failure.
        createProjectIn: async (name) =>
          (await invoke("project_create_pick", { name })) as ProjectSummary | null,
        newDir: async () => (await invoke("project_new_dir")) as string,
        listImports: async () => (await invoke("project_import_list")) as ImportReport,
        importProject: async (filename) =>
          (await invoke("project_import", { filename })) as ImportOutcome,
        listRecoveryPoints: async () => (await invoke("recovery_points")) as RecoveryPoint[],
        legacyProtection: async () =>
          (await invoke("legacy_protection")) as { surface: "recovery" | "mirror"; dir: string }[],
        // `pointId` camelCase on the way out, snake_case fields on the way
        // back: two different mechanisms, both recorded.
        restorePoint: async (id, allowPictureGaps = false) =>
          (await invoke("project_restore_point", { pointId: id, allowPictureGaps })) as ProjectSummary,
        listArchives: async () => (await invoke("archives")) as Archive[],
        archiveStatus: async () => (await invoke("archive_status")) as ArchiveReport,
        makeArchive: async () => (await invoke("project_archive_now", { generation: await prepareArchive() })) as Archive,
        generateArchiveKey: async () => (await invoke("encrypted_key_generate")) as { recipient: string } | null,
        makeEncryptedArchive: async () => (await invoke("encrypted_archive_create", { expectedGeneration: await prepareArchive() })) as { file: string; recipient: string; encrypted: true } | null,
        verifyEncryptedArchive: async () => (await invoke("encrypted_archive_verify")) as { file: string; encrypted: true } | null,
        restoreEncryptedArchive: async () => (await invoke("encrypted_archive_restore")) as ProjectSummary | null,
        canReportArchive: async () => {
          privacyStatus = await invoke("privacy_status") as PrivacyStatus;
          return !privacyStatus.locked && !privacyStatus.recovery;
        },
        currentGeneration: () => currentGeneration,
        mirrorStatus: async () => (await invoke("mirror_status")) as MirrorReport,
        previewMirror: async () => (await invoke("mirror_preview", { expectedGeneration: await prepareArchive("mirror") })) as MirrorPreview,
        enableMirror: async (on, token) => {
          if (on) await prepareArchive("mirror");
          return (await invoke("mirror_enable", { on, token })) as MirrorReport;
        },
        checkMirror: async () => (await invoke("mirror_check")) as MirrorCheck,
        // Through `current`, exactly as the menu bar's own `openCast` is wired
        // below: the header button must act on whichever manuscript is open
        // now, not the one that was open when the switcher was built.
        openCast: () => current.menuActions.openCast(),
        switchTo: async (path) => {
          await switchProject(path);
          // Repaint from whatever is actually open now, which on a failed
          // switch is the project we started from.
          switcher.refresh(currentName);
        },
        // The host answers with where the book is NOW; the module's own copy
        // of the path follows it, because the switcher's `aria-current`, its
        // "this book is at" line and every `same` check read that copy.
        moveProject: async () => {
          const moved = (await invoke("project_move")) as ProjectSummary | null;
          if (moved !== null) currentPath = moved.path;
          return moved;
        },
        currentPath: () => currentPath,
        currentName: () => currentName,
        renameProject: async (name) => {
          const renamed = (await invoke("project_rename", { name })) as ProjectSummary;
          // The module's own copy of the name, which every later `refresh` and
          // every project-switch fallback reads. Without this a failed switch
          // repaints the bar with the name the book had before the rename.
          currentName = renamed.name;
          return renamed;
        },
        forgetProject: async (path) => {
          await invoke("project_forget", { path });
        },
        onNotice: (message) => current.raiseNotice(message),
        onDone: (message) => current.announce(message),
        // Back to the manuscript. The panel used to hand focus to the button
        // beside it in the bar; with that button retired there is nowhere in the
        // strip to go, and <body> is not an answer. `current` is read at call
        // time, so a panel dismissed after a project switch focuses the editor
        // that is actually on screen rather than the one that was.
        onDismiss: () => current.editor.focus(),
        copiesNeedAttention: () => current.copiesNeedAttention?.() ?? false,
      });
      switcher.refresh(currentName);
      // Bound now for `mountEmpty`'s "Open the library" button and for
      // `menu-library`, both wired before the switcher existed.
      switcherHandle = switcher;
      // The empty boot's own state: `createSwitcher` builds the rename
      // button, its field and the cast button into #nav-header
      // unconditionally, before this line runs, so with nothing open they
      // would otherwise sit beside `library.no-book`'s sentence naming a
      // leftover project and offering a Cast panel with nothing in it.
      switcher.setBookOpen(projectPath !== "");

      // The library screen: built once, beside the switcher, as
      // application chrome that outlives any one project. `menu-library`
      // opens it whether or not a book is mounted; `openProjects` below
      // routes New/Open to it only while nothing is, because its other
      // sections (recovery, archives, the mirror) are about an open book.
      const library = createLibrary({
        overview: async () => (await invoke("library_overview")) as LibraryOverview,
        bookWords: async (path) => (await invoke("library_book_words", { path })) as LibraryWordsAnswer,
        bookStats: async (path, today) => (await invoke("library_book_stats", { path, today })) as import("./library-summary").BookStats,
        getMembership: async () => (await invoke("library_membership_get")) as import("./library-summary").MembershipView,
        saveMembership: async (generation, edit) => (await invoke("library_membership_set", { generation, edit })) as import("./library-summary").LibraryMembership,
        openBook: async (path) => {
          await switchProject(path);
          switcher.refresh(currentName);
        },
        createBook: async (name, identityId) => {
          const created = (await invoke("project_create", { name })) as ProjectSummary;
          await switchProject(created.path);
          switcher.refresh(currentName);
          if (identityId !== null) {
            try {
              await invoke("identity_pin", { id: identityId });
            } catch (error: unknown) {
              current.raiseNotice(
                t("library.error.pin", {
                  error: error instanceof Error ? error.message : String(error),
                }),
              );
            }
          }
        },
        forget: async (path) => {
          await invoke("project_forget", { path });
        },
        // The whole fresh identity list, never just an id: `identity_save`
        // now tolerates nothing being open (the library screen's own case),
        // and library.ts is what finds the one it just minted, by an
        // explicit diff against what it had before rather than by assuming
        // it landed last.
        saveIdentity: async (fields) => {
          const view = (await invoke("identity_save", {
            identity: {
              id: "",
              rev: 0,
              public: { name: fields.name, sort_name: fields.sort_name, bio: fields.bio, links: [] },
              publishing: { imprint: "", rights: "" },
              private: { legal_name: "", contact: "", admin: "" },
            },
          })) as { identities: LibraryIdentity[] };
          return view.identities;
        },
        persistHomeIdentity: async (id) => {
          await invoke("settings_set_home_identity", { id });
        },
        currentPath: () => currentPath,
        onNotice: (message) => current.raiseNotice(message),
        onDone: (message) => current.announce(message),
      });
      libraryHandle = library;
      // `home`, `home-cli`'s own gate: nothing mounted and the screen up.
      if (projectPath === "" && window.__appStart === "home" && window.__appPendingProject === undefined) {
        library.open();
      }

      // Inside this block on purpose: persisting the choice is a host command,
      // and a control that silently forgets what it was told is worse than no
      // control. Mounted once, not per project - a palette is an application
      // preference and a project switch must not tear it down.
      const prefsBar = document.getElementById("prefs-controls");
      if (prefsBar === null) {
        throw new Error("page shell is missing #prefs-controls: index.html and main.ts disagree");
      }
      const injectedLocale = window.__appLocale ?? "";
      let preferences: Preferences | undefined;
      const refreshPrivacy = async (): Promise<void> => {
        privacyStatus = await invoke("privacy_status") as PrivacyStatus;
        if (privacyStatus.locked || privacyStatus.recovery) current.reviewPrivacyChanged();
      };
      await window.__TAURI__?.event?.listen("app://privacy-changed", () => {
        void refreshPrivacy().catch(raiseFailure);
      });
      await refreshPrivacy();
      let lastPrivacyActivity = -Infinity;
      let lastPointer: { x: number; y: number } | undefined;
      const notePrivacyActivity = (event: Event): void => {
        if (!event.isTrusted || !privacyStatus.enabled || privacyStatus.locked ||
            event.timeStamp - lastPrivacyActivity < 500) return;
        if (event.type === "pointermove") {
          const pointer = event as PointerEvent;
          const at = { x: pointer.clientX, y: pointer.clientY };
          if (lastPointer?.x === at.x && lastPointer.y === at.y) return;
          lastPointer = at;
        }
        lastPrivacyActivity = event.timeStamp;
        void invoke("privacy_activity").catch(() => {});
      };
      for (const kind of ["keydown", "pointerdown", "pointermove", "wheel", "compositionupdate"] as const) {
        document.addEventListener(kind, notePrivacyActivity, { capture: true, passive: true });
      }
      const lockPrivacy = (): void => {
        if (!privacyStatus.enabled || privacyStatus.locked || privacyStatus.recovery) return;
        void invoke("privacy_lock").catch(raiseFailure);
      };
      preferences = createPreferences({
        openPrivacy: async () => { await invoke("privacy_settings"); },
        container: prefsBar,
        root: document.documentElement,
        initialTheme: themeFrom(window.__appTheme),
        initialThemeFamily: themeFamilyFrom(window.__appThemeFamily),
        persistThemeFamily: async (family) => {
          await invoke("settings_set_theme_family", { family });
        },
        // Anything unrecognized reads as "en", the same rule `themeFrom` and
        // every other narrowing function here follows: the host validates what
        // it injects, so a value that is not one of the two known tags means
        // the injection was lost or the page is running outside the host.
        // NARROWED, not cast: `isLocale` is a type guard, and asking it about
        // a value BOUND to `injectedLocale` lets TypeScript prove the branch
        // rather than being told with `as Locale` to trust a cast made on a
        // temporary expression.
        initialLocale: isLocale(injectedLocale) ? injectedLocale : "en",
        persistLocale: async (locale: Locale) => {
          await invoke("settings_set_locale", { locale });
        },
        // Same narrowing rule as the locale above: the host validates what it
        // injects, so an unrecognized word means the injection was lost or the
        // page is running outside the host, and "last" (today's behaviour,
        // unchanged) is the safe read for either.
        initialStart: isStart(window.__appStart ?? "") ? (window.__appStart as Start) : "last",
        persistStart: async (start) => {
          await invoke("settings_set_start", { start });
        },
        initialDictionary,
        persistDictAdd: async (word) => {
          const added = (await invoke("dict_add", { word })) as { word: string };
          return added.word;
        },
        persistDictRemove: async (word) => {
          await invoke("dict_remove", { word });
        },
        initialTypography: typographyFrom({
          family: window.__appProseFamily,
          size: window.__appProseSize,
          measure: window.__appProseMeasure,
        }),
        persistTheme: async (theme: Theme) => {
          await invoke("settings_set_theme", { theme });
        },
        initialDailyTarget: dailyTarget,
        initialSpelling: window.__appSpelling === "off" ? "off" : "on",
        persistSpelling: async (spelling) => {
          // The host both records this AND applies it to the live webview: the
          // underlines belong to WebKitWebContext, which the page cannot reach.
          await invoke("settings_set_spelling", { spelling });
        },
        initialMarkCastNames: markCastNames,
        persistMarkCastNames: async (on) => {
          await invoke("settings_set_mark_cast_names", { mark: on });
          markCastNames = on;
        },
        onMarkCastNames: (on) => current.setMarkCastNames(on),
        initialWritingModes,
        onWritingModes: (modes) => focusToggle?.set(modes.focus),
        initialZoom: zoom,
        persistZoom: async (next) => {
          const previous = zoom;
          zoom = next;
          // The host both records this AND applies it to the live webview:
          // page zoom belongs to WebKit, which the page cannot reach. On a
          // refusal the page is put back to what the webview still shows,
          // and the error is rethrown so preferences.ts's own record() still
          // raises its notice and repaints the panel.
          try {
            await invoke("settings_set_zoom", { zoom: next });
          } catch (error: unknown) {
            zoom = previous;
            throw error;
          }
        },
        onDailyTarget: (target) => {
          dailyTarget = target;
          // The bar belongs to the mounted project, and the panel does not.
          // Going through `current` rather than a captured reference is what
          // keeps a goal set after a switch reaching the manuscript on screen
          // instead of the one that was open when the panel was built.
          current.setDailyTarget(target);
        },
        persistDailyTarget: async (target) => {
          await invoke("settings_set_daily_target", { target });
        },
        persistWritingModes: async (modes) => {
          // Spread rather than passed whole, like the typography: the command's
          // two arguments are non-Option on the host side, so a renamed field
          // here is a loud deserialization error rather than a silent default.
          await invoke("settings_set_writing_modes", { ...modes });
        },
        persistTypography: async (typography: Typography) => {
          // Spread rather than passed whole: the command's three arguments are
          // non-Option on the host side, so a renamed field here is a loud
          // deserialization error rather than a silent default.
          await invoke("settings_set_typography", { ...typography });
        },
        onNotice: (message) => current.raiseNotice(message),
        onDone: (message) => current.announce(message),
        // Back to the manuscript, and read at call time for the same reason
        // `onDailyTarget` is: a panel dismissed after a project switch must
        // focus the editor on screen, not the one that was there when the
        // panel was built.
        onDismiss: () => current.editor.focus(),
      });
      addWordToDictionary = (word) => preferences.addWord(word);

      // Ctrl+= / Ctrl+- / Ctrl+0 from anywhere in the page. The panel is told
      // so it shows the word the writer is now at; the host records and draws
      // it. No teardown: this listener is application chrome, like the panel
      // and the menu bar around it, and lives as long as the window.
      installZoomKeys(document, {
        current: () => zoom,
        set: (next) => {
          const previous = zoom;
          zoom = next;
          preferences.setZoom(next);
          void invoke("settings_set_zoom", { zoom: next }).catch((error: unknown) => {
            // Refused: put the word and the panel back, or the next chord
            // steps from a screen the host never actually reached.
            zoom = previous;
            preferences.setZoom(previous);
            current.raiseNotice(
              t("prefs.error.save", { what: t("prefs.what.zoom"), error: String(error) }),
            );
          });
        },
      });

      // The header's two toggles. Built ONCE with the menu bar, for the same
      // reason and with the same consequence: application chrome, never torn
      // down by a project switch, so neither is destroyed here. The Focus
      // button owns no state - it asks the preferences panel, which reports
      // back through `onWritingModes` above.
      const outlineEl = document.getElementById("outline-controls");
      const focusEl = document.getElementById("focus-controls");
      if (outlineEl === null || focusEl === null) {
        throw new Error(
          "page shell is missing #outline-controls or #focus-controls: index.html and main.ts disagree",
        );
      }
      createOutlineToggle({ container: outlineEl, body: document.body });
      focusToggle = createFocusToggle({
        container: focusEl,
        initial: initialWritingModes.focus,
        setFocus: (mode) => preferences.setFocus(mode),
      });

      // The application menu. Built ONCE and never rebuilt: it is application
      // chrome, like the preferences panel above, and a project switch must not
      // tear it down. Everything project-shaped is reached through `current`
      // rather than captured, so the menu always acts on the manuscript that is
      // open now and not the one that was open when it was built.
      const menuBar = document.getElementById("menu-controls");
      if (menuBar === null) {
        throw new Error("page shell is missing #menu-controls: index.html and main.ts disagree");
      }
      // ORDER IS LOAD-BEARING: createMenuBar calls container.replaceChildren()
      // on this same element, so a help panel appended BEFORE it is detached
      // the instant the menu is built - and `help.open()` then flips `hidden`
      // on an element that is not in the document. That shipped once and the
      // panel never displayed. No unit test could see it (the element
      // exists, the flag flips) and no gate could either; a screenshot found
      // it once. `help` is referenced by the callback below, not at construction
      // time, so declaring it after is safe.
      createMenuBar({
        container: menuBar,
        // New/Open route to the library screen while nothing is mounted --
        // the switcher's other sections (recovery, archives, the mirror) are
        // about an open book, so with one open these stay the switcher's.
        openProjects: (focus) => (currentPath === "" ? library.open() : switcher.open(focus)),
        // Always the screen, whether or not a book is open behind it.
        openLibrary: () => library.open(),
        renameProject: () => switcher.beginRename(),
        openPreferences: () => preferences.open(),
        lockPrivacy,
        privacyShortcut: () => privacyStatus.shortcut,
        canLockPrivacy: () => privacyStatus.enabled && !privacyStatus.locked && !privacyStatus.recovery,
        openHelp: () => help.open(),
        openBookDesign: () => current.menuActions.openBookDesign(),
        openCovers: () => current.menuActions.openCovers(),
        openIdentities: () => current.menuActions.openIdentities(),
        openEpubPreview: () => current.menuActions.openEpubPreview(),
        openPdfPreview: () => current.menuActions.openPdfPreview(),
        exportProject: () => current.menuActions.exportProject(),
        exportAs: () => current.menuActions.exportAs(),
        exportDocx: () => current.menuActions.exportDocx(),
        backupNow: () => current.menuActions.backupNow(),
        // Handled HERE rather than through `menuActions`, because an import
        // creates a project and does not touch the open one. On success the
        // panel is opened on the list, which reloads it: the new project
        // appearing there is the whole feedback, and it is the same feedback the
        // drop-folder route gives. Import deliberately does not switch to it -
        // a writer mid-scene must not be moved to another book.
        importProject: () => {
          void invoke("project_import_pick")
            .then((created) => {
              // null is the writer cancelling. Nothing happened because that is
              // what they chose; reporting it back would be reporting their own
              // decision to them as an event.
              if (created === null || created === undefined) return;
              const notice = lossesNotice((created as ImportOutcome).losses, (created as ImportOutcome).derived_contents);
              if (notice !== null) current.announce(notice);
              switcher.open("list");
            })
            .catch((err: unknown) => {
              current.raiseNotice(t("project.error.import", { error: String(err) }));
            });
        },
        openFind: () => current.menuActions.openFind(),
        openQuickOpen: () => current.menuActions.openQuickOpen(),
        openReplace: () => current.menuActions.openReplace(),
        openHistory: () => current.menuActions.openHistory(),
        openMirrorChanges: () => current.menuActions.openMirrorChanges(),
        openComments: () => current.menuActions.openComments(),
        addComment: () => current.menuActions.addComment(),
        addToDictionary: () => current.menuActions.addToDictionary(),
        openStatistics: () => current.menuActions.openStatistics(),
        openAnalytics: () => current.menuActions.openAnalytics(),
        openRevisionState: () => current.menuActions.openRevisionState(),
        openReviewProposals: () => current.menuActions.openReviewProposals(),
        openSynopsis: () => current.menuActions.openSynopsis(),
        openCast: () => current.menuActions.openCast(),
        openKnowledge: () => current.menuActions.openKnowledge(),
        openCraftReports: () => current.menuActions.openCraftReports(),
        openAppearances: () => current.menuActions.openAppearances(),
        openAppearancesMap: () => current.menuActions.openAppearancesMap(),
        navBack: () => current.menuActions.navBack(),
        navForward: () => current.menuActions.navForward(),
        canNavBack: () => current.menuActions.canNavBack(),
        canNavForward: () => current.menuActions.canNavForward(),
        undo: () => current.menuActions.undo(),
        redo: () => current.menuActions.redo(),
        outlineUndo: () => current.menuActions.outlineUndo(),
        outlineRedo: () => current.menuActions.outlineRedo(),
        outlineUndoLabel: () => current.menuActions.outlineUndoLabel(),
        outlineRedoLabel: () => current.menuActions.outlineRedoLabel(),
        showManuscript: () => current.menuActions.showManuscript(),
        showOutlineTable: () => current.menuActions.showOutlineTable(),
        showOutlineCards: () => current.menuActions.showOutlineCards(),
        showReadThrough: () => current.menuActions.showReadThrough(),
        showContinuousChapter: () => current.menuActions.showContinuousChapter(),
        openReference: () => current.menuActions.openReference(),
        closeReference: () => current.menuActions.closeReference(),
        outlineViewMode: () => current.menuActions.outlineViewMode(),
        create: (itemType) => current.menuActions.create(itemType),
        createNote: () => current.menuActions.createNote(),
        createBibleFolder: () => current.menuActions.createBibleFolder(),
        createTimeline: () => current.menuActions.createTimeline(),
        createMatter: (kind) => current.menuActions.createMatter(kind),
        move: (direction) => current.menuActions.move(direction),
        beginRename: () => current.menuActions.beginRename(),
        removeOrRestore: () => current.menuActions.removeOrRestore(),
        selectedTrashed: () => current.menuActions.selectedTrashed(),
        quit: () => quit.run(),
      });
      // AFTER the menu bar, deliberately. See the note above.
      const help = createHelpPanel({ container: menuBar, privacyShortcut: () => privacyStatus.shortcut });
      if (window.__appPendingProject !== undefined && window.__appPendingProject !== "") {
        void switchProject(window.__appPendingProject).then(() => switcher.refresh(currentName));
      }
    }

    // OUTSIDE the menu block above and never destroyed, like the menu bar and the
    // help panel: leaving is not project-shaped, and a project switch must not
    // take the only way out of the application down with it.
    //
    // A failed request is REPORTED. The writer pressed Quit; if the host did not
    // take it the window simply stays open, and an application that swallows
    // that is one that ignored them.
    const quit = createQuit({
      requestQuit: () => {
        // No host is the fixture path -- the page running in a browser with no
        // window of its own to close, where the browser owns leaving. Nothing to
        // ask and nothing to report.
        if (invoke === undefined) return;
        void invoke("request_quit").catch((err: unknown) => {
          current.raiseNotice(t("project.error.quit", { error: String(err) }));
        });
      },
    });

    {
      const closePrompt = createClosePrompt({ container: document.body });
      const lifecycleReady = await wireLifecycle({
        // An accessor, not the mounted session: a project switch replaces it,
        // and a lifecycle handler holding the original would drain the store of
        // a project the writer left.
        session: {
          flushPending: () => current.session?.flushPending() ?? Promise.resolve(),
          // Reached through the flusher, not through `current.session`:
          // `Session` deliberately exposes neither (see session.ts).
          failed: () => current.flusher?.failed() ?? false,
          dirtyCount: () => current.flusher?.dirtyCount() ?? 0,
        },
        invoke,
        listen: window.__TAURI__?.event?.listen,
        addWindowListener: (type, cb) => window.addEventListener(type, cb),
        addDocumentListener: (type, cb) => document.addEventListener(type, cb),
        isHidden: () => document.hidden,
        onError: raiseFailure,
        privacyLocked: async () => {
          if (!invoke) return false;
          const status = await invoke("privacy_status") as PrivacyStatus;
          return status.locked || status.recovery;
        },
        drafts: {
          pending: () => current.reviewPending(),
          prepareClose: () => current.prepareToLeave(),
          cancelClose: () => current.cancelLeave(),
        },
        promptUnsavedClose: (dirtyCount) => closePrompt.open(dirtyCount),
      });
      if (lifecycleReady) await invoke?.("privacy_ready");
    }
    startup?.complete();
    // Only when the harness asked for a sink. A human's launch has none, so
    // this is silent; the hand test uses it to know the window is up.
    window.__appSink?.({
      ready: true,
      candidate: window.__appCandidate ?? "unknown",
      seed: window.__appSeed ?? "unknown",
      mode,
      run: "interactive",
      rows: source.count,
      startup_ms: Math.round(performance.now() - entryAt),
      item_id: activeDocId,
      // Which project the startup order actually chose. The project rig asserts
      // on this rather than assuming the host picked what it seeded.
      project_path: currentPath,
      project_name: currentName,
      generation: window.__appGeneration ?? 1,
    });
    return;
  }

  startup?.complete();
  const script = buildWorkload(source.seed, source.count, { typingChars, navJumps });

  const typing: Sample[] = [];
  const nav: Sample[] = [];
  const cycles: CycleRecord[] = [];
  const onset = createOnsetTracker();
  let charsTyped = 0;
  let actions = 0;

  const t0 = performance.now();
  const startupMs = Math.round(t0 - entryAt);

  // Verify mode answers one question — did the previous run's writes survive a
  // restart — and typing would change the answer while measuring it.
  if (persistMode === "verify") {
    window.__appSink?.({
      ready: true,
      candidate: window.__appCandidate ?? "unknown",
      seed: window.__appSeed ?? "unknown",
      mode,
      rows: source.count,
      startup_ms: startupMs,
      persist: {
        project: true,
        mode: "verify",
        item_id: activeDocId,
        rev: activeDocRev,
        body_hash: loadedBodyHash,
        error: null,
        flush: null,
      },
    });
    return;
  }

  // Captured BEFORE the soak, not after: navigator.rows() is the current
  // collapse state, and reading it at the end would silently start reporting a
  // partially collapsed list the moment ArrowLeft/ArrowRight enter NAV_KEYS
  // (measure/workload.ts) — which this slice makes an obvious next step. The
  // length assertion is the defence; a constant in another file is not one.
  const preMutationRows = navigator.rows().map((r) => ({
    id: r.id,
    level: r.depth + 1,
    setsize: r.setsize,
    posinset: r.posinset,
  }));
  if (preMutationRows.length !== source.count) {
    throw new Error(
      `navigator projects ${preMutationRows.length} rows for ${source.count} items: ` +
        "the expectation payload would not describe the whole tree",
    );
  }

  const deadline = t0 + soakMs;

  while (performance.now() < deadline) {
    const cycleTyping: Sample[] = [];
    let ran = 0;
    for (const action of script) {
      if (performance.now() >= deadline) break;
      // Every argument is resolved BEFORE the measured window opens: a malformed
      // action is a workload bug and must abort the run, not be timed as though
      // it were a keystroke.
      let apply: () => void;
      switch (action.kind) {
        case "type": {
          const char = action.char;
          if (char === undefined) throw new Error("type action missing char");
          apply = () => editor.typeChar(char);
          break;
        }
        case "break":
          apply = () => editor.splitParagraph();
          break;
        case "erase":
          apply = () => editor.erasePrev();
          break;
        case "caret": {
          const index = action.index;
          if (index === undefined) throw new Error("caret action missing index");
          apply = () => editor.caretToParagraph(index);
          break;
        }
        case "nav": {
          const key = action.key;
          if (key === undefined) throw new Error("nav action missing key");
          apply = () => navigator.handleKey(key);
          break;
        }
        default:
          throw new Error(`unhandled action kind: ${String(action.kind)}`);
      }

      // Bookkeeping is data, not branching: see ACTION_EFFECTS in
      // measure/workload.ts for why each kind does what it does.
      const effects = ACTION_EFFECTS[action.kind];
      const sample = await measure(apply);
      if (effects.measuredAs === "nav") {
        nav.push(sample);
      } else {
        cycleTyping.push(sample);
        typing.push(sample);
      }
      if (effects.countsAsCharacter) charsTyped++;
      actions++;
      // charsTyped and actions are already incremented, so both are counts
      // INCLUDING this action — the same convention the cycle records use.
      onset.record(sample, {
        actionIndex: actions,
        kind: action.kind,
        charsTyped,
        atMs: Math.round(performance.now() - t0),
      });
      if (actionDelayMs > 0) await new Promise((r) => setTimeout(r, actionDelayMs));
      ran++;
    }
    // A cycle that hit the soak deadline mid-script has a handful of samples,
    // not the full 400+60 actions, so its p95 is not a real trend point (see
    // gates.ts evaluateGates: a truncated cycle poisoned the cliff ratio to
    // 8.11 on a run flat at 34 ms). Mark it so the harness can exclude it.
    const completed = ran === script.length;
    cycles.push({
      cycle: cycles.length + 1,
      atMs: Math.round(performance.now() - t0),
      // Sourced from frame time, not dispatch time, so this stays comparable
      // to the single number discovery and earlier runs recorded.
      typingP95Ms: percentiles(cycleTyping.map((s) => s.frameMs)).p95,
      charsTyped,
      partial: !completed,
    });
  }

  if (flusher !== null) await flusher.drain();
  const finalRev =
    flusher !== null && activeDocId !== null
      ? (flusher.revOf(activeDocId) ?? activeDocRev)
      : activeDocRev;

  // Mutation phase. Runs after the soak and after the final flush drain, so
  // store writes never interleave with document flushes. Targets are drawn from
  // the BOOT-TIME walk, deliberately, not from navigator.rows(): the navigator
  // captures its nodes at construction and the page never re-reads
  // project_items, so items created here appear in neither. Re-reading would
  // cost a full walk of every item over IPC per mutation and a navigator
  // rebuild the navigator does not support mid-run; the phase measures store
  // mutation cost, not reprojection cost. Default 0 mutations, so every rig that
  // does not ask for them skips this entirely.
  const mutationSamples: number[] = [];
  const mutationErrorMessages: string[] = [];
  let mutationAttempts = 0;
  let mutationErrors = 0;
  const mutations = window.__appMutations ?? 0;
  if (mutations > 0 && invoke !== undefined && storeItems !== null) {
    const planner = createMutationPlanner(storeItems);

    for (let n = 0; n < mutations; n++) {
      const plan = planner.plan(n);
      mutationAttempts++;
      const started = performance.now();
      try {
        if (plan.kind === "create") {
          const ack = (await invoke("item_create", {
            parentId: plan.parentId,
            itemType: "scene",
            title: `Added scene ${plan.seq}`,
          })) as { id: string; position: string; rev: number; doc_rev: number | null };
          // A created scene must come with a document row. A null here is a
          // store defect, not a caller error, and must not pass unremarked.
          if (ack.doc_rev === null) {
            throw new Error(`item_create returned no doc_rev for scene ${ack.id}`);
          }
        } else if (plan.kind === "rename") {
          const rev = (await invoke("item_rename", {
            id: plan.id,
            title: plan.title,
            baseRev: plan.baseRev,
          })) as number;
          planner.applyRename(plan.id, rev);
        } else {
          const moved = (await invoke("item_move", {
            id: plan.id,
            newParentId: plan.newParentId,
            afterId: null,
            baseRev: plan.baseRev,
          })) as { parent_id: string | null; position: string; rev: number };
          planner.applyMove(plan.id, moved.parent_id, moved.rev);
        }
        // Only successful writes are timed. A rolled-back attempt returns on a
        // different path and would bias the percentiles under a field named for
        // mutations that landed; mutation_attempts carries the denominator.
        mutationSamples.push(performance.now() - started);
      } catch (err: unknown) {
        mutationErrors++;
        const message = String(err);
        // Bounded and deduplicated: a phase that failed every mutation must be
        // distinguishable from one that succeeded, which takes the message, not
        // N copies of it.
        if (mutationErrorMessages.length < 5 && !mutationErrorMessages.includes(message)) {
          mutationErrorMessages.push(message);
        }
      }
    }
  }

  // The in-memory truth at the end of the WRITE run: one half of a two-boot
  // assertion, not a redundant copy of pre_mutation_rows. The harness kills the shell,
  // reopens the same project and compares this walk against the reopened one,
  // so a mutation that never reached the store shows up as a shape mismatch.
  // Read ONCE, after the loop and outside the measured window: a re-read per
  // mutation would measure reprojection, not store mutation cost. Shape only -
  // no titles, depths or revs. At stress this is ~20,000 small objects, roughly
  // doubling the sink payload that tree.rows already inflates by about a
  // megabyte, so it is skipped entirely when nothing was mutated.
  let postWalk: { id: string; parent_id: string | null; position: string }[] | null = null;
  if (mutations > 0 && invoke !== undefined && storeItems !== null) {
    const walked = (await invoke("project_items")) as ProjectItem[];
    postWalk = walked.map((i) => ({ id: i.id, parent_id: i.parent_id, position: i.position }));
  }

  window.__appSink?.({
    ready: true,
    candidate: window.__appCandidate ?? "unknown",
    seed: window.__appSeed ?? "unknown",
    mode,
    workload_script: WORKLOAD_SCRIPT,
    rows: source.count,
    activeIndexAtEnd: navigator.activeIndex(),
    startup_ms: startupMs,
    typing_chars_per_cycle: typingChars,
    nav_jumps_per_cycle: navJumps,
    action_delay_ms: actionDelayMs,
    actions,
    onset: onset.sustained(),
    first_slow: onset.first(),
    slow_actions: onset.slowCount(),
    typing: summarize(typing),
    nav: summarize(nav),
    cycles,
    tree: {
      // Three fields, three instants; each name carries its own, because the
      // harness reads JSON and not this comment. pre_mutation_* is the page's
      // projection captured before the soak and before any mutation; post_walk
      // is the store's walk after them. Measured on a 180-mutation stress run:
      // pre_mutation_nodes 20,000 and post_walk.length 20,060, and that
      // difference is correct behaviour, not a shape mismatch.
      //
      // pre_mutation_rows is the page's OWN derivation. The harness compares it
      // against the AT-SPI tree, and separately against the store's walk. Two
      // independent derivations: if the harness read one source twice, a
      // mismatch would be impossible and the gate would be theatre.
      pre_mutation_nodes: preMutationRows.length,
      pre_mutation_rows: preMutationRows,
      // Attempts is the denominator; mutations counts only the writes that
      // landed, which is what the percentiles below are over. Both are reported
      // because percentiles([]) is all zeros, which reads as perfect latency.
      mutation_attempts: mutationAttempts,
      mutations: mutationSamples.length,
      mutation_errors: mutationErrors,
      mutation_error_messages: mutationErrorMessages,
      mutation_p50_ms: percentiles(mutationSamples).p50,
      mutation_p95_ms: percentiles(mutationSamples).p95,
      // Post-mutation store walk, or null when nothing was mutated. See above.
      post_walk: postWalk,
    },
    persist:
      flusher === null
        ? null
        : {
            project: true,
            mode: "write",
            item_id: activeDocId,
            rev: finalRev,
            seeded_body_hash: loadedBodyHash,
            body_hash: bodyHash(editor.serialize()),
            error: mounted.persistError(),
            flush: flusher.stats(),
          },
  });
}

void main().catch((err: unknown) => {
  // A page that throws must say so through the sink, not die silently: the
  // harness distinguishes "never reported" from "reported a failure", and a
  // silent throw would be indistinguishable from a hung shell.
  window.__appSink?.({ ready: false, error: String(err) });
  // AND TO THE PERSON LOOKING AT IT. `__appSink` exists only when APP_SINK is
  // set, which is only ever under a rig - so on a real launch the line above is
  // a no-op and this was the whole of the error handling: index.html ships an
  // empty #nav and an empty #editor and every unit builds its own content, so a
  // throw here left a blank window that said nothing, forever.
  //
  // Reachable, and not only by a corrupt install: `mountProject` throws on a
  // project that holds no scene, and import deliberately writes no starter
  // scene - so a .md whose headings produce parts and chapters but no scene
  // imports fine and then opens to nothing.
  //
  // Built by hand rather than through the banner unit: that unit belongs to a
  // mounted project, and the case here is that no project mounted.
  showStartupFailure(String(err));
});

/** The last-resort surface. Nothing else is on screen and nothing else will be.
 *
 *  Deliberately plain: no dependency on the stylesheet having loaded, no
 *  dependency on any unit having been constructed, and no dismiss control -
 *  there is nothing behind it to get back to. */
function showStartupFailure(message: string): void {
  const existing = document.getElementById("startup-failure");
  if (existing !== null) return;
  const el = document.createElement("div");
  el.id = "startup-failure";
  el.setAttribute("role", "alert");
  const title = document.createElement("h1");
  title.textContent = t("startup.failed.title");
  const detail = document.createElement("p");
  detail.textContent = message;
  const advice = document.createElement("p");
  // Names only routes that EXIST. This used to end by telling the writer to
  // restore the project from a backup, from the export slice until 2026-08-19,
  // and nothing in this application had ever written a backup or restored one
  // -- a sentence a writer reads at the moment their project will not open,
  // sending them after a file that is not there. The read-only subcommands are
  // real (see cli.rs) and need no window.
  //
  // A BACKUP SENTENCE CAME BACK on 2026-08-21, under the design's constraint
  // and nothing wider: it may name a same-device recovery point ONLY when one
  // exists AND verified, it says "on this device" because a point beside the
  // project is exactly as lost as the project when the disk goes, and it
  // promises no restore, because nothing in this application performs one. It
  // is appended below rather than written here: the answer is a host round
  // trip away, and this surface must paint immediately and without it.
  advice.textContent = t("startup.failed.advice");
  el.append(title, detail, advice);
  document.body.prepend(el);

  void readRecoveryReport(window.__TAURI__?.core.invoke).then((report) => {
    const sentence = startupRecoverySentence(report, Date.now());
    // Empty means there was nobody to ask. Nothing is added rather than a blank
    // paragraph: an empty line under a failure reads as a message that failed
    // to load, which is one more thing to worry about on the worst screen in
    // the application.
    if (sentence === "") return;
    const recovery = document.createElement("p");
    recovery.textContent = sentence;
    el.append(recovery);
  });
}
