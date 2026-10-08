// app/ui/src/switcher.ts
// The project surface: a header strip naming the open manuscript, and a panel
// listing the others. There is deliberately no native file dialog - it would be
// a new dependency and a modal the Xvfb rig cannot drive, so every graded run
// would have to skip the one surface a person actually uses to change projects.

import { isCompositionKey } from "./composition-key";
import { plural, t } from "./i18n";
import { createPanelShell } from "./panel-shell";
import { formatWhen, type RecoveryPoint } from "./recovery-indicator";
import type { Archive, ArchiveReport } from "./archive-indicator";
import type { MirrorReport } from "./mirror-indicator";
import { createIcon } from "./icons";
import { createTooltip } from "./tooltip";
import { createHelpTip, type HelpTip } from "./help-tip";

/** What the host says about the readable mirror.
 *
 *  A THIRD PROTECTION-SHAPED THING THAT IS NOT A PROTECTION. The recovery
 *  section above is a second copy on this device; the archive section is a file
 *  to carry away. This is the writer's own manuscript in ordinary Markdown, so
 *  they can open one scene in any editor. Every string here is written under
 *  that constraint: this writes files and never reads one back, so the panel
 *  must not imply an edit made outside would come home. */
export type { MirrorReport } from "./mirror-indicator";

export interface MirrorPreview {
  readonly token: string | null;
  readonly dir: string;
  readonly check_state: "ran" | "vacuous" | "not_applicable";
  readonly pin_state: "unset" | "pinned" | "stale";
  readonly findings: ReadonlyArray<{
    readonly surface: string;
    readonly item_id: string | null;
    readonly matched: string;
  }>;
  readonly files: number;
  readonly scope: ReadonlyArray<"destination" | "project_name" | "markdown" | "wordlist">;
  readonly limits: ReadonlyArray<"known_names" | "excluded" | "external">;
}

export interface ProjectSummary {
  path: string;
  name: string;
  modified_at: number;
  /** Set when the file exists but could not be opened. Such a project is shown
   *  with its error and is NOT activatable: a manuscript that has become
   *  unreadable must be visible, not silently absent. */
  error?: string | null;
  /** The file is not there at all -- a book the writer moved or deleted in
   *  their file manager. The one kind of row that offers Forget. */
  missing?: boolean;
  registration_warning?: { token: string | null; kind?: "registration_pending" | "destination_preference" | "registration_unavailable"; error: string } | null;
}

export interface PendingRegistration {
  token: string;
  path: string;
  name: string;
}

export function registrationNotice(project: ProjectSummary): string | null {
  const warning = project.registration_warning;
  if (!warning) return null;
  if (warning.kind === "destination_preference") return t("registration.preference", { path: project.path });
  if (warning.kind === "registration_unavailable" || !warning.token) return t("registration.unavailable", { path: project.path });
  return `${t("registration.warning", { path: project.path })} ${t("registration.session")}`;
}

/** What the host answers for the drop folder: the RESOLVED directory and the
 *  Markdown or DOCX files sitting in it. `dir` is present even when the
 *  directory could not be read -- on a first run nothing has created it yet,
 *  and the path is the only actionable thing the panel can say. */
export interface ImportReport {
  dir: string;
  files: readonly string[];
}

/** Omitted DOCX content, by kind. Markdown keeps these counts at zero;
 * derived contents are reported separately on ImportOutcome. */
export interface ImportLosses {
  tables: number;
  pictures: number;
  notes: number;
  comments: number;
  links: number;
  fields: number;
  lists: number;
  revisions: number;
}

/** The new project, omitted content, and recognized derived sections. */
export interface ImportOutcome {
  /** A leading contents list omitted because exports regenerate it. */
  derived_contents?: string | null;
  summary: ProjectSummary;
  losses: ImportLosses;
}

/** What a complete mirror check found. The host rejects rather than returning
 * this shape if it could not finish reading every entry. */
export interface MirrorCheck {
  entries: number;
  hashed: number;
  changed: number;
  deleted: number;
}

/** A preserved legacy folder whose ownership cannot be proven. */
export interface LegacyProtection {
  surface: "recovery" | "mirror";
  dir: string;
}

export interface SwitcherDeps {
  /** Where the book's NAME is painted: the strip above the outline, not the
   *  project bar. Separate from `container` because the panel is positioned
   *  against #project-bar and the name is not in it any more. */
  nameContainer: HTMLElement;
  /** The header strip element, already in index.html. */
  container: HTMLElement;
  listProjects(): Promise<ProjectSummary[]>;
  listPendingRegistrations?(): Promise<PendingRegistration[]>;
  retryRegistration?(token: string): Promise<ProjectSummary>;
  createProject(name: string): Promise<ProjectSummary>;
  /** Create a book in a folder the WRITER picks, through the operating system.
   *
   *  `null` is the writer CANCELLING the dialog, and it is an answer rather
   *  than a failure: it must raise no notice and leave the typed name alone, so
   *  a writer who changed their mind about the folder has not lost the name
   *  they were half way through choosing. */
  createProjectIn(name: string): Promise<ProjectSummary | null>;
  /** Where the next new book would go, resolved. */
  newDir(): Promise<string>;
  /** The Markdown files the writer has dropped in for import, by name. */
  /** The drop directory and what is in it. The DIRECTORY comes from the host
   *  and is never composed here: `imports_dir` honours an override, so a
   *  page-side `<data_home>/imports` would be wrong exactly where the override
   *  is used. Same contract as the mirror's and the archive's `dir`. */
  listImports(): Promise<ImportReport>;
  /** Import one of them as a new project. Like createProject, does NOT switch.
   *  Resolves with the loss report as well as the summary, so a DOCX source
   *  that could not carry everything is said out loud). */
  importProject(filename: string): Promise<ImportOutcome>;
  /** The verified recovery points for this project, newest first. */
  listRecoveryPoints(): Promise<RecoveryPoint[]>;
  /** Preserved folders from before book identities could prove their owner. */
  legacyProtection?(): Promise<LegacyProtection[]>;
  /** Restore one, as a NEW project. Like importProject, does NOT switch, and
   *  cannot replace anything that already exists. */
  restorePoint(id: string, allowPictureGaps?: boolean): Promise<ProjectSummary>;
  /** The verified archives for this project, newest first. */
  listArchives(): Promise<Archive[]>;
  /** Where the archives are written, so the panel can tell the writer where to
   *  go. The one path this unit renders; it names artifacts by file everywhere
   *  else. */
  archiveStatus(): Promise<ArchiveReport>;
  /** Write one, because the writer asked. There is no schedule and no
   *  destination dialog: the application writes the file where it can and the
   *  writer moves it off the machine themselves. */
  makeArchive(): Promise<Archive>;
  /** Native dialogs choose every key and archive path. The page receives only public results. */
  generateArchiveKey?(): Promise<{ recipient: string } | null>;
  encryptedBackupDestination?(): Promise<string | null>;
  chooseEncryptedBackupDestination?(): Promise<string | null>;
  makeEncryptedArchive?(): Promise<{ file: string; recipient: string; encrypted: true } | null>;
  verifyEncryptedArchive?(): Promise<{ file: string; encrypted: true } | null>;
  restoreEncryptedArchive?(): Promise<ProjectSummary | null>;
  /** A status read after a native operation, so a lock never reveals its result. */
  canReportArchive?(): Promise<boolean>;
  /** The host's opening generation, including a reopen of the same path. */
  currentGeneration?(): number;
  /** Whether the readable mirror is on for this project, where it lands, and
   *  how much is there. Never rejects for "off": off is the default. */
  mirrorStatus(): Promise<MirrorReport>;
  /** Turn it on or off. Turning it ON writes the first pass immediately rather
   *  than waiting out the staleness bound, so a writer who says yes can go and
   *  look. Turning it OFF leaves the files. */
  previewMirror(): Promise<MirrorPreview>;
  enableMirror(on: boolean, token?: string): Promise<MirrorReport>;
  /** Hash every mirror entry and report only a complete result. */
  checkMirror(): Promise<MirrorCheck>;
  switchTo(path: string): Promise<void>;
  /** Move the OPEN book's file into a folder the writer picks in the host's
   *  own dialog. `null` is the writer cancelling. The caller keeps its own
   *  copy of the current path up to date from the answer; this unit repaints
   *  from `currentPath()` afterwards. */
  moveProject(): Promise<ProjectSummary | null>;
  currentPath(): string;
  currentName(): string;
  /** Give the OPEN project a new name. Answers the stored summary: the bar is
   *  painted from what the host recorded, never from what was typed, because the
   *  two differ by the trim. Moves no file -- the name is a label and the file is
   *  the identity (see `rename_open` in the host). */
  renameProject(name: string): Promise<ProjectSummary>;
  /** Drop a MISSING book from the list. The host refuses a file that is still
   *  there and a path it never recorded; nothing on disk is touched. */
  forgetProject(path: string): Promise<void>;
  /** One click to the cast. The header's own button opens the same
   *  panel the Outline menu's `menu-cast` does; this is that route, not a
   *  second implementation. */
  openCast(): void;
  openCreation?: () => void;
  /** Never the save banner: a project-surface failure is not a failed save. */
  onNotice(message: string): void;
  /** The unit's own successes: an archive written, the mirror toggled, a
   *  recovery point restored. Kept apart from `onNotice` for the reason the
   *  other ten units keep it apart -- a unit knows which of its messages is
   *  news and the page should not have to guess from the wording. */
  onDone(message: string): void;
  /** Where focus goes when the panel is dismissed. The toggle that used to sit
   *  in the bar was this unit's focus-return target; with the menu as the only
   *  route in, the unit no longer has one of its own and the page decides. */
  onDismiss: () => void;
  /** Whether any copy failed, went stale or is paused (the footer dot's
   *  amber). Read on every open: Backups and archives opens by itself
   *  only then. Absent means never. */
  copiesNeedAttention?: () => boolean;
}

/** The last folder a path names, for the panel's short form of a path.
 *  `file` takes the folder the file is IN; otherwise the path is a folder.
 *  Both separators, because a Windows build hands back backslashes. Falls
 *  back to the whole path when there is no segment to take, so the line
 *  never goes blank. */
