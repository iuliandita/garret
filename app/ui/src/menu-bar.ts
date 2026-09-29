// app/ui/src/menu-bar.ts
// The application menu: one button, a list of four titles, one dropdown.
//
// ONE ICON BUTTON ON THE HEADER'S RIGHT END, NOT FOUR WORDS ACROSS IT (068).
// #app-menu opens #app-menu-list, a popover holding the File, Edit, Outline and
// Help titles as rows; a row opens #menu-panel beside itself. Three states:
// closed; the list alone; the list with one row expanded. Alt+<key> goes
// straight to the third, which is the only route any rig takes, so nothing they
// measure moved.
//
// IT STILL LIVES ON AN EXISTING LINE BOX, NOT IN A STRIP OF ITS OWN, and that
// is what keeps it affordable. The project bar's 39px and the outline bar's
// 34px are click-geometry constants restated in outline-cli, export-cli,
// words-cli, switch-cli and find-cli, each pressing at a coordinate computed
// from them. A strip of its own moves every navigator row down, and all five
// rigs go on clicking coordinates they computed rather than rows a writer sees
// -- silently, reporting plausible numbers. So the button carries no height of
// its own, and the list and the dropdown are positioned absolutely, out of
// flow. Nothing below the bar moves at all.
//
// THE MENU DOES NOT DECIDE ANYTHING. Every item calls a dep. It does not know
// what an item type is, where a new row lands, whether a title is blank, or
// whether the export succeeded -- the outline unit, the export bar and the
// project panel already own all of that, and two places deciding one thing is
// how they drift.

import { isCompositionKey } from "./composition-key";
import { t } from "./i18n";
import { privacyShortcutLabel, type PrivacyShortcut } from "./privacy";
import { createIcon } from "./icons";
import { createMenuPanel, type MenuItemSpec } from "./menu-panel";
import type { MatterKind } from "./outline";
import { createTooltip } from "./tooltip";

// THE DROPDOWN ITSELF LIVES IN menu-panel.ts, shared with the navigator's
// context menu: painting, arrow keys, and close-before-run are one
// implementation, not two. Re-exported because MenuItemSpec was this file's type
// first and several tests and the outline menu's table name it from here.
export type { MenuItemSpec } from "./menu-panel";

export interface MenuSpec {
  id: string;
  label: string;
  /** Alt+<key> opens this menu. One letter from the catalog (`menu.<x>.key`,
   *  088: Datei is Alt+D), matched against `event.key` with both sides
   *  lowercased, so it survives a shifted or capsed press. `event.key` is
   *  the layout's letter, not the physical key: on a non-Latin layout no
   *  menu answers a chord (pre-088, recorded). */
  key: string;
  items: readonly MenuItemSpec[];
}

/** Where the project panel should put the caret when the File menu opens it.
 *  Two menu items opening one panel identically would be two names for one
 *  action; opening it with the relevant control focused is what makes them
 *  genuinely different things to have asked for.
 *
 *  `import` is no longer reached from the menu — Import… is a real OS dialog as
 *  of this slice. The variant stays because the panel's drop-folder import list
 *  is still a live surface with a graded rig behind it (`import-cli`), and the
 *  panel can still be asked to open on it. */
export type ProjectsFocus = "list" | "create" | "import";

export interface MenuBarDeps {
  showManuscript: () => void;
  showOutlineTable: () => void;
  showOutlineCards: () => void;
  showReadThrough: () => void;
  showContinuousChapter: () => void;
  openReference: () => void;
  closeReference: () => void;
  outlineViewMode: () => "manuscript" | "table" | "cards" | "reading" | "continuous";
  /** A span on the project bar, already in index.html. Outside
   *  #project-controls, which the switcher clears wholesale. */
  container: HTMLElement;
  openProjects: (focus: ProjectsFocus) => void;
  exportProject: () => void;
  /** Export through the operating system's own save dialog. */
  exportAs: () => void;
  /** The DOCX editor handoff (092), through the same OS save dialog. A
   *  format of its own rather than a third argument to `exportAs`: the two
   *  menu items differ in which renderer they ask for, exactly as the
   *  statistics panel's CSV and JSON buttons differ in which converter they
   *  ask for, and neither pair is one control with a hidden choice inside it. */
  exportDocx: () => void;
  /** Opens the EPUB rail. Not a dialog: see the item's own note. */
  openEpubPreview: () => void;
  openPdfPreview: () => void;
  /** Take a recovery point on this device now, instead of waiting for the
   *  schedule. Not a file the writer can move anywhere: it lands beside the
   *  project, which is the whole of what it protects against. */
  backupNow: () => void;
  /** Import through the operating system's own open dialog. Creates a NEW
   *  project and never merges into the open one. */
  importProject: () => void;
  /** File > Library... (099): the switcher on the list, exactly as
   *  `openProjects("list")` does. A separate dep rather than reusing
   *  `openProjects` directly: 100 gives this its own screen, and the
   *  item must already be routing through its own name before that lands. */
  openLibrary: () => void;
  openPreferences: () => void;
  lockPrivacy?: () => void;
  canLockPrivacy?: () => boolean;
  privacyShortcut?: () => PrivacyShortcut;
  /** Start renaming the open book, in the strip above the outline. Not a panel:
   *  the name IS the control. */
  renameProject: () => void;
  openFind: () => void;
  /** The quick-open panel: type part of a title, press Return. */
  openQuickOpen: () => void;
  /** The find panel with the caret in the replace field. */
  openReplace: () => void;
  /** Past states of the open scene, and the manuscript's named snapshots. */
  openHistory: () => void;
  /** Show what the writer changed in the readable folder. Reads nothing back. */
  openMirrorChanges: () => void;
  /** The notes left on this scene. */
  openComments: () => void;
  /** The same panel, with the caret in the note field and the selected passage
   *  quoted above it. Two items for one surface, like Find and Replace. */
  addComment: () => void;
  /** Add the word under the caret to this book's own dictionary (111). The
   *  route that does not depend on WebKit's context menu, whose Learn
   *  Spelling writes a machine-global list this application never reads. */
  addToDictionary: () => void;
  /** Back and forward through the scenes the writer has opened. */
  navBack: () => void;
  navForward: () => void;
  /** Whether either can act. Read at PAINT time, like `selectedTrashed`, so the
   *  item says so instead of looking live and doing nothing. */
  canNavBack: () => boolean;
  canNavForward: () => boolean;
  undo: () => void;
  redo: () => void;
  /** Structural undo/redo (085): the outline's own stack, distinct from Edit's
   *  prose undo above. Labels are read at PAINT time, like `canNavBack` -
   *  null means nothing to act on. */
  outlineUndo: () => void;
  outlineRedo: () => void;
  outlineUndoLabel: () => string | null;
  outlineRedoLabel: () => string | null;
  /** A new part, chapter or scene. NO TITLE and no parent: both are properties
   *  of the walk, which this menu does not hold and must not read. The menu is a
   *  second SURFACE, not a second implementation. */
  create: (itemType: string) => void;
  /** A document in the bible. ITS OWN ACTION rather than `create("note")`,
   *  because it is not placed from the selection: it belongs in one section,
   *  always. Routing it through the placement rule would make the same press
   *  land in the manuscript whenever the writer was looking at a scene. */
  createNote: () => void;
  createBibleFolder: () => void;
  /** A timeline in the bible. `createNote`'s own reason. */
  createTimeline: () => void;
  /** A dedication, a foreword, an acknowledgements page or an afterword. ITS OWN
   *  ACTION for `createNote`'s reason: the kind decides which SECTION the page
   *  is filed in, and the selection has nothing to say about it. */
  createMatter: (kind: MatterKind) => void;
  /** Move the SELECTED row: within its siblings, or a level in or out. Exists
   *  as Alt+Arrow too; these items are what make it findable. */
  move: (direction: "up" | "down" | "outdent" | "indent") => void;
  beginRename: () => void;
  /** Delete a live row, restore a trashed one. Which of the two is decided by
   *  the caller from the same selection this menu reads for the label. */
  removeOrRestore: () => void;
  /** Is the selected row in the bin? Read at paint time. */
  selectedTrashed: () => boolean;
  /** How long the open scene, its chapter, its part and the whole manuscript
   *  are, what the outline is made of, and what this session has cost. */
  openStatistics: () => void;
  openAnalytics: () => void;
  /** Where the selected row stands: outline, draft, revising, done, or nothing
   *  yet. Acts on the selection, which the panel reads live. */
  openRevisionState: () => void;
  openReviewProposals: () => void;
  /** What the selected row is ABOUT: a summary the writer keeps beside a part,
   *  a chapter or a scene, which is not in the book and is counted, exported,
   *  searched and mirrored as nothing. Acts on the selection, which the CALLER
   *  reads once and hands to the panel - unlike the revision state, which the
   *  panel re-reads on every paint. The difference is that a synopsis is typed
   *  rather than pressed, and the selection moves while it is being typed. */
  openSynopsis: () => void;
  /** The characters, places and points of interest of the open book. */
  openCast: () => void;
  openKnowledge?: () => void;
  openCraftReports?: () => void;
  /** Who appears in the SELECTED row. Reads the selection, like the synopsis. */
  openAppearances: () => void;
  /** Who appears where, across the whole book. Reads no selection, like the
   *  cast. */
  openAppearancesMap: () => void;
  /** How the BOOK is set when it leaves: the body font, the page it is set on
   *  and the four margins. Per book, unlike everything in Preferences, which is
   *  per writer and about this screen. */
  openBookDesign: () => void;
  /** The picture on the front of the book and the one on the back. Per book,
   *  beside the design rather than inside it -- see the item. */
  openCovers: () => void;
  openIdentities: () => void;
  openHelp: () => void;
  /** Leave. Hands the window to the host, which runs the SAME close path a
   *  title-bar click runs -- flush, then the unsaved-work prompt if there is
   *  anything to lose. This menu does not close a window and does not decide
   *  whether it is safe to. */
  quit: () => void;
}

export interface MenuBar {
  /** Close whatever is open. The page calls this when a project switch tears
   *  the mount down, so a dropdown cannot outlive the project it acts on. */
  close(): void;
  destroy(): void;
}