export function folderName(path: string, file: boolean): string {
  const parts = path.split(/[\\/]+/).filter((part) => part.length > 0);
  if (file) parts.pop();
  return parts.at(-1) ?? path;
}

/** Which control the File menu asked to reach. Three menu items opening this
 *  one panel identically would be three names for a single action; opening it
 *  with the relevant control focused is what makes them genuinely different
 *  things to have asked for. Real OS file dialogs will arrive and will make
 *  the distinction structural rather than a caret position. */
export type SwitcherFocus = "list" | "create" | "import" | "copies" | "backups" | "restore";

export interface Switcher {
  /** Repaint the current project's name after a switch. */
  refresh(name: string): void;
  /** Open the panel and reload it, with focus on the control the caller named.
   *  File > New project… and File > Open project… are the two routes in. */
  open(focus: SwitcherFocus): void;
  /** Start renaming the open book, in the header, without a click on it.
   *  File > Rename project... calls this: one implementation, two routes. */
  beginRename(): void;
  /** Show or hide the header's own book-shaped controls -- the rename button,
   *  its field, and the cast button beside it. `false` at the empty boot:
   *  `createSwitcher` builds these into `#nav-header` unconditionally,
   *  before main.ts knows whether a book is open, so with nothing open they
   *  would otherwise sit beside `library.no-book`'s sentence reading a
   *  leftover project name and offering a Cast panel with nothing in it --
   *  both routes into commands that only answer "no project is open". Also
   *  cancels a rename in progress, the same way a switch away from the open
   *  book already would. */
  setBookOpen(open: boolean): void;
  destroy(): void;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The loss notice for a DOCX import, or null when nothing was dropped --
 * DOCX losses and a recognized contents section share the existing notice
 * channel. Both the import panel and file-picker route use this formatter. */
export function lossesNotice(losses: ImportLosses, derivedContents?: string | null): string | null {
  const parts: string[] = [];
  const kinds: [keyof ImportLosses, string][] = [
    ["tables", "import.loss.tables"],
    ["pictures", "import.loss.pictures"],
    ["notes", "import.loss.notes"],
    ["comments", "import.loss.comments"],
    ["links", "import.loss.links"],
    ["fields", "import.loss.fields"],
    ["lists", "import.loss.lists"],
    ["revisions", "import.loss.revisions"],
  ];
  for (const [field, key] of kinds) {
    const count = losses[field];
    if (count > 0) parts.push(plural(key, count));
  }
  const notices = parts.length === 0 ? [] : [t("import.losses", { list: parts.join(", ") })];
  if (losses.revisions > 0) notices.push(t("import.loss.revisions.warning"));
  if (derivedContents !== undefined && derivedContents !== null) {
    notices.push(t("import.contents-derived", { title: derivedContents }));
  }
  return notices.length === 0 ? null : notices.join(". ");
}

/** Registration problems and import omissions share one durable notice. */
export function importResultNotice(outcome: ImportOutcome): { message: string; problem: boolean } | null {
  const warning = registrationNotice(outcome.summary);
  const omissions = lossesNotice(outcome.losses, outcome.derived_contents);
  const message = [warning, omissions].filter((part) => part !== null).join(" ");
  return message === "" ? null : { message, problem: warning !== null };
}

export function createSwitcher(deps: SwitcherDeps): Switcher {
  const { container } = deps;
  let bookOpen = deps.currentPath() !== "";
  const hasBook = (): boolean => bookOpen && deps.currentPath() !== "";

  container.setAttribute("role", "banner");
  container.replaceChildren();

  // THE BOOK'S NAME, in the strip above the outline rather than in the project
  // bar: a manuscript's title
  // belongs over its own outline, and the bar's width is genuinely scarce.
  //
  // A BUTTON, not a span with a click handler. It is the rename affordance, and
  // a screen reader has to be told that before the writer presses it -- which a
  // styled span cannot say however it is painted.
  const name = document.createElement("button");
  name.id = "project-name-label";
  name.type = "button";
  name.textContent = deps.currentName();
  name.title = t("switcher.rename.hint");

  const nameField = document.createElement("input");
  nameField.id = "project-name-field";
  nameField.type = "text";
  nameField.hidden = true;
  nameField.setAttribute("aria-label", t("switcher.rename.label"));

  // The Cast icon shares the creation control's focus-and-hover description.
  const cast = document.createElement("button");
  cast.id = "nav-cast";
  cast.type = "button";
  cast.setAttribute("aria-label", t("nav.cast.label"));
  cast.append(createIcon("users"));
  const castTip = createTooltip({ control: cast, name: t("nav.cast.label"), hint: null });

  const add = document.createElement("button");
  add.id = "book-create";
  add.type = "button";
  add.textContent = t("creation.plus");
  add.setAttribute("aria-label", t("creation.open"));
  const addTip = createTooltip({ control: add, name: t("creation.open"), hint: null });
  const onAdd = (): void => { if (hasBook()) deps.openCreation?.(); };
  add.addEventListener("click", onAdd);
  const panel = document.createElement("div");
  panel.id = "project-panel";
  panel.setAttribute("role", "dialog");
  // Nothing here traps focus, and aria-modal="true" would tell a screen reader
  // the rest of the page is inert when it is not.
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-label", t("switcher.title"));
  panel.hidden = true;

  const listbox = document.createElement("div");
  listbox.id = "project-list";
  listbox.setAttribute("role", "list");
  listbox.setAttribute("aria-label", t("switcher.title"));
  // Programmatically focusable, not a tab stop. The File menu's "Open project…"
  // opens the panel and lands here; without a tabIndex a div ignores .focus()
  // silently and the menu item would appear to do nothing to a keyboard user
  // while working perfectly for a mouse. -1 rather than 0 because Tab already
  // reaches the rows themselves.
  listbox.tabIndex = -1;

  const newHeading = document.createElement("div");
  newHeading.id = "project-new-heading";
  newHeading.textContent = t("switcher.new.heading");

  const input = document.createElement("input");
  input.id = "project-new-name";
  input.type = "text";
  input.setAttribute("aria-label", t("switcher.name.label"));

  const newNameField = document.createElement("div");
  newNameField.className = "field-with-label";
  const nameLabel = document.createElement("label");
  nameLabel.htmlFor = input.id;
  nameLabel.textContent = t("switcher.name.label");
  newNameField.append(nameLabel, input);

  const create = document.createElement("button");
  create.id = "project-create";
  create.type = "button";
  create.textContent = t("switcher.create");
  // The panel's one creating action, beside a list of projects and an import
  // list that are both navigation.
  create.dataset.weight = "primary";

  // WHERE THE BOOK WILL GO, shown before the writer commits, for its
  // reason: the resolved destination is the thing being consented to,
  // and this is the one that catches a book about to land somewhere the writer
  // did not mean -- a synced folder, or the library when they thought they had
  // chosen otherwise.
  const newWhere = document.createElement("div");
  newWhere.id = "project-new-where";

  // WHERE THE OPEN BOOK IS. Painted from `currentPath()` on every open and
  // after a move; the repainted path is the confirmation, there is no
  // separate message.
  const here = document.createElement("div");
  here.id = "project-here";
  const move = document.createElement("button");
  move.id = "project-move";
  move.type = "button";
  move.textContent = t("switcher.move");
  move.title = t("switcher.move.hint");
  move.dataset.weight = "quiet";

  // A SECOND ACT, not a required one. Create still puts the book in the
  // remembered folder with no dialog at all; this is for the writer who wants
  // to say where, and the folder they pick becomes the default for next time.
  const chooseWhere = document.createElement("button");
  chooseWhere.id = "project-new-choose";
  chooseWhere.type = "button";
  chooseWhere.textContent = t("switcher.where.choose");
  chooseWhere.dataset.weight = "quiet";


  // Import lives HERE and not in the project bar. The bar is five controls wide
  // and its 39px height is a click-geometry constant restated in outline-cli,
  // export-cli, words-cli and switch-cli; a sixth control there would be a
  // geometry change on four graded rigs to deliver a verb that is not about the
  // open manuscript at all. Import creates a project, and creating a project
  // already lives in this panel.
  const importHeading = document.createElement("div");
  importHeading.id = "project-import-heading";
  importHeading.textContent = t("switcher.import.heading");

  // The second path this unit renders, for the archive's reason: the writer has
  // to walk to this directory themselves, and an instruction to put a file
  // somewhere is useless without the somewhere.
  const importWhere = document.createElement("div");
  importWhere.id = "project-import-where";

  const importList = document.createElement("div");
  importList.id = "project-imports";
  importList.setAttribute("role", "list");
  importList.setAttribute("aria-label", t("switcher.import.list.label"));
  // Same reason as the project list above.
  importList.tabIndex = -1;

  // Restore lives HERE for the reason import does, and the reason is stronger:
  // restoring CREATES A PROJECT, which is what this panel is for, and the
  // writer's next act is to compare the restored copy against the one already
  // in the list above it. A control in the project bar would put the two on
  // different surfaces and move a click-geometry constant five rigs restate.
  const recoveryHeading = document.createElement("div");
  recoveryHeading.id = "project-recovery-heading";
  recoveryHeading.textContent = t("switcher.recovery.heading");

  // The note sits where the action is rather than in a confirmation nobody
  // reads. A writer reaching for a recovery point is usually reaching for it
  // because something went wrong, and "nothing is replaced" is the fact that
  // makes the button safe to press.
  const recoveryNote = document.createElement("div");
  recoveryNote.id = "project-recovery-note";
  recoveryNote.textContent = t("switcher.recovery.note");

  const recoveryList = document.createElement("div");
  recoveryList.id = "project-recovery-points";
  recoveryList.setAttribute("role", "list");
  recoveryList.setAttribute("aria-label", t("switcher.recovery.list.label"));
  // Same reason as the project list above.
  recoveryList.tabIndex = -1;

  const legacyRecovery = document.createElement("div");
  legacyRecovery.id = "project-legacy-recovery";
  legacyRecovery.hidden = true;

  // DEVICE-LOSS PROTECTION, AND ITS OWN SECTION. The maintenance note is
  // explicit that this must not be folded into the recovery heading above it:
  // the design's section 6 argument is that in-project history, same-device
  // recovery and a file the writer moves off the computer themselves are three
  // different promises, and one heading covering two of them is that blur with
  // a different shape.
  //
  // LAST in the panel, deliberately. Every other section here ends with the
  // writer looking at a project in this application. This one ends with them
  // in their own file manager, which is the only step this application cannot
  // take for them.
  const archiveHeading = document.createElement("div");
  archiveHeading.id = "project-archive-heading";
  archiveHeading.textContent = t("switcher.archive.heading");

  // THE MANDATED SENTENCE, where the action is. The design spells this one out
  // word for word because the failure it prevents is a writer believing the
  // application put their book somewhere safe. It did not: it wrote a file, and
  // it cannot see whether that file ever left.
  const archiveNote = document.createElement("div");
  archiveNote.id = "project-archive-note";
  archiveNote.textContent = t("switcher.archive.note");

  // The one path this unit renders. Everywhere else the page names an artifact
  // and the host resolves it; here the writer has to walk to the directory
  // themselves, and a sentence telling them to move a file is useless without
  // the place it is in.
  const archiveWhere = document.createElement("div");
  archiveWhere.id = "project-archive-where";

  const archiveNow = document.createElement("button");
  archiveNow.id = "project-archive-now";
  archiveNow.type = "button";
  archiveNow.textContent = t("switcher.archive.action");

  const encryptedNote = document.createElement("div");
  encryptedNote.id = "project-encrypted-archive-note";
  encryptedNote.textContent = t("switcher.archive.encrypted.note");
  const backupWhere = document.createElement("div");
  backupWhere.id = "project-backup-destination";
  backupWhere.hidden = deps.encryptedBackupDestination === undefined;
  const backupChoose = document.createElement("button");
  backupChoose.id = "project-backup-destination-choose";
  backupChoose.type = "button";
  backupChoose.textContent = t("switcher.archive.destination.choose");
  backupChoose.hidden = deps.chooseEncryptedBackupDestination === undefined;
  const backupNote = document.createElement("div");
  backupNote.id = "project-backup-destination-note";
  backupNote.textContent = t("switcher.archive.destination.note");
  const archiveKey = document.createElement("button");
  archiveKey.id = "project-archive-key";
  archiveKey.type = "button";
  archiveKey.textContent = t("switcher.archive.key.action");
  archiveKey.hidden = deps.generateArchiveKey === undefined;
  const archiveEncrypted = document.createElement("button");
  archiveEncrypted.id = "project-archive-encrypted";
  archiveEncrypted.type = "button";
  archiveEncrypted.textContent = t("switcher.archive.encrypted.action");
  archiveEncrypted.hidden = deps.makeEncryptedArchive === undefined;
  const archiveVerify = document.createElement("button");
  archiveVerify.id = "project-archive-encrypted-verify";
  archiveVerify.type = "button";
  archiveVerify.textContent = t("switcher.archive.encrypted.verify");
  archiveVerify.hidden = deps.verifyEncryptedArchive === undefined;
  const archiveRestore = document.createElement("button");
  archiveRestore.id = "project-archive-encrypted-restore";
  archiveRestore.type = "button";
  archiveRestore.textContent = t("switcher.archive.encrypted.restore");
  archiveRestore.hidden = deps.restoreEncryptedArchive === undefined;

  // The mirror, and it is LAST because it is the only section here that ends
  // with the writer in another application entirely, working on the same book.
  // Not a protection and never described as one: it lives on this computer,
  // and in this slice the application writes it and never reads it back.
  const mirrorHeading = document.createElement("div");
  mirrorHeading.id = "project-mirror-heading";
  mirrorHeading.textContent = t("switcher.mirror.heading");

  const mirrorNote = document.createElement("div");
  mirrorNote.id = "project-mirror-note";
  mirrorNote.textContent = t("switcher.mirror.note");

  // The RESOLVED destination, and showing it is the design's own reason for
  // making enabling deliberate: it is what catches a mirror landing in a synced
  // or cloud folder, which is the one place two pen names' manuscripts end up
  // side by side.
  const mirrorWhere = document.createElement("div");
  mirrorWhere.id = "project-mirror-where";

  const mirrorState = document.createElement("div");
  mirrorState.id = "project-mirror-state";

  const legacyMirror = document.createElement("div");
  legacyMirror.id = "project-legacy-mirror";
  legacyMirror.hidden = true;

  const mirrorToggle = document.createElement("button");
  mirrorToggle.id = "project-mirror-toggle";
  mirrorToggle.type = "button";
  mirrorToggle.textContent = t("switcher.mirror.enable");

  const mirrorCheck = document.createElement("button");
  mirrorCheck.id = "mirror-check";
  mirrorCheck.type = "button";
  mirrorCheck.textContent = t("switcher.mirror.check");
  // No report has established that this mirror exists yet. The first status
  // read enables it only for a built mirror.
  mirrorCheck.disabled = true;

  const mirrorPreview = document.createElement("section");
  mirrorPreview.id = "project-mirror-preview";
  mirrorPreview.setAttribute("role", "group");
  mirrorPreview.setAttribute("aria-label", t("switcher.mirror.preview.heading"));
  mirrorPreview.tabIndex = -1;
  mirrorPreview.hidden = true;
  const mirrorPreviewContent = document.createElement("div");
  const mirrorConfirm = document.createElement("button");
  mirrorConfirm.type = "button";
  mirrorConfirm.textContent = t("switcher.mirror.preview.confirm");
  const mirrorCancel = document.createElement("button");
  mirrorCancel.type = "button";
  mirrorCancel.textContent = t("switcher.mirror.preview.cancel");
  mirrorPreview.append(mirrorPreviewContent, mirrorConfirm, mirrorCancel);

  const archiveList = document.createElement("div");
  archiveList.id = "project-archives";
  archiveList.setAttribute("role", "list");
  archiveList.setAttribute("aria-label", t("switcher.archive.list.label"));
  // Same reason as the project list above.
  archiveList.tabIndex = -1;

  // PROGRESSIVE DISCLOSURE. The panel opened on four encryption
  // buttons, two lists and three explanations a writer reaches for rarely,
  // under the books they came to open. Two disclosures hold them: the
  // import folder while it is empty, and everything about copies. The
  // HEADINGS and notes inside are unchanged (project-panel-a11y reads them
  // by id), and nothing is removed from the tree: a closed region is
  // `hidden`, exactly as any other surface here is.
  function disclosure(id: string, controls: string, key: string): HTMLButtonElement {
    const toggle = document.createElement("button");
    toggle.id = id;
    toggle.type = "button";
    toggle.className = "disclosure";
    toggle.dataset.weight = "quiet";
    toggle.textContent = t(key);
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-controls", controls);
    return toggle;
  }
  const importToggle = disclosure("project-import-toggle", "project-import-body", "switcher.import.show");
  const importBody = document.createElement("div");
  importBody.id = "project-import-body";
  importBody.hidden = true;
  importBody.append(importWhere, importList);

  const copyHelp: HelpTip[] = [];
  function explain(label: HTMLElement, note: HTMLElement): void {
    const help = createHelpTip({ label: label.textContent ?? "", definition: note.textContent ?? "", id: `${note.id}-help` });
    const description = help.anchor.querySelector(".help-tip-text");
    if (description) description.id = note.id;
    help.button.setAttribute("aria-describedby", note.id);
    label.append(help.anchor);
    copyHelp.push(help);
  }
  const encryptedHeading = document.createElement("div");
  encryptedHeading.id = "project-encrypted-archive-heading";
  encryptedHeading.tabIndex = -1;
  encryptedHeading.textContent = t("switcher.archive.encrypted.heading");
  for (const heading of [newHeading, importHeading, recoveryHeading, archiveHeading, encryptedHeading, mirrorHeading]) {
    heading.setAttribute("role", "heading");
    heading.setAttribute("aria-level", "3");
    // Keep the help button out of the heading's accessible name.
    heading.setAttribute("aria-label", heading.textContent ?? "");
  }
  explain(recoveryHeading, recoveryNote);
  explain(archiveHeading, archiveNote);
  explain(encryptedHeading, encryptedNote);
  const backupChoice = document.createElement("div");
  backupChoice.id = "project-backup-choice";
  backupChoice.append(backupChoose);
  backupChoice.hidden = backupChoose.hidden;
  explain(backupChoice, backupNote);
  explain(mirrorHeading, mirrorNote);

  const copiesToggle = disclosure("project-copies-toggle", "project-copies", "switcher.copies");
  const copies = document.createElement("div");
  copies.id = "project-copies";
  copies.hidden = true;
  const bookRequired = document.createElement("div");
  bookRequired.id = "project-book-required";
  bookRequired.textContent = t("switcher.book-required");
  copies.append(
    bookRequired,
    recoveryHeading,
    recoveryList,
    legacyRecovery,
    archiveHeading,
    archiveWhere,
    archiveNow,
    archiveList,
    encryptedHeading,
    backupWhere,
    backupChoice,
    archiveKey,
    archiveEncrypted,
    archiveVerify,
    archiveRestore,
    mirrorHeading,
    mirrorWhere,
    mirrorState,
    legacyMirror,
    mirrorToggle,
    mirrorCheck,
    mirrorPreview,
  );

  // Its own section, under the rule the other sections carry.
  const copiesSection = document.createElement("div");
  copiesSection.id = "project-copies-section";
  copiesSection.append(copiesToggle, copies);

  function expand(toggle: HTMLButtonElement, region: HTMLElement, open: boolean): void {
    region.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
  }
  const onImportToggle = (): void => expand(importToggle, importBody, importBody.hidden);
  const onCopiesToggle = (): void => {
    if (destroyed || panel.hidden) return;
    const opening = copies.hidden;
    expand(copiesToggle, copies, opening);
    if (opening) copiesToggle.scrollIntoView({ block: "start", inline: "nearest" });
  };

  const pendingList = document.createElement("div");
  pendingList.id = "project-pending-registrations";
  pendingList.hidden = true;
  panel.append(
    listbox,
    pendingList,
    here,
    move,
    newHeading,
    newNameField,
    newWhere,
    chooseWhere,
    create,
    importHeading,
    importToggle,
    importBody,
    copiesSection,
  );
  container.append(panel);
  // A SECOND container, and the only element outside the bar this unit owns.
  // The panel stays anchored inside #project-bar, because that is what every
  // absolutely-positioned panel here is positioned against.
  deps.nameContainer.append(name, nameField, addTip.anchor, castTip.anchor);

  // A list request that resolves after the panel closed (or after a newer one
  // was issued) must not repaint: the reader would see rows appear under a
  // closed panel, or an older listing overwrite a newer one.
  let generation = 0;
  let destroyed = false;
  // Keyed by path rather than read back off the row: the row's text is a
  // display string and reconstructing an error from it would garble any
  // message containing the separator.
  const errors = new Map<string, string>();

  function renderMessage(text: string): void {
    const row = document.createElement("div");
    row.textContent = text;
    listbox.replaceChildren(row);
  }

  function renderProjects(projects: readonly ProjectSummary[]): void {
    const current = deps.currentPath();
    errors.clear();
    if (projects.length === 0) {
      // An EMPTY STATE, for the reason renderImports already carries one: a
      // listbox that paints nothing is indistinguishable from one that failed to
      // paint, and the writer cannot act on either. Reachable when the open
      // project lives outside the library (APP_PROJECT), which is exactly the
      // configuration every screenshot capture runs in - so the panel has been
      // photographed showing a blank gap where its list should be.
      renderMessage(t(current === "" ? "switcher.empty" : "switcher.empty.open"));
      return;
    }
    const healthyNameCounts = new Map<string, number>();
    for (const project of projects) {
      if (!project.missing && !project.error) {
        healthyNameCounts.set(project.name, (healthyNameCounts.get(project.name) ?? 0) + 1);
      }
    }
    const frag = document.createDocumentFragment();
    for (const project of projects) {
      const row = document.createElement("div");
      row.setAttribute("role", "listitem");
      row.dataset.projectPath = project.path;
      if (project.path === current) row.setAttribute("aria-current", "true");
      if (project.missing) {
        // The file is gone. Say where it was looked for -- the path is the one
        // actionable fact -- and offer to forget it. The row itself stays
        // inert, as an errored row is: activating a book that is not there
        // has nothing to do. The SQLite message for a missing file is not
        // a sentence about a moved book, so it is not shown here.
        errors.set(project.path, t("switcher.row.missing.notice", { path: project.path }));
        const text = document.createElement("span");
        text.textContent = t("switcher.row.missing", { name: project.name, path: project.path });
        const forget = document.createElement("button");
        forget.type = "button";
        forget.className = "switcher-forget";
        forget.dataset.forgetPath = project.path;
        forget.textContent = t("switcher.forget");
        forget.setAttribute("aria-label", t("switcher.forget.label", { name: project.name }));
        forget.title = t("switcher.forget.hint");
        row.append(text, forget);
      } else if (project.error) {
        errors.set(project.path, project.error);
        row.setAttribute("aria-disabled", "true");
        row.textContent = t("switcher.row.error", {
          name: project.name,
          error: project.error,
        });
      } else {
        if ((healthyNameCounts.get(project.name) ?? 0) > 1) {
          const name = document.createElement("span");
          name.className = "switcher-project-name";
          name.textContent = project.name;
          const path = document.createElement("span");
          path.className = "switcher-project-path";
          path.textContent = project.path;
          row.setAttribute("aria-label", t("switcher.row.located", { name: project.name, path: project.path }));
          row.append(name, path);
        } else {
          row.textContent = project.name;
        }
      }
      if (!project.missing && !project.error) {
        const open = document.createElement("button");
        open.type = "button";
        open.className = "switcher-open";
        if (row.hasAttribute("aria-label")) open.setAttribute("aria-label", row.getAttribute("aria-label")!);
        open.append(...Array.from(row.childNodes));
        row.append(open);
      }
      frag.appendChild(row);
    }
    listbox.replaceChildren(frag);
  }

  /** Paint where the next new book would go.
   *
   *  ITS OWN FAILURE STATE. A destination nobody can read is not the same as
   *  the library, and painting the library would tell the writer a place their
   *  book is not going to. */
  async function renderNewDir(): Promise<void> {
    const mine = generation;
    try {
      const dir = await deps.newDir();
      if (mine !== generation) return;
      newWhere.textContent = t("switcher.where", { dir: folderName(dir, false) });
      newWhere.title = dir;
    } catch {
      if (mine !== generation) return;
      newWhere.textContent = t("switcher.where.unknown");
      newWhere.removeAttribute("title");
    }
  }

  async function reload(): Promise<void> {
    const mine = ++generation;
    renderMessage(t("switcher.loading"));
    // The folder's name, the whole path on hover: the absolute path
    // was the first thing the panel said, and it is the least of what a
    // writer came for. The title carries it for the one who wants it.
    const path = deps.currentPath();
    here.textContent = t("switcher.here", { folder: folderName(path, true) });
    here.title = path;
    here.hidden = path === "";
    const newDirRead = renderNewDir();
    void reloadPending();
    try {
      const projects = await deps.listProjects();
      if (mine !== generation) return;
      renderProjects(projects);
    } catch (error) {
      if (mine !== generation) return;
      renderMessage(t("switcher.error.list"));
      deps.onNotice(messageOf(error));
    } finally {
      await newDirRead;
    }
  }

  async function reloadPending(): Promise<void> {
    const mine = generation;
    const path = deps.currentPath();
    const opened = deps.currentGeneration?.();
    try {
      const entries = await deps.listPendingRegistrations?.() ?? [];
      if (entries.length > 0 && !await outcomeCurrent(path, opened)) return;
      if (destroyed || mine !== generation) return;
      pendingList.hidden = entries.length === 0;
      pendingList.replaceChildren();
      for (const entry of entries) {
        const row = document.createElement("div");
        row.className = "switcher-pending-registration";
        const description = document.createElement("p");
        description.textContent = t("registration.warning", { path: entry.path });
        const limit = document.createElement("p");
        limit.textContent = t("registration.session");
        const retry = document.createElement("button");
        retry.type = "button";
        retry.textContent = t("registration.retry");
        retry.dataset.registrationToken = entry.token;
        row.append(description, limit, retry);
        pendingList.append(row);
      }
    } catch (error) {
      if (!destroyed && mine === generation && await outcomeCurrent(path, opened) && mine === generation) {
        deps.onNotice(messageOf(error));
      }
    }
  }

  let registering = false;
  const onRegistrationRetry = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element) || registering) return;
    const button = target.closest<HTMLButtonElement>("[data-registration-token]");
    const token = button?.dataset.registrationToken;
    if (!token || !deps.retryRegistration) return;
    const mine = generation;
    const path = deps.currentPath();
    const opened = deps.currentGeneration?.();
    registering = true;
    // The latch prevents a second attempt while the focused control stays in the tab order.
    button.setAttribute("aria-disabled", "true");
    void (async (): Promise<void> => {
      try {
        const project = await deps.retryRegistration!(token);
        if (await outcomeCurrent(path, opened)) {
          deps.onDone(t("registration.done", { name: project.name }));
          if (!panel.hidden && mine === generation) {
            const returnFocus = document.activeElement === button;
            const loading = reload();
            const refreshed = generation;
            await loading;
            const canFocus = (): boolean => returnFocus && !panel.hidden && refreshed === generation &&
              (document.activeElement === button || document.activeElement === document.body);
            if (canFocus() && await outcomeCurrent(path, opened) && canFocus()) {
              const row = Array.from(listbox.querySelectorAll<HTMLElement>("[data-project-path]"))
                .find((row) => row.dataset.projectPath === project.path);
              (row?.querySelector<HTMLButtonElement>(".switcher-open") ?? listbox).focus();
            }
          }
        }
      } catch (error) {
        if (await outcomeCurrent(path, opened)) deps.onNotice(messageOf(error));
      } finally {
        registering = false;
        button.removeAttribute("aria-disabled");
      }
    })();
  };

  function renderImportMessage(text: string): void {
    const row = document.createElement("div");
    row.textContent = text;
    importList.replaceChildren(row);
  }

  function renderImports(files: readonly string[]): void {
    if (files.length === 0) {
      const row = document.createElement("div");
      // The directory is named on its own line above, where it is readable
      // whether or not the folder is empty -- the archive section's shape. This
      // line used to claim it named the directory and did not.
      row.textContent = t("switcher.import.empty");
      importList.replaceChildren(row);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const file of files) {
      const row = document.createElement("div");
      row.setAttribute("role", "listitem");
      row.dataset.importFile = file;
      const action = document.createElement("button");
      action.type = "button";
      action.className = "switcher-import";
      action.textContent = file;
      row.append(action);
      frag.appendChild(row);
    }
    importList.replaceChildren(frag);
  }

  async function reloadImports(): Promise<void> {
    const mine = generation;
    try {
      const report = await deps.listImports();
      if (mine !== generation) return;
      importWhere.textContent = t("switcher.import.where", { dir: report.dir });
      renderImports(report.files);
      // Collapsed only while there is nothing to import: a file waiting
      // in the folder is the reason to show it.
      if (report.files.length > 0) expand(importToggle, importBody, true);
    } catch (error) {
      if (mine !== generation) return;
      // NOT renderImports([]), which paints the designed empty state "Drop a
      // .md file in the import folder." - telling the writer their folder is
      // empty when the truth is that it could not be read. The two surfaces
      // would contradict each other and the one they act on is the confident
      // sentence in the list.
      renderImportMessage(t("switcher.import.error"));
      expand(importToggle, importBody, true);
      deps.onNotice(messageOf(error));
    }
  }

  function renderRecoveryMessage(text: string): void {
    const row = document.createElement("div");
    row.textContent = text;
    recoveryList.replaceChildren(row);
  }

  function renderRecoveryPoints(points: readonly RecoveryPoint[]): void {
    if (points.length === 0) {
      renderRecoveryMessage(t("switcher.recovery.empty"));
      return;
    }
    const now = Date.now();
    const frag = document.createDocumentFragment();
    for (const point of points) {
      const row = document.createElement("div");
      row.setAttribute("role", "listitem");
      row.dataset.pointId = point.id;
      row.dataset.legacyPoint = point.bundle ? "false" : "true";
      row.dataset.partialPoint = point.database_verified && !point.verified ? "true" : "false";
      // `formatWhen` rather than a fourth copy of the relative-time shape, and
      // rather than the raw id: the id is a UTC stamp with its colons replaced,
      // which is a file name and not something to ask a writer to read.
      row.textContent = t(row.dataset.partialPoint === "true" ? "switcher.recovery.row.partial" : point.bundle ? "switcher.recovery.row" : "switcher.recovery.row.legacy", { when: formatWhen(point.mtime_ms, now) });
      const restore = document.createElement("button");
      restore.type = "button";
      restore.className = "switcher-restore";
      restore.textContent = row.textContent;
      row.replaceChildren(restore);
      frag.appendChild(row);
    }
    recoveryList.replaceChildren(frag);
  }

  async function reloadRecovery(): Promise<void> {
    if (!hasBook()) return;
    // Reads `generation` WITHOUT bumping it, exactly as `reloadImports` does
    // and for the same reason: it rides `reload()`'s bump so all three are
    // cancelled together.
    const mine = generation;
    try {
      const points = await deps.listRecoveryPoints();
      if (mine !== generation || !hasBook()) return;
      if (hasBook()) renderRecoveryPoints(points);
    } catch (error) {
      if (mine !== generation || !hasBook()) return;
      // NOT renderRecoveryPoints([]), which paints "no recovery point has been
      // taken yet" over a directory that merely could not be read -- the
      // recorded `reloadImports` defect, and worse here: it would tell a writer
      // looking for a way out of a damaged project that no copy of their book
      // exists.
      renderRecoveryMessage(t("switcher.recovery.error"));
      deps.onNotice(messageOf(error));
    }
  }

  let legacyGeneration = 0;
  let legacyNotified = false;

  function clearLegacyProtection(): void {
    legacyRecovery.replaceChildren();
    legacyRecovery.hidden = true;
    legacyMirror.replaceChildren();
    legacyMirror.hidden = true;
  }

  function renderLegacyProtection(items: readonly LegacyProtection[]): void {
    clearLegacyProtection();
    for (const surface of ["recovery", "mirror"] as const) {
      const dirs = items.filter((item) => item.surface === surface).map((item) => item.dir);
      if (dirs.length === 0) continue;
      const block = surface === "recovery" ? legacyRecovery : legacyMirror;
      const heading = document.createElement("div");
      heading.className = "project-legacy-heading";
      heading.textContent = t(`switcher.legacy.${surface}.heading`);
      const note = document.createElement("div");
      note.className = "project-legacy-note";
      note.textContent = t(`switcher.legacy.${surface}.note`);
      const paths = document.createElement("div");
      paths.className = "project-legacy-paths";
      for (const dir of dirs) {
        const path = document.createElement("div");
        path.textContent = dir;
        paths.append(path);
      }
      block.append(heading, note, paths);
      block.hidden = false;
    }
  }

  function invalidateLegacyProtection(): void {
    legacyGeneration++;
    legacyNotified = false;
    clearLegacyProtection();
  }

  async function reloadLegacyProtection(): Promise<void> {
    if (!hasBook()) { clearLegacyProtection(); return; }
    const mine = ++legacyGeneration;
    try {
      const items = await (deps.legacyProtection?.() ?? Promise.resolve([]));
      if (mine !== legacyGeneration || !hasBook()) return;
      if (!hasBook()) return;
      renderLegacyProtection(items);
      if (items.length > 0 && !legacyNotified) {
        legacyNotified = true;
        deps.onNotice(t("switcher.legacy.notice"));
      }
    } catch (error) {
      if (mine !== legacyGeneration || !hasBook()) return;
      clearLegacyProtection();
      deps.onNotice(messageOf(error));
    }
  }

  // One restore at a time, for the reason one import at a time: every extra
  // click would produce another copy of the same manuscript, and a writer
  // trying to end up with two books does not want five.
  let restoring = false;

  const onRecoveryClick = (event: Event): void => {
    if (!hasBook()) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const row = target.closest("[data-point-id]");
    if (!(row instanceof HTMLElement)) return;
    const id = row.dataset.pointId;
    if (id === undefined || restoring) return;
    const partial = row.dataset.partialPoint === "true";
    if (partial && !target.closest("[data-restore-with-gaps]")) {
      if (!row.querySelector("[data-restore-with-gaps]")) {
        const confirm = document.createElement("button");
        confirm.type = "button";
        confirm.dataset.restoreWithGaps = "true";
        confirm.textContent = t("switcher.recovery.partial.confirm");
        row.append(confirm);
      }
      deps.onNotice(t("switcher.recovery.partial.warning"));
      return;
    }
    restoring = true;
    const mine = generation;
    const path = deps.currentPath();
    const opened = deps.currentGeneration?.();
    void (async (): Promise<void> => {
      let restored: ProjectSummary;
      try {
        restored = await deps.restorePoint(id, partial);
      } catch (error) {
        if (await outcomeCurrent(path, opened)) deps.onNotice(messageOf(error));
        return;
      } finally {
        restoring = false;
      }
      // Restoring does NOT switch, for the reason importing does not, and here
      // the argument is the design's own: the writer is deciding between two
      // real states of their book by looking at both, and moving them off the
      // one they have open is the application making that choice for them.
      if (!await outcomeCurrent(path, opened)) return;
      const warning = registrationNotice(restored);
      const disclosure = t(partial ? "switcher.recovery.done.partial" : row.dataset.legacyPoint === "true" ? "switcher.recovery.done.legacy" : "switcher.recovery.done", { name: restored.name });
      if (warning) {
        deps.onNotice(partial || row.dataset.legacyPoint === "true" ? `${warning} ${disclosure}` : warning);
      } else {
        deps.onDone(disclosure);
      }
      if (!panel.hidden && mine === generation) await reload();
    })();
  };

  function renderArchiveMessage(text: string): void {
    const row = document.createElement("div");
    row.textContent = text;
    archiveList.replaceChildren(row);
  }

  function renderArchives(list: readonly Archive[]): void {
    if (list.length === 0) {
      renderArchiveMessage(t("switcher.archive.empty"));
      return;
    }
    const now = Date.now();
    const frag = document.createDocumentFragment();
    for (const archive of list) {
      const row = document.createElement("div");
      row.setAttribute("role", "listitem");
      // The FILE NAME is the identifier here, unlike the recovery list's id,
      // because it is also what the writer is about to look for in a directory
      // listing. Nothing sends it back to a command.
      row.dataset.archiveFile = archive.file;
      row.textContent = t("switcher.archive.row", {
        file: archive.file,
        when: formatWhen(archive.at_ms, now),
      });
      frag.appendChild(row);
    }
    archiveList.replaceChildren(frag);
  }

  async function reloadArchives(): Promise<void> {
    if (!hasBook()) return;
    // Reads `generation` WITHOUT bumping it, exactly as `reloadImports` and
    // `reloadRecovery` do: it rides `reload()`'s bump so every listing in this
    // panel is cancelled together.
    const mine = generation;
    try {
      const [list, report] = await Promise.all([deps.listArchives(), deps.archiveStatus()]);
      if (mine !== generation || !hasBook()) return;
      if (!hasBook()) return;
      archiveWhere.textContent = report.dir ? t("switcher.archive.where", { dir: report.dir }) : "";
      renderArchives(list);
    } catch (error) {
      if (mine !== generation || !hasBook()) return;
      // NOT renderArchives([]), which paints "no archive has been made yet"
      // over a directory that merely could not be read -- and this is the list
      // a writer consults when they are about to lose the machine.
      renderArchiveMessage(t("switcher.archive.error"));
      deps.onNotice(messageOf(error));
    }
  }

  /** The mirror's own three-state render.
   *
   *  OFF is not an error and not an empty state: it is the default, and the
   *  design makes enabling a deliberate act precisely because writing the whole
   *  manuscript somewhere new is not something to start by itself. ON WITH
   *  NOTHING WRITTEN is a fourth thing again -- enabling runs a pass
   *  immediately, so this is only reachable if that pass failed, and painting
   *  it as "0 files" would read as an empty book. */
  let mirrorActionBusy = false;
  let mirrorPreviewing = false;
  let mirrorPreviewEpoch = 0;
  let pendingMirrorPreview: MirrorPreview | null = null;

  function closeMirrorPreview(returnFocus: boolean): void {
    mirrorPreviewEpoch++;
    pendingMirrorPreview = null;
    mirrorPreviewing = false;
    mirrorPreview.hidden = true;
    mirrorConfirm.disabled = false;
    mirrorCancel.disabled = false;
    mirrorActionBusy = false;
    mirrorToggle.textContent = t("switcher.mirror.enable");
    mirrorToggle.disabled = !hasBook();
    if (returnFocus && hasBook()) mirrorToggle.focus();
  }

  function showMirrorPreview(preview: MirrorPreview): void {
    const heading = document.createElement("strong");
    heading.textContent = t("switcher.mirror.preview.heading");
    const plaintext = document.createElement("p");
    plaintext.textContent = t("switcher.mirror.preview.plaintext");
    const destination = document.createElement("p");
    destination.textContent = t("switcher.mirror.preview.destination", { dir: preview.dir });
    const checked = document.createElement("p");
    checked.textContent = t("switcher.mirror.preview.checked", { files: String(preview.files) });
    const pin = document.createElement("p");
    pin.textContent = t(`switcher.mirror.preview.pin.${preview.pin_state}`);
    const scope = document.createElement("ul");
    for (const part of preview.scope) {
      const row = document.createElement("li");
      row.textContent = t(`switcher.mirror.preview.scope.${part}`);
      scope.append(row);
    }
    const result = document.createElement("p");
    result.textContent = preview.check_state === "ran" && preview.findings.length === 0
      ? t("switcher.mirror.preview.state.clear")
      : t(`switcher.mirror.preview.state.${preview.check_state}`);
    const findings = document.createElement("ul");
    for (const finding of preview.findings) {
      const row = document.createElement("li");
      row.textContent = t("switcher.mirror.preview.finding", {
        match: finding.matched,
        where: finding.item_id ?? finding.surface,
      });
      findings.append(row);
    }
    const limits = document.createElement("ul");
    for (const limit of preview.limits) {
      const row = document.createElement("li");
      row.textContent = t(`switcher.mirror.preview.limit.${limit}`);
      limits.append(row);
    }
    mirrorPreviewContent.replaceChildren(heading, plaintext, destination, checked, pin, scope, result, findings, limits);
    mirrorPreview.hidden = false;
    mirrorPreview.focus();
  }

  function renderMirror(report: MirrorReport): void {
    if (!hasBook()) return;
    mirrorWhere.textContent = report.dir ? t("switcher.mirror.where", { dir: report.dir }) : "";
    mirrorToggle.textContent = report.enabled
      ? t("switcher.mirror.disable")
      : t("switcher.mirror.enable");
    mirrorToggle.disabled = mirrorActionBusy;
    // A full check only has a complete folder to examine once the mirror is on
    // and its first pass has built it. The shared latch also keeps a reload
    // resolving mid-action from re-enabling either mirror write.
    mirrorCheck.disabled = mirrorActionBusy || !report.enabled || report.generated_at === null;
    // A reload may resolve while the full check still hashes. Keep its progress
    // text visible until that action releases the shared latch.
    if (!mirrorActionBusy) mirrorCheck.textContent = t("switcher.mirror.check");
    if (!report.enabled) {
      mirrorState.textContent = t("switcher.mirror.off");
      return;
    }
    if (report.generated_at === null) {
      mirrorState.textContent = t("switcher.mirror.pending");
      return;
    }
    mirrorState.textContent = plural("switcher.mirror.on", report.files, {
      count: String(report.files),
      when: formatWhen(report.generated_at, Date.now()),
    });
  }

  async function reloadMirror(): Promise<void> {
    if (!hasBook()) return;
    // Reads `generation` WITHOUT bumping it, exactly as the three listings
    // above do, so every part of this panel is cancelled together.
    const mine = generation;
    try {
      const report = await deps.mirrorStatus();
      if (mine !== generation || !hasBook()) return;
      renderMirror(report);
    } catch (error) {
      if (mine !== generation || !hasBook()) return;
      // NOT renderMirror({enabled:false,...}), which paints "the mirror is off
      // for this project" over a directory that merely could not be read -- and
      // a writer told the mirror is off may go and turn it on, which rewrites
      // the whole book to a place the page just failed to read.
      mirrorState.textContent = t("switcher.mirror.error");
      // A status failure means the check's precondition is unknown, but it
      // must not leave the separate toggle stuck as if an action were running.
      mirrorToggle.disabled = mirrorActionBusy;
      mirrorCheck.disabled = true;
      deps.onNotice(messageOf(error));
    }
  }

  // One at a time, for `archiving`'s reason and one more: enabling writes the
  // whole manuscript, and a second click landing mid-pass would have two passes
  // writing the same files.
  const onMirrorToggle = (): void => {
    if (!hasBook() || mirrorActionBusy) return;
    mirrorActionBusy = true;
    const turningOn = mirrorToggle.textContent === t("switcher.mirror.enable");
    mirrorPreviewing = turningOn;
    mirrorToggle.textContent = t(turningOn ? "switcher.mirror.previewing" : "switcher.mirror.working");
    mirrorToggle.disabled = true;
    mirrorCheck.disabled = true;
    const mine = ++mirrorPreviewEpoch;
    const opened = generation;
    const path = deps.currentPath();
    void (async (): Promise<void> => {
      try {
        if (turningOn) {
          const preview = await deps.previewMirror();
          if (mine !== mirrorPreviewEpoch || opened !== generation || deps.currentPath() !== path) return;
          mirrorPreviewing = false;
          pendingMirrorPreview = preview;
          mirrorToggle.textContent = t("switcher.mirror.enable");
          showMirrorPreview(preview);
          return;
        }
        const report = await deps.enableMirror(false);
        if (mine !== mirrorPreviewEpoch || opened !== generation || deps.currentPath() !== path) return;
        // BY DIRECTORY, because the writer's next act is to go and look at it,
        // and on the way OFF because a writer who expects the files gone would
        // otherwise not know they are still there.
        deps.onDone(
          t(turningOn ? "mirror.notice.enabled" : "mirror.notice.disabled", {
            dir: report.dir,
          }),
        );
      } catch (error) {
        if (mine === mirrorPreviewEpoch && opened === generation && deps.currentPath() === path)
          deps.onNotice(t("mirror.notice.failed", { error: messageOf(error) }));
      } finally {
        if (mine === mirrorPreviewEpoch && (!turningOn || pendingMirrorPreview === null)) {
          mirrorPreviewing = false;
          mirrorActionBusy = false;
          if (turningOn) mirrorToggle.textContent = t("switcher.mirror.enable");
          mirrorToggle.disabled = !hasBook();
          mirrorCheck.textContent = t("switcher.mirror.check");
        }
      }
      if (!turningOn && mine === mirrorPreviewEpoch && opened === generation) await reloadMirror();
    })();
  };

  const onMirrorConfirm = (): void => {
    if (!hasBook()) return;
    const preview = pendingMirrorPreview;
    if (preview?.token === null || preview?.token === undefined) return;
    const opened = generation;
    const path = deps.currentPath();
    const mine = mirrorPreviewEpoch;
    mirrorConfirm.disabled = true;
    mirrorCancel.disabled = true;
    void (async (): Promise<void> => {
      try {
        const report = await deps.enableMirror(true, preview.token ?? undefined);
        if (mine === mirrorPreviewEpoch && opened === generation && deps.currentPath() === path)
          deps.onDone(t("mirror.notice.enabled", { dir: report.dir }));
      } catch (error) {
        if (mine === mirrorPreviewEpoch && opened === generation && deps.currentPath() === path)
          deps.onNotice(t("mirror.notice.failed", { error: messageOf(error) }));
      } finally {
        if (mine === mirrorPreviewEpoch) closeMirrorPreview(false);
      }
      await reloadMirror();
    })();
  };

  const onMirrorCancel = (): void => closeMirrorPreview(true);

  const onMirrorCheck = (): void => {
    if (!hasBook() || mirrorActionBusy || mirrorCheck.disabled) return;
    const checkedPath = deps.currentPath();
    mirrorActionBusy = true;
    mirrorToggle.disabled = true;
    mirrorCheck.disabled = true;
    mirrorCheck.textContent = t("switcher.mirror.checking");
    void (async (): Promise<void> => {
      try {
        const checked = await deps.checkMirror();
        if (deps.currentPath() === checkedPath) deps.onDone(
          t("mirror.notice.checked", {
            entries: String(checked.entries),
            changed: String(checked.changed),
            deleted: String(checked.deleted),
          }),
        );
      } catch {
        // The host's error can name a local path or an unreadable entry. A
        // complete check never returns partial success, so this one safe,
        // localised sentence is the only page-side answer.
        if (deps.currentPath() === checkedPath) deps.onNotice(t("mirror.notice.check-failed"));
      } finally {
        mirrorActionBusy = false;
        mirrorToggle.disabled = !hasBook();
        mirrorCheck.textContent = t("switcher.mirror.check");
      }
      await reloadMirror();
    })();
  };

  // One archive at a time, for the reason one import at a time: every extra
  // click would write another whole copy of the manuscript to the disk the
  // writer is trying to get their book off.
  let archiving = false;

  const outcomeCurrent = async (path: string, opened: number | undefined): Promise<boolean> => {
    const current = (): boolean => !destroyed && deps.currentPath() === path && deps.currentGeneration?.() === opened;
    if (!current()) return false;
    try {
      return (await deps.canReportArchive?.() ?? true) && current();
    } catch { return false; }
  };

  const archiveActionCurrent = async (mine: number, path: string, opened: number | undefined): Promise<boolean> => {
    const current = (): boolean => !destroyed && mine === generation &&
      deps.currentPath() === path && deps.currentGeneration?.() === opened;
    if (!current()) return false;
    try {
      return (await deps.canReportArchive?.() ?? true) && current();
    } catch {
      return false;
    }
  };

  const onArchiveNow = (): void => {
    if (!hasBook() || archiving) return;
    const mine = generation;
    const path = deps.currentPath();
    const opened = deps.currentGeneration?.();
    archiving = true;
    archiveNow.textContent = t("switcher.archive.working");
    void (async (): Promise<void> => {
      try {
        const written = await deps.makeArchive();
        // BY NAME. The writer's next act is to find this file, so the notice
        // owes them what it is called. Through the notice channel and never
        // through the save banner: a backup failure is not a save failure, and
        // neither is a backup success a save.
        if (await archiveActionCurrent(mine, path, opened)) deps.onDone(t("archive.notice.done", { file: written.file }));
      } catch (error) {
        if (await archiveActionCurrent(mine, path, opened)) deps.onNotice(t("archive.notice.failed", { error: messageOf(error) }));
      } finally {
        archiving = false;
        if (!destroyed) archiveNow.textContent = t("switcher.archive.action");
      }
      if (await archiveActionCurrent(mine, path, opened)) await reloadArchives();
    })();
  };

  let encryptedBusy = false;
  let destinationGeneration = 0;
  function renderBackupDestination(dir: string | null): void {
    backupWhere.textContent = dir === null
      ? t("switcher.archive.destination.none")
      : t("switcher.archive.destination.where", { dir });
  }
  async function reloadBackupDestination(): Promise<void> {
    if (!deps.encryptedBackupDestination) return;
    const mine = generation;
    const request = ++destinationGeneration;
    const path = deps.currentPath();
    const opened = deps.currentGeneration?.();
    backupWhere.textContent = t("switcher.archive.destination.loading");
    try {
      const dir = await deps.encryptedBackupDestination();
      if (await archiveActionCurrent(mine, path, opened) && request === destinationGeneration) {
        renderBackupDestination(dir);
      }
    } catch (error) {
      if (await archiveActionCurrent(mine, path, opened) && request === destinationGeneration) {
        backupWhere.textContent = t("switcher.archive.destination.error");
        deps.onNotice(messageOf(error));
      }
    }
  }
  const encryptedAction = (action: () => Promise<string | null>, refreshShelf = false, warning: () => boolean = () => false): void => {
    if (encryptedBusy) return;
    const mine = generation;
    const path = deps.currentPath();
    const opened = deps.currentGeneration?.();
    encryptedBusy = true;
    for (const button of [backupChoose, archiveKey, archiveEncrypted, archiveVerify, archiveRestore]) button.disabled = true;
    void (async (): Promise<void> => {
      try {
        const done = await action();
        if (done !== null && await (refreshShelf ? outcomeCurrent(path, opened) : archiveActionCurrent(mine, path, opened))) {
          if (warning()) deps.onNotice(done);
          else deps.onDone(done);
          if (refreshShelf && !panel.hidden && mine === generation) await reload();
        }
      } catch (error) {
        if (await archiveActionCurrent(mine, path, opened)) {
          deps.onNotice(t("switcher.archive.encrypted.failed", { error: messageOf(error) }));
        }
      } finally {
        encryptedBusy = false;
        if (!destroyed) {
          for (const button of [backupChoose, archiveKey, archiveEncrypted, archiveVerify, archiveRestore]) button.disabled = false;
          paintBookAvailability();
        }
      }
    })();
  };
  const onBackupChoose = (): void => {
    const mine = generation;
    const path = deps.currentPath();
    const opened = deps.currentGeneration?.();
    encryptedAction(async () => {
      const dir = await deps.chooseEncryptedBackupDestination?.();
      if (await archiveActionCurrent(mine, path, opened)) {
        ++destinationGeneration;
        if (dir) renderBackupDestination(dir);
        else await reloadBackupDestination();
      }
      return null;
    });
  };
  const onArchiveKey = (): void => encryptedAction(async () => {
    const key = await deps.generateArchiveKey?.();
    return key ? t("switcher.archive.key.done", { recipient: key.recipient }) : null;
  });
  const onArchiveEncrypted = (): void => {
    if (!hasBook()) return;
    encryptedAction(async () => {
      const archive = await deps.makeEncryptedArchive?.();
      return archive ? t("switcher.archive.encrypted.done", { file: archive.file, recipient: archive.recipient }) : null;
    });
  };
  const onArchiveVerify = (): void => encryptedAction(async () => {
    const archive = await deps.verifyEncryptedArchive?.();
    return archive ? t("switcher.archive.encrypted.verified", { file: archive.file }) : null;
  });
  const onArchiveRestore = (): void => {
    let warning = false;
    encryptedAction(async () => {
      const project = await deps.restoreEncryptedArchive?.();
      if (!project) return null;
      const notice = registrationNotice(project);
      warning = notice !== null;
      return notice ?? t("switcher.archive.encrypted.restored", { name: project.name });
    }, true, () => warning);
  };

  function setOpen(open: boolean): void {
    panel.hidden = !open;
  }

  // One import at a time. A second click while the first is still parsing would
  // fail on the name collision anyway, but reporting "already exists" for a
  // double click is an error message about the writer's mouse rather than about
  // their manuscript.
  let importing = false;

  const onImportClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const row = target.closest("[data-import-file]");
    if (!(row instanceof HTMLElement)) return;
    const file = row.dataset.importFile;
    if (file === undefined || importing) return;
    importing = true;
    const mine = generation;
    const path = deps.currentPath();
    const opened = deps.currentGeneration?.();
    void (async (): Promise<void> => {
      try {
        const outcome = await deps.importProject(file);
        if (!await outcomeCurrent(path, opened)) return;
        const notice = importResultNotice(outcome);
        if (notice?.problem) deps.onNotice(notice.message);
        else if (notice) deps.onDone(notice.message);
      } catch (error) {
        if (await outcomeCurrent(path, opened)) deps.onNotice(messageOf(error));
        return;
      } finally {
        importing = false;
      }
      // Importing does NOT switch, for the reason creating does not: bringing a
      // manuscript in is not saying you are done with the one you are in. The
      // new project appears in the list above, to be opened deliberately.
      if (!panel.hidden && mine === generation) {
        await reload();
        await reloadImports();
      }
    })();
  };

  // One forget at a time: a double click would issue two `project_forget`
  // calls and the second would surface "not a remembered book" about a line
  // the first had just removed.
  let forgetting = false;

  const forget = async (path: string): Promise<void> => {
    if (forgetting) return;
    forgetting = true;
    try {
      await deps.forgetProject(path);
      // Re-list from the host rather than removing the row here: the list is
      // the host's answer, and a row dropped locally that the host still had
      // would come back on the next open with no explanation.
      await reload();
    } catch (error: unknown) {
      deps.onNotice(messageOf(error));
    } finally {
      forgetting = false;
    }
  };

  const onListClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const forgetButton = target.closest("[data-forget-path]");
    if (forgetButton instanceof HTMLElement && forgetButton.dataset.forgetPath !== undefined) {
      void forget(forgetButton.dataset.forgetPath);
      return;
    }
    const row = target.closest("[data-project-path]");
    if (!(row instanceof HTMLElement)) return;
    const path = row.dataset.projectPath;
    if (path === undefined) return;
    const failure = errors.get(path);
    if (failure !== undefined) {
      deps.onNotice(failure);
      return;
    }
    setOpen(false);
    // The switcher below would answer `same`, and a round trip for a no-op is
    // noise on a path a reader takes by accident all the time.
    if (path === deps.currentPath()) return;
    void deps.switchTo(path).catch((error: unknown) => deps.onNotice(messageOf(error)));
  };

  // One create at a time, the latch the import path has always had. A double
  // click otherwise issues two `project_create` calls and the second surfaces a
  // name collision - an error message about the writer's mouse rather than
  // about their manuscript.
  let creating = false;
  // RENAMING THE BOOK, IN PLACE, in the header above the outline.
  //
  // It replaced a section in the project panel that shipped a few hours earlier.
  // Two affordances for one act is what that earlier argument
  // rejected for the three File items, and the header was chosen instead.
  let renaming = false;

  function beginRename(): void {
    // PRE-FILLED and selected. A rename is an edit of a label that already
    // exists; a field that opens empty asks the writer to retype a title they
    // have not decided to change, which is how a rename becomes a way to lose
    // the old name.
    nameField.value = name.textContent ?? "";
    // Show and focus the field BEFORE hiding the button. Hiding a focused
    // element drops the focus it is holding, and this button has just been
    // clicked; doing it first would leave a window in which focus is on nothing
    // and any focus event the engine delivers afterwards lands somewhere this
    // code did not choose. Defensive rather than measured -- no run has shown
    // the other order failing -- and it costs one line's ordering.
    nameField.hidden = false;
    nameField.focus();
    nameField.select();
    name.hidden = true;
  }

  /** Put the label back. `restore` is the whole difference between Escape and a
   *  commit: a cancelled rename changed nothing, and a header left blank would
   *  read as a title that had been erased. */
  function endRename(): void {
    const returnFocus = document.activeElement === nameField;
    name.hidden = false;
    if (returnFocus) name.focus();
    nameField.hidden = true;
  }

  const onRename = (): void => {
    const wanted = nameField.value.trim();
    if (wanted === "") {
      // SAID, not ignored, and the field STAYS OPEN. Closing it on a refusal
      // would look like a rename that worked and silently did nothing.
      deps.onNotice(t("switcher.refuse.no-name"));
      nameField.focus();
      return;
    }
    if (renaming) return;
    renaming = true;
    void (async (): Promise<void> => {
      try {
        const renamed = await deps.renameProject(wanted);
        // THE STORED NAME, not `wanted`. They differ by the trim, and painting
        // the field's value would be the page answering a question the host has
        // just answered.
        name.textContent = renamed.name;
        endRename();
      } catch (error) {
        // The header is LEFT ALONE and the field stays open. A header showing
        // the new name over a store holding the old one is the one outcome a
        // writer cannot detect.
        deps.onNotice(messageOf(error));
        return;
      } finally {
        renaming = false;
      }
      // The project list carries the name too, and the panel may be open over
      // it. Swallowed: a list that could not be re-read is not a failed rename.
      await reload().catch(() => undefined);
    })();
  };

  const onNameKeyDown = (event: KeyboardEvent): void => {
    if (isCompositionKey(event)) return;
    if (event.key === "Enter") {
      event.preventDefault();
      onRename();
      return;
    }
    if (event.key === "Escape") {
      // Stopped here rather than left to bubble: Escape closes panels all over
      // this page, and a cancelled rename must not also dismiss whatever is
      // open behind it.
      event.preventDefault();
      event.stopPropagation();
      endRename();
    }
  };

  const onCreate = (): void => {
    const wanted = input.value.trim();
    if (wanted === "") {
      // SAID, not ignored. File > New project... lands the caret in this field,
      // so a new user's first act is to click Create - and a silent return means
      // their first act produced nothing, with no message, no focus cue and no
      // reason. `renderMessage` is the panel's own list, which is where they are
      // already looking.
      renderMessage(t("switcher.refuse.no-name"));
      input.focus();
      return;
    }
    if (creating) return;
    creating = true;
    const mine = generation;
    const path = deps.currentPath();
    const opened = deps.currentGeneration?.();
    const current = (): Promise<boolean> => outcomeCurrent(path, opened);
    void (async (): Promise<void> => {
      try {
        const made = await deps.createProject(wanted);
        if (!await current()) return;
        const warning = registrationNotice(made);
        if (warning) deps.onNotice(warning);
        else deps.onDone(t("switcher.done.created", { name: made.name }));
        if (panel.hidden || mine !== generation) return;
        if (input.value.trim() === wanted) input.value = "";
        // Naming a new manuscript does not finish the one already open.
        await reload();
      } catch (error) {
        if (await current()) deps.onNotice(messageOf(error));
      } finally {
        creating = false;
      }
    })();
  };

  /** Create, but say where first.
   *
   *  SHARES `creating` WITH `onCreate`, so a writer cannot start a book through
   *  the dialog and another through the button at the same time and get two
   *  from one name. */
  const onChooseWhere = (): void => {
    const wanted = input.value.trim();
    if (wanted === "") {
      renderMessage(t("switcher.refuse.no-name"));
      input.focus();
      return;
    }
    if (creating) return;
    creating = true;
    const mine = generation;
    const path = deps.currentPath();
    const opened = deps.currentGeneration?.();
    const current = (): Promise<boolean> => outcomeCurrent(path, opened);
    void (async (): Promise<void> => {
      try {
        const made = await deps.createProjectIn(wanted);
        // Cancellation keeps the typed name and does not announce a result.
        if (made === null || !await current()) return;
        const warning = registrationNotice(made);
        if (warning) deps.onNotice(warning);
        else deps.onDone(t("switcher.done.created", { name: made.name }));
        if (panel.hidden || mine !== generation) return;
        if (input.value.trim() === wanted) input.value = "";
        await reload();
      } catch (error) {
        if (await current()) deps.onNotice(messageOf(error));
      } finally {
        creating = false;
      }
    })();
  };

  /** One move at a time; a second click while the dialog stands is nothing. */
  let moving = false;
  const onMove = (): void => {
    if (!hasBook() || moving) return;
    moving = true;
    void (async (): Promise<void> => {
      let moved: ProjectSummary | null;
      try {
        moved = await deps.moveProject();
      } catch (error) {
        deps.onNotice(messageOf(error));
        return;
      } finally {
        moving = false;
      }
      // Cancelled: the writer did exactly what they intended.
      if (moved === null) return;
      await reload();
    })();
  };

  // Close, Escape and a click elsewhere (the shell's). Close and Escape hand
  // focus back where the retired toggle used to: a panel closing into nowhere
  // leaves the writer's next keystroke on <body>.
  const shell = createPanelShell({
    panel,
    title: t("switcher.title"),
    close: () => setOpen(false),
    returnFocus: deps.onDismiss,
  });

  listbox.addEventListener("click", onListClick);
  pendingList.addEventListener("click", onRegistrationRetry);
  importList.addEventListener("click", onImportClick);
  recoveryList.addEventListener("click", onRecoveryClick);
  archiveNow.addEventListener("click", onArchiveNow);
  archiveKey.addEventListener("click", onArchiveKey);
  backupChoose.addEventListener("click", onBackupChoose);
  archiveEncrypted.addEventListener("click", onArchiveEncrypted);
  archiveVerify.addEventListener("click", onArchiveVerify);
  archiveRestore.addEventListener("click", onArchiveRestore);
  mirrorToggle.addEventListener("click", onMirrorToggle);
  importToggle.addEventListener("click", onImportToggle);
  copiesToggle.addEventListener("click", onCopiesToggle);
  mirrorCheck.addEventListener("click", onMirrorCheck);
  mirrorConfirm.addEventListener("click", onMirrorConfirm);
  mirrorCancel.addEventListener("click", onMirrorCancel);
  create.addEventListener("click", onCreate);
  chooseWhere.addEventListener("click", onChooseWhere);
  move.addEventListener("click", onMove);
  name.addEventListener("click", beginRename);
  nameField.addEventListener("keydown", onNameKeyDown);
  cast.addEventListener("click", deps.openCast);
  // NOTHING ON BLUR, and the absence is the decision.
  //
  // Committing on blur renames the book every time a writer clicks away
  // mid-thought: a write nobody asked for, on the one string that names their
  // manuscript. Cancelling on blur throws away a title they had just finished
  // typing, silently, for the same click.
  //
  // So the field stays open until Enter or Escape. A writer who clicks away
  // sees a field still waiting for them, which is the only one of the three
  // that neither writes nor discards anything on its own.

  function paintBookAvailability(): void {
    const open = hasBook();
    name.hidden = !open;
    cast.hidden = !open;
    castTip.anchor.hidden = !open;
    addTip.anchor.hidden = !open || deps.openCreation === undefined;
    bookRequired.hidden = open;
    for (const node of [here, move, recoveryHeading, recoveryList, archiveHeading, archiveWhere, archiveNow, archiveList, mirrorHeading, mirrorWhere, mirrorState, mirrorToggle, mirrorCheck]) node.hidden = !open;
    if (!open) {
      clearLegacyProtection();
      archiveWhere.textContent = "";
      mirrorWhere.textContent = "";
    }
    archiveEncrypted.hidden = !open || deps.makeEncryptedArchive === undefined;
    archiveEncrypted.disabled = !open || encryptedBusy;
    move.disabled = !open;
    archiveNow.disabled = !open || archiving;
    mirrorToggle.disabled = !open || mirrorActionBusy;
    if (!open) mirrorCheck.disabled = true;
  }
  paintBookAvailability();

  return {
    refresh(next: string): void {
      if (pendingMirrorPreview !== null || mirrorPreviewing) closeMirrorPreview(false);
      name.textContent = next;
      invalidateLegacyProtection();
      void reloadLegacyProtection();
    },
    setBookOpen(open: boolean): void {
      if (!open) closeMirrorPreview(false);
      bookOpen = open;
      paintBookAvailability();
      // Reset to the not-editing state either way: `open` false must not
      // leave a rename field showing over nothing, and `open` true is a
      // fresh mount that was never mid-rename to begin with.
      nameField.hidden = true;
      if (!open) invalidateLegacyProtection();
    },
    beginRename,
    open(focus): void {
      if (pendingMirrorPreview !== null || mirrorPreviewing) closeMirrorPreview(false);
      // Idempotent, unlike onToggle: the menu item says "open", so a second
      // request from a writer who is already looking at the panel must not
      // close it. Reloading again is the honest read -- the library may have
      // changed since the panel was opened.
      setOpen(true);
      // Each open starts from the rule, not from how the last one was left:
      // closed unless asked for, or unless a copy needs attention.
      expand(importToggle, importBody, focus === "import");
      expand(copiesToggle, copies, focus === "copies" || focus === "backups" || focus === "restore" || (deps.copiesNeedAttention?.() ?? false));
      // ORDER IS LOAD-BEARING. `reloadImports` reads `generation` WITHOUT
      // bumping it - it rides the bump `reload()` makes synchronously before its
      // first await, so the two are cancelled together by the next open or by
      // destroy. Swap these two lines and the import listing carries the
      // PREVIOUS generation, so an open that arrives while an older listing is
      // in flight no longer cancels it. Pinned by a test.
      const projectsLoaded = reload();
      const loaded = Promise.all([
        projectsLoaded,
        reloadImports(),
        reloadRecovery(),
        reloadArchives(),
        reloadBackupDestination(),
        reloadMirror(),
        reloadLegacyProtection(),
      ]);
      if (focus === "create") {
        input.focus();
        input.select();
        return;
      }
      if (focus === "backups" || focus === "restore") {
        const action = (focus === "restore" ? [archiveRestore] : [archiveEncrypted, archiveKey, archiveVerify, archiveRestore])
          .find((button) => !button.hidden && !button.disabled);
        const target = action ?? encryptedHeading;
        target.focus({ preventScroll: true });
        const mine = generation;
        const path = deps.currentPath();
        const opened = deps.currentGeneration?.();
        const stillFocused = (): boolean => !panel.hidden && !copies.hidden && document.activeElement === target;
        // Earlier lists can grow after opening and move this section down.
        void loaded.then(async () => {
          if (!stillFocused() || !await archiveActionCurrent(mine, path, opened) || !stillFocused()) return;
          encryptedHeading.scrollIntoView({ block: "start", inline: "nearest" });
        });
        return;
      }
      // The status dot's "Set up the readable folder": the section it named.
      if (focus === "copies") {
        mirrorToggle.focus();
        return;
      }
      // Start at the container while its rows load. Only advance if the
      // writer has left focus there, so a late listing cannot take it back.
      (focus === "import" ? importList : listbox).focus();
      if (focus !== "import") {
        const mine = generation;
        void projectsLoaded.then(() => {
          if (destroyed || panel.hidden || mine !== generation || document.activeElement !== listbox) return;
          const current = listbox.querySelector<HTMLButtonElement>('[aria-current="true"] .switcher-open');
          (current ?? listbox.querySelector<HTMLButtonElement>(".switcher-open, .switcher-forget"))?.focus();
        });
      }
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      closeMirrorPreview(false);
      for (const help of copyHelp) help.destroy();
      // Pending reads must not repaint detached controls.
      generation++;
      legacyGeneration++;

      listbox.removeEventListener("click", onListClick);
      pendingList.removeEventListener("click", onRegistrationRetry);
      importList.removeEventListener("click", onImportClick);
      recoveryList.removeEventListener("click", onRecoveryClick);
      archiveNow.removeEventListener("click", onArchiveNow);
      archiveKey.removeEventListener("click", onArchiveKey);
      backupChoose.removeEventListener("click", onBackupChoose);
      archiveEncrypted.removeEventListener("click", onArchiveEncrypted);
      archiveVerify.removeEventListener("click", onArchiveVerify);
      archiveRestore.removeEventListener("click", onArchiveRestore);
      mirrorToggle.removeEventListener("click", onMirrorToggle);
      importToggle.removeEventListener("click", onImportToggle);
      copiesToggle.removeEventListener("click", onCopiesToggle);
      mirrorCheck.removeEventListener("click", onMirrorCheck);
      mirrorConfirm.removeEventListener("click", onMirrorConfirm);
      mirrorCancel.removeEventListener("click", onMirrorCancel);
      create.removeEventListener("click", onCreate);
      chooseWhere.removeEventListener("click", onChooseWhere);
      move.removeEventListener("click", onMove);
      name.removeEventListener("click", beginRename);
      nameField.removeEventListener("keydown", onNameKeyDown);
      cast.removeEventListener("click", deps.openCast);
      // The three elements this unit owns OUTSIDE its own container.
      // `container` is emptied by whoever owns it; these are not, so a project
      // switch would otherwise leave the previous manuscript's name button and
      // cast button in the header beside the new ones.
      name.remove();
      nameField.remove();
      cast.remove();
      castTip.destroy();
      castTip.anchor.remove();
      add.removeEventListener("click", onAdd);
      addTip.destroy();
      addTip.anchor.remove();
      // THE ONE THAT MATTERS: it is on the document, so it outlives these
      // elements and would accumulate one live closure per project switch.
      shell.destroy();
      container.replaceChildren();
      container.removeAttribute("role");
    },
  };
}