/** Which menu is currently painted.
 *
 *  The panel holds the ITEMS; this holds only which menu they came from, which
 *  is what the title's aria-expanded and the left/right walk need.
 *
 *  Labels are resolved at paint time and held by the panel, for the reason the
 *  outline bar holds `offering`: a selection change between paint and click
 *  would otherwise silently turn a Restore into a Delete. Reading
 *  `deps.selectedTrashed()` again inside the handler is the bug, not the
 *  safeguard. */
interface Painted {
  menu: MenuSpec;
}

export function createMenuBar(deps: MenuBarDeps): MenuBar {
  const { container } = deps;

  const MENUS: readonly MenuSpec[] = [
    {
      id: "menu-file",
      label: t("menu.file"),
      key: t("menu.file.key"),
      items: [
        // FIVE GROUPS (240): the book, publishing it, checking it, its
        // copies, the application. A separator is drawn before the first
        // item of each group and is not an item: the arrows skip it and
        // menu-drive counts only ids, so no index moved for it. No group is
        // over six items.
        //
        // New project and Open project are still the panel, with two different
        // resting places for the caret: creating a project is naming one, and
        // there is no file to choose. Open stays the panel because opening a
        // `.db` from an arbitrary path would let projects live outside the
        // library, which changes what a project IS - a library-semantics
        // question, not a dialog. Import and Export as… ARE real OS dialogs.
        { id: "menu-project-new", opensDialog: true, label: () => t("menu.project-new"), run: () => deps.openProjects("create") },
        { id: "menu-project-open", opensDialog: true, label: () => t("menu.project-open"), run: () => deps.openProjects("list") },
        // NOT a panel any more. The project panel used to open with the
        // caret in a rename field; the book's name moved into the
        // strip above the outline and became the rename affordance, so this
        // item starts the rename there. Two routes, one implementation -- which
        // is what that earlier argument demanded and what a second field would
        // have broken.
        { id: "menu-project-rename", label: () => t("menu.project-rename"), run: deps.renameProject },
        { id: "menu-import", label: () => t("menu.import"), run: deps.importProject },
        // ABOVE the exports, because it is what they will obey. It is a File
        // item and not an Outline one for the recorded reason Back up now is:
        // nothing here changes the outline. It is not in Preferences because
        // Preferences is per WRITER and this is per BOOK -- that panel's one
        // per-project group already calls itself out as the exception.
        { id: "menu-book-design", separatorBefore: true, opensDialog: true, label: () => t("menu.book-design"), run: deps.openBookDesign },
        // BESIDE Book design and not inside it, and the reason is that panel's
        // own: 040 recorded that it holds nothing that can grow and therefore
        // needs no scroll, and two cover previews are tall enough to push its
        // margin fields under the fold of a default window. Two items, one
        // subject -- New project… and Open project…'s shape.
        //
        // ABOVE the exports for Book design's reason: 043 and 044 are what will
        // put a cover on a book, and this is what they will obey.
        { id: "menu-covers", opensDialog: true, label: () => t("menu.covers"), run: deps.openCovers },
        // Ctrl+E (240): the one export a writer repeats, so the one given a
        // chord. Bound by the export bar, never here (menu-panel's rule).
        { id: "menu-export", label: () => t("menu.export"), shortcut: t("menu.shortcut.export"), run: deps.exportProject },
        { id: "menu-export-as", label: () => t("menu.export-as"), run: deps.exportAs },
        // The third export format stays with the other export commands.
        { id: "menu-export-docx", label: () => t("menu.export-docx"), run: () => deps.exportDocx() },
        // The statistics files left this menu in 240: they are the Statistics
        // panel's footer now, beside the figures they write out.
        // NOT `opensDialog`. That flag says the page is about to hand focus to
        // a panel of its own; a rail is not a panel, does not dismiss on an
        // outside click, and is meant to stay open beside the prose. It DOES
        // take focus on open so Escape is heard, which is the panels' rule and
        // is the one thing the flag is not about.
        { id: "menu-epub-preview", separatorBefore: true, label: () => t("menu.epub-preview"), run: deps.openEpubPreview },
        // 044. It opens the SAME rail in the other format -- not a second
        // surface.
        { id: "menu-pdf-preview", label: () => t("menu.pdf-preview"), run: deps.openPdfPreview },
        // 053. Not beside Book design, where the subject plainly belongs: the
        // whole publishing block stays together.
        { id: "menu-identities", opensDialog: true, label: () => t("menu.identities"), run: deps.openIdentities },
        // Beside the exports because it is the same kind of thing - a command
        // that writes a file - and above Preferences so the File menu still
        // ends where every reader expects it to.
        { id: "menu-backup-now", separatorBefore: true, label: () => t("menu.backup-now"), run: deps.backupNow },
        // BESIDE THE FILE COMMANDS, because that is what it is about: the
        // folder of Markdown this application writes beside the project. Not
        // in Outline -- nothing here changes the outline, and this build
        // changes nothing at all. Above Preferences and Quit for the reason
        // recorded on `menu-quit`: those two are where every reader of a File
        // menu looks for them.
        { id: "menu-mirror-changes", opensDialog: true, label: () => t("menu.mirror-changes"), run: deps.openMirrorChanges },
        // Above Preferences because it is the application-chrome item every
        // reader looks for near the bottom, and below Back up now / the mirror
        // because those act on the OPEN book and this does not. In THIS slice it
        // opens the switcher on the list, the same target `menu-project-new` and
        // `menu-project-open` already reach -- the screen that replaces that
        // target is 100's.
        {
          id: "menu-library",
          separatorBefore: true,
          opensDialog: true,
          label: () => t("menu.library"),
          shortcut: t("menu.shortcut.library"),
          run: deps.openLibrary,
        },
        { id: "menu-preferences", opensDialog: true, label: () => t("menu.preferences"), run: deps.openPreferences },
        { id: "menu-privacy-lock", label: () => t("privacy.lock"), get shortcut() { return privacyShortcutLabel(deps.privacyShortcut?.() ?? "ctrl_alt_l"); }, enabled: () => deps.canLockPrivacy?.() ?? false, run: () => deps.lockPrivacy?.() },
        // LAST, because that is where every reader of a File menu looks for it,
        // and because `menu-cli` indexes items by position: an item inserted
        // anywhere above this moves a coordinate five rigs compute rather than
        // read. Not `opensDialog` -- that flag says the page is about to hand
        // focus to a panel of its own, and this hands it to the window manager.
        { id: "menu-quit", label: () => t("menu.quit"), shortcut: t("menu.shortcut.quit"), run: deps.quit },
      ],
    },
    {
      id: "menu-edit",
      label: t("menu.edit"),
      key: t("menu.edit.key"),
      items: [
        { id: "menu-undo", label: () => t("menu.undo"), shortcut: t("menu.shortcut.undo"), run: deps.undo },
        { id: "menu-redo", label: () => t("menu.redo"), shortcut: t("menu.shortcut.redo"), run: deps.redo },
        { id: "menu-find", opensDialog: true, label: () => t("menu.find"), shortcut: t("menu.shortcut.find"), run: deps.openFind },
        // The SAME panel as Find, with the caret in the replace field. Two items
        // for one surface, distinguished by where the caret lands, exactly like
        // New project… and Open project…. Replace has no chord of its own: it is
        // one Tab from the query field, and a second binding to advertise is a
        // second thing that can drift from what actually works.
        { id: "menu-replace", opensDialog: true, label: () => t("menu.replace"), run: deps.openReplace },
        {
          id: "menu-history",
          opensDialog: true,
          label: () => t("menu.history"),
          run: deps.openHistory,
        },
        // APPENDED, and appended for a mechanical reason as well as a
        // conventional one: `menu-drive.ts` parses this file for the index of
        // an item, so inserting above one moves every rig that names it. Adding
        // is above reading because a writer leaves far more notes than they
        // review, and both open the same panel.
        {
          id: "menu-add-comment",
          opensDialog: true,
          label: () => t("menu.add-comment"),
          // The chord every writer arriving from a word processor already has
          // in their fingers - Word and Google Docs both bind it. That is the
          // whole argument for spending one here, against the standing note
          // that a free chord is worth more to something done per minute: in a
          // revision pass this IS done per minute, and it is the one operation
          // in the panel that must be reachable without leaving the prose.
          shortcut: t("menu.shortcut.add-comment"),
          run: deps.addComment,
        },
        {
          id: "menu-comments",
          opensDialog: true,
          label: () => t("menu.comments"),
          run: deps.openComments,
        },
        // APPENDED, `menu-add-comment`'s own mechanical reason. Acts on the
        // caret and opens nothing, so no `opensDialog`.
        {
          id: "menu-add-to-dictionary",
          label: () => t("menu.add-to-dictionary"),
          run: deps.addToDictionary,
        },
      ],
    },
    {
      id: "menu-outline",
      label: t("menu.outline"),
      key: t("menu.outline.key"),
      items: [
        // THE VERBS ARE BACK. The toolbar's three create buttons read "Part",
        // "Chapter", "Scene" -- nouns -- because five whole phrases do not fit
        // across the navigator column on one line, and the verb survives only in
        // an aria-label. So a screen-reader user is told what the button does
        // and a sighted user is not, which is the inverse of the usual failure.
        // A menu item has its own row, so the constraint does not exist here and
        // neither does the override: visible text and accessible name are one
        // string again.
        // FIRST in Outline, above the creates. It is the item a writer reaches
        // for most often in a long manuscript and the only one that is pure
        // navigation - the four below it all change the tree.
        // ABOVE Go to…, and above it for the same reason Go to… is above the
        // creates: the three of them are pure navigation and everything below
        // changes the tree.
        //
        // Both labels say when they cannot act, the way menu-remove says which
        // of Delete and Restore it will do, and for a sharper reason: Delete on
        // an empty selection is an item a writer can see is not for them, while
        // a Back that appears live and does nothing reads as a broken
        // application. Evaluated at paint time, so the label is the answer for
        // the trail as it stands when the menu opened.
        {
          id: "menu-nav-back",
          label: () => (deps.canNavBack() ? t("menu.nav-back") : t("menu.nav-back.empty")),
          shortcut: t("menu.shortcut.nav-back"),
          run: deps.navBack,
        },
        {
          id: "menu-nav-forward",
          label: () =>
            deps.canNavForward() ? t("menu.nav-forward") : t("menu.nav-forward.empty"),
          shortcut: t("menu.shortcut.nav-forward"),
          run: deps.navForward,
        },
        { id: "menu-go-to", opensDialog: true, label: () => t("menu.go-to"), shortcut: t("menu.shortcut.go-to"), run: deps.openQuickOpen },
        { id: "menu-new-part", label: () => t("menu.new-part"), run: () => deps.create("part") },
        { id: "menu-new-chapter", label: () => t("menu.new-chapter"), run: () => deps.create("chapter") },
        { id: "menu-new-scene", label: () => t("menu.new-scene"), run: () => deps.create("scene") },
        { id: "menu-new-note", label: () => t("menu.new-note"), run: deps.createNote },
        { id: "menu-new-bible-folder", label: () => t("menu.new-bible-folder"), run: deps.createBibleFolder },
        { id: "menu-new-timeline", label: () => t("menu.new-timeline"), run: deps.createTimeline },
        // THE FOUR PAGES THAT ARE NOT CHAPTERS, named for what a writer looks
        // for. They sit with the other creates and above the moves, because
        // that is what they are: `menu-cli` reads this order rather than
        // restating it, so inserting here moves no rig's index.
        {
          id: "menu-new-dedication",
          label: () => t("menu.new-dedication"),
          run: () => deps.createMatter("dedication"),
        },
        {
          id: "menu-new-foreword",
          label: () => t("menu.new-foreword"),
          run: () => deps.createMatter("foreword"),
        },
        {
          id: "menu-new-acknowledgements",
          label: () => t("menu.new-acknowledgements"),
          run: () => deps.createMatter("acknowledgements"),
        },
        {
          id: "menu-new-afterword",
          label: () => t("menu.new-afterword"),
          run: () => deps.createMatter("afterword"),
        },
        // THE MOVES, AND WHY THEY ARE HERE AT ALL. They have existed since the
        // outline-editing slice, are graded by `outline_reorder_persists`, and
        // were reachable ONLY by Alt+Arrow while the outline had focus -- so a
        // writer with the caret in their prose pressed the keys, nothing
        // happened, and the feature was invisible unless they opened Help >
        // Keyboard shortcuts. That is a reported defect: "I also want the
        // option to move them around" -- not an absence, a
        // discoverability failure.
        //
        // They call `deps.move` DIRECTLY rather than synthesising a keypress.
        // The menu holds focus while an item runs, so a key-based
        // implementation would reach the menu and not the outline -- it would
        // do nothing, which is the defect these items exist to fix.
        { id: "menu-move-up", label: () => t("menu.move-up"), shortcut: t("menu.shortcut.move-up"), run: () => deps.move("up") },
        { id: "menu-move-down", label: () => t("menu.move-down"), shortcut: t("menu.shortcut.move-down"), run: () => deps.move("down") },
        { id: "menu-move-out", label: () => t("menu.move-out"), shortcut: t("menu.shortcut.move-out"), run: () => deps.move("outdent") },
        { id: "menu-move-in", label: () => t("menu.move-in"), shortcut: t("menu.shortcut.move-in"), run: () => deps.move("indent") },
        { id: "menu-rename", label: () => t("menu.rename"), run: deps.beginRename },
        {
          id: "menu-remove",
          // Evaluated at paint time, exactly like the outline bar's `offering`.
          label: () => (deps.selectedTrashed() ? t("menu.restore") : t("menu.delete")),
          // NO Delete hint (240, deliberately). The key deletes a row only while
          // the outline has focus; with the caret in the prose, where the menu
          // is usually opened from, it deletes a character. A hint here would
          // teach the one press that does something else.
          run: deps.removeOrRestore,
        },
        // LAST, and appended rather than inserted, which is not a style
        // preference: dialog-cli reaches Export as… by four literal ArrowDowns
        // in File, and menu-cli, export-cli and history-cli read their indices
        // out of this table. An item added at the END of a menu moves nothing.
        //
        // In Outline rather than File because the panel is mostly a description
        // of the outline - how many parts, how many chapters, how long the
        // scenes are - and the writer asking it is asking about the shape of
        // their book, not about the file it lives in.
        {
          id: "menu-statistics",
          opensDialog: true,
          label: () => t("menu.statistics"),
          run: deps.openStatistics,
        },
        { id: "menu-analytics", opensDialog: true, label: () => t("menu.analytics"), run: deps.openAnalytics },
        // LAST, and appended rather than inserted, for the reason the item above
        // gives: dialog-cli reaches Export as… by four literal ArrowDowns, and
        // menu-cli, export-cli and history-cli read their indices out of this
        // table through menu-drive.ts. An item added at the END of a menu moves
        // nothing.
        //
        // In Outline because the state is a fact about a row of the outline, and
        // beside Statistics because the panel that counts the states is the one
        // above it.
        {
          id: "menu-revision-state",
          opensDialog: true,
          label: () => t("menu.revision-state"),
          run: deps.openRevisionState,
        },
        // LAST, and appended rather than inserted, for the reason the two items
        // above give: `menu-drive.ts` reads item indices out of this table for
        // menu-cli, export-cli, history-cli and dialog-cli, and an item added at
        // the END of a menu moves nothing.
        //
        // In Outline, beside Revision state, because both are facts a writer
        // keeps ABOUT a row of the outline rather than in it. Not in Edit with
        // the comments: a comment is anchored to a passage of prose and moves
        // with it; a synopsis belongs to the item and exists whether or not the
        // item carries any prose at all.
        {
          id: "menu-synopsis",
          opensDialog: true,
          label: () => t("menu.synopsis"),
          run: deps.openSynopsis,
        },
        // LAST, and appended rather than inserted, for the reason the three
        // items above give: `menu-drive.ts` reads item indices out of this table
        // for menu-cli, export-cli, history-cli and dialog-cli, and an item
        // added at the END of a menu moves nothing.
        //
        // IN OUTLINE, and this is the one placement in the menu worth arguing.
        // A cast member is not a row of the outline the way a synopsis and a
        // revision state are - it is not about any row at all. But it is about
        // the BOOK rather than about the file the book lives in, which is what
        // File holds, and it is not an operation on the prose, which is what
        // Edit holds. A fifth menu title for it would put a fifth control in the
        // 900px strip that is the recorded way a bar control silently moves
        // every navigator row, for one item.
        {
          id: "menu-cast",
          opensDialog: true,
          label: () => t("menu.cast"),
          run: deps.openCast,
        },
        { id: "menu-knowledge", opensDialog: true, label: () => t("menu.knowledge"), run: () => deps.openKnowledge?.() },
        { id: "menu-craft-reports", opensDialog: true, label: () => t("menu.craft-reports"), run: () => deps.openCraftReports?.() },
        // LAST, and appended rather than inserted, for the reason the four
        // items above give: `menu-drive.ts` reads item indices out of this
        // table for menu-cli, export-cli, history-cli and dialog-cli, and an
        // item added at the END of a menu moves nothing.
        //
        // THE PAIR IS TWO ITEMS AND NOT ONE, and the split is the same one the
        // synopsis and the cast already draw across this menu: the first is
        // about the row the writer has selected and the second is about the
        // BOOK. One item with a mode would be a surface that sometimes reads
        // the selection and sometimes does not, which is the class of defect
        // the synopsis panel's capture-at-open rule exists to prevent.
        //
        // Beside the Cast, because a tag names somebody in it and the panel is
        // useless before that panel has been used.
        {
          id: "menu-appears",
          opensDialog: true,
          label: () => t("menu.appears"),
          run: deps.openAppearances,
        },
        {
          id: "menu-appears-map",
          opensDialog: true,
          label: () => t("menu.appears-map"),
          run: deps.openAppearancesMap,
        },
        // Appended after the existing outline actions: `menu-drive.ts` reads
        // item indices out of this table, so existing positions stay fixed.
        //
        // 085's own stack, distinct from Edit's Undo/Redo above (which stay
        // the editor's, over prose): both labels say when they have nothing
        // to act on, exactly like Back and Forward, and for the same reason -
        // an item that reads "Undo" and does nothing when pressed reads as a
        // broken application.
        {
          id: "menu-outline-undo",
          label: () => {
            const what = deps.outlineUndoLabel();
            return what === null ? t("menu.outline-undo.empty") : t("menu.outline-undo", { what });
          },
          shortcut: t("menu.shortcut.undo"),
          run: deps.outlineUndo,
        },
        {
          id: "menu-outline-redo",
          label: () => {
            const what = deps.outlineRedoLabel();
            return what === null ? t("menu.outline-redo.empty") : t("menu.outline-redo", { what });
          },
          shortcut: t("menu.shortcut.redo"),
          run: deps.outlineRedo,
        },
        { id: "menu-view-manuscript", label: () => t("menu.view.manuscript"), checked: () => deps.outlineViewMode() === "manuscript", run: deps.showManuscript },
        { id: "menu-view-table", label: () => t("menu.view.table"), checked: () => deps.outlineViewMode() === "table", run: deps.showOutlineTable },
        { id: "menu-view-cards", label: () => t("menu.view.cards"), checked: () => deps.outlineViewMode() === "cards", run: deps.showOutlineCards },
        // These actions extend the reading surfaces without moving earlier
        // menu indices used by the screenshot and keyboard rigs.
        { id: "menu-view-reading", label: () => t("menu.view.reading"), checked: () => deps.outlineViewMode() === "reading", run: deps.showReadThrough },
        { id: "menu-view-continuous", label: () => t("menu.view.continuous"), checked: () => deps.outlineViewMode() === "continuous", run: deps.showContinuousChapter },
        { id: "menu-open-reference", label: () => t("menu.open-reference"), run: deps.openReference },
        { id: "menu-close-reference", label: () => t("menu.close-reference"), run: deps.closeReference },
        { id: "menu-review-proposals", opensDialog: true, label: () => t("menu.review-proposals"), run: deps.openReviewProposals },
      ],
    },
    {
      id: "menu-help",
      label: t("menu.help"),
      key: t("menu.help.key"),
      items: [{ id: "menu-shortcuts", opensDialog: true, label: () => t("menu.shortcuts"), run: deps.openHelp }],
    },
  ];

  container.replaceChildren();
  container.setAttribute("role", "menubar");
  // The menubar sits inside #project-bar, which the switcher does not clear, but
  // it still needs a name: "menubar" with no name is an unlabelled landmark-ish
  // container in a strip that already holds three other groups of controls.
  container.setAttribute("aria-label", t("menu.bar.label"));

  // `onClose` is what keeps `painted` and the titles' aria-expanded in step with
  // a panel that also closes itself - every item closes before it runs. GUARDED
  // ON `painted`: `closeMenu()` nulls it BEFORE calling `panel.close()`, so a
  // close this unit asked for arrives here with nothing to do and the list is
  // left as the caller wants it (Left keeps it; a switch between menus keeps
  // it). A close the panel took on its own -- an item ran -- arrives with
  // `painted` still set, and then the list goes with the dropdown, because the
  // item has moved the writer elsewhere.
  const panel = createMenuPanel({
    id: "menu-panel",
    onClose: () => {
      if (painted !== null) close();
    },
  });

  // ONE BUTTON, ONE LIST, ONE DROPDOWN (068). The four titles are rows in
  // #app-menu-list rather than words on the header; the dropdown paints
  // beside the open row. Three states: closed; the list alone; the list
  // with one title expanded. Alt+<key> goes straight to the third, which is
  // the only route any rig takes, so nothing they measure moved.
  //
  // IDS OUTSIDE THE `menu-` NAMESPACE, on purpose: menu-cli counts every
  // `menu-*` id it does not know as an ITEM, in the closed walk too, and
  // menu-drive parses every `id: "menu-..."` literal in this file as one.
  const button = document.createElement("button");
  button.id = "app-menu";
  button.type = "button";
  button.setAttribute("aria-label", t("menu.button.label"));
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-haspopup", "true");
  button.setAttribute("aria-controls", "app-menu-list");
  button.append(createIcon("menu"));
  const buttonTip = createTooltip({
    control: button,
    name: t("menu.button.label"),
    hint: t("menu.button.hint"),
  });

  const list = document.createElement("div");
  list.id = "app-menu-list";
  list.hidden = true;

  const titles = new Map<string, HTMLButtonElement>();
  const listeners: Array<() => void> = [];

  function on<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
  ): void {
    target.addEventListener(type, handler);
    listeners.push(() => target.removeEventListener(type, handler));
  }

  let painted: Painted | null = null;

  function showList(shown: boolean): void {
    list.hidden = !shown;
    button.setAttribute("aria-expanded", String(shown));
  }

  /** Close the dropdown only; the list stays as it is. */
  function closeMenu(): void {
    if (painted === null) return;
    titles.get(painted.menu.id)?.setAttribute("aria-expanded", "false");
    painted = null;
    panel.close();
  }

  /** Close everything: what `MenuBar.close()`, Escape, an outside click and
   *  an item that ran all mean. */
  function close(): void {
    closeMenu();
    showList(false);
  }

  function open(menu: MenuSpec): void {
    // Not a toggle helper: closing first also resets the previous title's
    // aria-expanded, which is the attribute a screen reader is reading.
    const reopening = painted?.menu.id === menu.id;
    closeMenu();
    if (reopening) return;

    showList(true);
    panel.paint(menu.items, menu.label);
    const title = titles.get(menu.id);
    title?.setAttribute("aria-expanded", "true");
    // Beside the row. The list is the panel's positioned ancestor, so the
    // title's offsetTop is the row's top in the list's own box.
    const rowTop = title?.offsetTop ?? 0;
    panel.element.style.top = `${rowTop}px`;
    // 087: the Outline menu is 22 rows and left the window at the 640x480
    // floor. The room is measured from THIS row, not the viewport, because
    // the dropdown hangs off its title and a lower title has less of it; the
    // stylesheet's overflow-y does the scrolling. 120px keeps a menu readable
    // on a window too short for anything.
    const listTop = (title?.offsetParent as HTMLElement | null)?.getBoundingClientRect().top ?? 0;
    const room = Math.max(window.innerHeight - listTop - rowTop - 12, 120);
    panel.element.style.maxHeight = `${room}px`;
    painted = { menu };
  }

  for (const menu of MENUS) {
    const title = document.createElement("button");
    title.id = menu.id;
    title.type = "button";
    title.textContent = menu.label;
    // NOTE: `aria-haspopup` ALONE decides the ATK role of these titles, and it
    // makes them `combo box`. Measured by single-variable runs on WebKitGTK
    // 2.52.4: "true" and "menu" both give `combo box`, and removing the
    // attribute gives a plain `button` even with aria-expanded still on the
    // element. So aria-expanded does NOT produce `toggle button` here - that
    // mapping belongs to aria-pressed, a different attribute, on the
    // preferences panel's groups. The attribute is KEPT anyway: `combo box` at
    // least tells a screen-reader user the control opens something and is
    // collapsed, where a bare `button` drops the popup semantic entirely.
    // `nodes.ts`'s role filter does not include `combo box`, so a rig locating
    // these titles must carry its own unfiltered walk, as menu-cli does.
    title.setAttribute("aria-expanded", "false");
    title.setAttribute("aria-haspopup", "true");
    title.setAttribute("aria-controls", "menu-panel");
    on(title, "click", () => open(menu));
    // Hover switches menus only while a dropdown is open, which is what a menu
    // bar does everywhere else: the pointer resting on a row of the bare list
    // opens nothing.
    on(title, "mouseenter", () => {
      if (painted !== null && painted.menu.id !== menu.id) open(menu);
    });
    titles.set(menu.id, title);
    list.append(title);
  }

  list.append(panel.element);
  container.append(buttonTip.anchor, list);

  // A pointer click on the button toggles the list alone and puts the keyboard
  // on File, so Down and Right have somewhere to start from.
  on(button, "click", () => {
    if (!list.hidden) {
      close();
      return;
    }
    showList(true);
    titles.get(MENUS[0]?.id ?? "")?.focus();
  });

  // Alt+<key> from anywhere in the page. On the DOCUMENT rather than on the bar
  // because the writer is almost always focused in the editor, and a menu you
  // can only open once you have tabbed to it is a menu with a prerequisite.
  const onDocumentKey = (event: KeyboardEvent): void => {
    if (isCompositionKey(event)) return;
    const privacyShortcut = deps.privacyShortcut?.() ?? "ctrl_alt_l";
    if (privacyShortcut !== "off" && event.ctrlKey && event.altKey && !event.shiftKey && !event.metaKey &&
        !event.repeat && !event.isComposing && event.key.toLowerCase() === (privacyShortcut === "ctrl_alt_p" ? "p" : "l") &&
        deps.canLockPrivacy?.()) {
      event.preventDefault();
      close();
      deps.lockPrivacy?.();
      return;
    }
    // Ctrl+Shift+L (099), application chrome exactly like the Alt+<key> branch
    // below: this listener is installed once and outlives every project
    // switch, and `deps.openLibrary` must work with nothing mounted -- the
    // whole reason the chord lives here rather than inside a per-project
    // keydown handler in project.ts, which is torn down and rebuilt on every
    // switch and does not exist at all at an empty boot.
    if (
      event.ctrlKey &&
      event.shiftKey &&
      !event.altKey &&
      !event.metaKey &&
      event.key.toLowerCase() === "l"
    ) {
      event.preventDefault();
      deps.openLibrary();
      return;
    }
    if (event.altKey && !event.ctrlKey && !event.metaKey) {
      const menu = MENUS.find((candidate) => candidate.key.toLowerCase() === event.key.toLowerCase());
      if (menu !== undefined) {
        event.preventDefault();
        // The chord for the menu that is ALREADY open is a toggle to the clean
        // closed state. open() would only collapse the dropdown, leaving the
        // bare list up with focus on nothing and the arrows dead.
        if (painted?.menu.id === menu.id) {
          close();
          button.focus();
          return;
        }
        open(menu);
        panel.focusItem(0);
        return;
      }
    }
    // Everything closed: the arrows belong to the navigator, and nothing here
    // may preventDefault them.
    if (painted === null && list.hidden) return;

    if (event.key === "Escape") {
      // Always closes. Focus moves ONLY when it was inside the bar: the item
      // or row it was on has just left the screen, and a keyboard needs
      // somewhere to continue from. A writer who Tabbed out of the open list
      // into the editor and pressed Escape there meant the editor's Escape --
      // taking the caret away from the prose for a list they had already left
      // is focus stolen page-wide, and the event is theirs to keep.
      const inside = container.contains(document.activeElement);
      close();
      if (inside) {
        event.preventDefault();
        button.focus();
      }
      return;
    }
    if (painted !== null) {
      if (panel.handleArrowKey(event)) return;
      if (event.key === "ArrowLeft") {
        // Back to the list: the dropdown goes, its title takes focus.
        event.preventDefault();
        const id = painted.menu.id;
        closeMenu();
        titles.get(id)?.focus();
      }
      return;
    }
    // The list alone. Down and Up walk the rows and wrap; Right opens the
    // focused row and enters its dropdown.
    const onTitle = MENUS.findIndex((m) => titles.get(m.id) === document.activeElement);
    if (onTitle < 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = MENUS[(onTitle + step + MENUS.length) % MENUS.length];
      if (next !== undefined) titles.get(next.id)?.focus();
      return;
    }
    if (event.key === "ArrowRight") {
      // Enter and Space are the button's native click, which opens without
      // moving focus, as a pointer click does. Right is "open and enter".
      event.preventDefault();
      const menu = MENUS[onTitle];
      if (menu !== undefined) {
        open(menu);
        panel.focusItem(0);
      }
    }
  };
  document.addEventListener("keydown", onDocumentKey);
  listeners.push(() => document.removeEventListener("keydown", onDocumentKey));

  // A click anywhere else closes. Registered on the document in the CAPTURE
  // phase so it runs before the clicked control's own handler: a writer clicking
  // Export with the File menu open should get one export and no dropdown, not a
  // dropdown that closes after the export bar has already read a stale layout.
  const onDocumentClick = (event: MouseEvent): void => {
    if (painted === null && list.hidden) return;
    const target = event.target;
    if (target instanceof Node && container.contains(target)) return;
    close();
  };
  document.addEventListener("click", onDocumentClick, true);
  listeners.push(() => document.removeEventListener("click", onDocumentClick, true));

  let destroyed = false;
  return {
    close,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      for (const off of listeners) off();
      listeners.length = 0;
      painted = null;
      panel.destroy();
      titles.clear();
      buttonTip.destroy();
      container.replaceChildren();
      container.removeAttribute("role");
      container.removeAttribute("aria-label");
    },
  };
}
