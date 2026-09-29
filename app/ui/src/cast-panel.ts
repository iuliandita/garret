// app/ui/src/cast-panel.ts
// The characters, the places and the points of interest a book is about, and
// everything the writer wants to remember about each.
//
// A PANEL, NOT A NAVIGATOR SECTION: the guess that the second-root work had
// already paid for a section is wrong. The navigator is a virtual
// list over the STORE'S ITEM WALK: `storeSourceFrom` takes `ProjectItem[]` and
// every row it paints needs an id, a parent_id, a type, a position, a rev and a
// depth. A cast member has none of them, so a cast row in that list would have
// to be a SYNTHESISED item — and the moment one exists, `selectedId`,
// `activate`, `openableIds`, nav history, quick open, `planPlacement` and the
// statistics rollup all have to learn to skip it. That is precisely the third
// exclusion the decision to give the cast its own table exists to avoid.
//
// IT HANGS OFF #project-bar exactly as #synopsis-panel, #state-panel and
// #stats-panel do, so the bar's 39px — a click-geometry constant restated in
// five rigs — is untouched and nothing below the bar moves.
//
// THE LIST AND THE FORM ARE ONE SURFACE, which is the difference from the
// synopsis panel and the whole reason for the drafts below. The synopsis panel
// captures ONE row at open and never re-reads, because the selection it is about
// lives behind it in the navigator. Here the selection lives INSIDE the panel:
// moving between entries is how the panel is used, so it must not be how work is
// lost. Every entry keeps its unsaved form as a draft for the life of the panel,
// across closes included: dismissing by accident must not be how work is lost
// either.
//
// IT DECIDES NOTHING ABOUT THE STORE. It does not know that a blank-on-both-
// sides field row is dropped, that a name is trimmed, or that a cast member is
// invisible to the word count. The store owns all three; two places deciding one
// thing is how they drift. What it DOES decide is that a press of Add with no
// name is answered with a sentence rather than with silence — the recorded pair
// of `Edit > Replace…` and the project panel's Create, whose first use was a
// writer pressing a button and watching nothing happen.
import { isCompositionKey } from "./composition-key";
import { HostCommandError } from "./command-error";
import { t } from "./i18n";
import { createPanelShell } from "./panel-shell";
import { CAST_KINDS, groupKeyFor, kindIconFor, kindKeyFor } from "./cast-kinds";
import { createIcon } from "./icons";

export interface CastFieldRow {
  label: string;
  value: string;
}

export interface CastMemberRow {
  id: string;
  /** One of `CAST_KINDS`. Typed as a `string` because it is what the HOST said,
   *  and a newer build's fourth kind must arrive here as data rather than as a
   *  type error. */
  kind: string;
  name: string;
  summary: string;
  fields: CastFieldRow[];
  /** Other names the prose may call this member by (105, "including aliases").
   *  In the order the writer put them, which is the order they were sent. */
  aliases: string[];
  /** The picture's filename in this project's picture directory, or null. The
   *  page NEVER reads it, renders it or sends it: it is here because the host's
   *  record carries it, and what the page acts on is a `PictureView`. */
  picture_path?: string | null;
  deleted_at?: number | null;
}

/** What the host says about one member's picture.
 *
 *  A STATE WORD AND AT MOST A THUMBNAIL. The page never learns a path and never
 *  receives an original: `data_uri` is a `data:` URI of a picture the host has
 *  already bounded at 256 px on its longest side, so the web process holds
 *  kilobytes rather than a decoded photograph. `peak_rss_mb` sums VmRSS over the
 *  whole process tree, webview included, and one 4000x3000 photograph decoded is
 *  about 48 MB of it. */
export interface PictureView {
  /** `none`, `present`, `missing` or `unreadable`. A `string` because it is what
   *  the HOST said: a newer host's fifth word must arrive here as data and fall
   *  through to a sentence, not fail to parse. */
  state: string;
  data_uri: string | null;
}

export interface CastPanelDeps {
  /** The bar anchor from index.html. Positioned absolutely against
   *  #project-bar, so it contributes nothing to the strip's line box. */
  readonly container: HTMLElement;
  list(): Promise<CastMemberRow[]>;
  listDeleted(): Promise<CastMemberRow[]>;
  restore(id: string): Promise<CastMemberRow>;
  create(kind: string, name: string): Promise<CastMemberRow>;
  /** The WHOLE record in one act. The field list REPLACES what the store holds,
   *  so a shorter list is how a detail is deleted. */
  save(
    id: string,
    kind: string,
    name: string,
    summary: string,
    fields: CastFieldRow[],
    aliases: string[],
  ): Promise<CastMemberRow>;
  /** Hide the entry while retaining its complete record and original picture. */
  remove(id: string): Promise<void>;
  /** What to show for this member's picture. Called once per SELECTION, never
   *  once per list: the panel shows a form for ONE entry, so the page holds one
   *  thumbnail and not a book's worth. */
  picture(id: string): Promise<PictureView>;
  /** Open the operating system's picture dialog and attach what the writer
   *  chose. Resolves to the updated member, or to null when they cancelled --
   *  an ANSWER, not a failure, so it raises nothing. */
  pickPicture(id: string): Promise<CastMemberRow | null>;
  /** The same picture at FULL SIZE, for the viewer. There was no way to see
   *  a picture full size; this is that gap closed, and
   *  it is closed once -- the covers panel calls the same host path through its
   *  own side and both hand the answer to one viewer.
   *
   *  It answers the same four states, because the file can go between the
   *  thumbnail read and this one. */
  fullPicture(id: string): Promise<PictureView>;
  /** Show a picture full size. The panel does not OWN the viewer: the covers
   *  panel shows one too, and one viewer is one answer to how big full size is
   *  and one place the memory bound is kept. */
  showFullSize(dataUri: string, label: string): void;
  /** Take the picture off, and its files with it. Permanent, like the member's
   *  own delete, and for the same reason: there is no bin for a file. */
  clearPicture(id: string): Promise<CastMemberRow>;
  /** Good news. Its own channel, never the failure banner: every success in this
   *  application was painted in the alert surface for four slices. */
  onDone(message: string): void;
  onNotice(message: string): void;
  /** Where focus goes when the panel is dismissed with Escape. Not called for an
   *  outside click: a click already says where the writer wants to be. */
  onDismiss(): void;
}

export interface CastPanel {
  /** `focusId` (098, W5): open straight onto that member's sheet, the hover
   *  card's "Open in Cast" route. Absent for the ordinary route (the header
   *  button, the Outline menu), which opens onto whatever the panel last
   *  showed. */
  open(focusId?: string): Promise<void>;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
}

/** What the form holds for one member while the panel is open. */
interface Draft {
  kind: string;
  name: string;
  summary: string;
  fields: CastFieldRow[];
  aliases: string[];
}

function draftOf(member: CastMemberRow): Draft {
  return {
    kind: member.kind,
    name: member.name,
    summary: member.summary,
    fields: member.fields.map((f) => ({ ...f })),
    aliases: [...member.aliases],
  };
}

/** A kind select, built once per call site. The options are the catalog's
 *  words and the values are the wire contract's. */
function kindSelect(id: string, label: string): HTMLSelectElement {
  const select = document.createElement("select");
  select.id = id;
  select.setAttribute("aria-label", label);
  for (const kind of CAST_KINDS) {
    const option = document.createElement("option");
    option.value = kind;
    const key = kindKeyFor(kind);
    // `kindKeyFor` returns null only for a kind this build does not know, and
    // every kind in CAST_KINDS is one it does. Narrowed rather than asserted
    // because the compiler requires it, which is also why no mutation can
    // remove it.
    option.textContent = key === null ? kind : t(key);
    select.append(option);
  }
  return select;
}

/** `cast_set`'s three alias refusals, classified from the HOST'S OWN
 *  DECISION rather than decided again here (105) -- the panel "does not know
 *  that a blank-on-both-sides field row is dropped" (this file's own header)
 *  and this is no exception: `AliasTooShort`/`AliasIsName`/`AliasRepeated`
 *  are all `Store::cast_set`'s to refuse. `commands/cast.rs`'s
 *  `cast_set_wire_error` sends the three as JSON (`{code, alias}`) rather
 *  than as English prose to pattern-match -- a rewrite of the host's
 *  sentence used to silently degrade every refusal to the generic notice
 *  with every test still green, which is what a CODE cannot do. */
const ALIAS_REFUSAL_KEYS: Readonly<Record<string, string>> = {
  alias_too_short: "cast.alias.short",
  alias_is_name: "cast.alias.same-as-name",
  alias_repeated: "cast.alias.repeated",
};

/** `null` for anything that is not one of the three alias refusals: a plain
 *  string that fails to parse, an object with no known `code`, or a real
 *  `Error` from something other than the host (its `String(err)` is
 *  "Error: ...", never valid JSON, and that is the correct outcome here --
 *  falling through to the generic notice rather than guessing). */
function aliasRefusal(err: unknown): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(err instanceof HostCommandError ? err.detail : String(err));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { code, alias } = parsed as { code?: unknown; alias?: unknown };
  if (typeof code !== "string" || typeof alias !== "string") return null;
  const key = ALIAS_REFUSAL_KEYS[code];
  return key === undefined ? null : t(key, { alias });
}

export function createCastPanel(deps: CastPanelDeps): CastPanel {
  const { container } = deps;

  const panel = document.createElement("div");
  panel.id = "cast-panel";
  panel.setAttribute("role", "dialog");
  // Nothing here traps focus and nothing behind it is inert, so claiming modal
  // would be a lie a screen reader acts on.
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-label", t("cast.panel.label"));
  // So Escape is heard even before anything inside takes focus. The recorded
  // failure of the fifth panel is one a writer could not dismiss at all.
  panel.tabIndex = -1;
  panel.hidden = true;
  // READ FIRST, EDIT SECOND (096, W3). `#cast-sheet` and `#cast-detail` are
  // both always in the DOM once a member is selected; this attribute is what
  // CSS keys on to show one and hide the other, so switching modes is never a
  // DOM rebuild -- see the two `[data-mode=...]` rules in style.css.
  panel.dataset.mode = "read";

  /** What the panel is doing, or which entry the form is about. A status rather
   *  than an alert: it is information, not an interruption. */
  const status = document.createElement("div");
  status.id = "cast-status";
  status.setAttribute("role", "status");

  // ---- adding one -------------------------------------------------------
  const newRow = document.createElement("div");
  newRow.id = "cast-new-row";
  const newName = document.createElement("input");
  newName.id = "cast-new-name";
  newName.type = "text";
  newName.placeholder = t("cast.new.name.placeholder");
  newName.setAttribute("aria-label", t("cast.new.name.label"));
  const newKind = kindSelect("cast-new-kind", t("cast.new.kind.label"));
  const newButton = document.createElement("button");
  newButton.id = "cast-new";
  newButton.type = "button";
  newButton.textContent = t("cast.new");
  // DEFAULT, not primary (238): Save is this panel's one filled control, and
  // the add row can be open beside the edit form.
  newRow.append(newName, newKind, newButton);

  // ---- the list ---------------------------------------------------------
  const entries = document.createElement("div");
  entries.id = "cast-entries";
  const deletedToggle = document.createElement("button");
  deletedToggle.id = "cast-deleted-toggle";
  deletedToggle.type = "button";
  deletedToggle.dataset.weight = "quiet";

  // ---- the form ---------------------------------------------------------
  const detail = document.createElement("div");
  detail.id = "cast-detail";
  detail.hidden = true;

  const name = document.createElement("input");
  name.id = "cast-name";
  name.type = "text";
  name.setAttribute("aria-label", t("cast.name.label"));

  // ---- the aliases (105, "including aliases") ----------------------------
  //
  // AFTER THE NAME AND BEFORE THE SUMMARY, deliberately: aliases are names,
  // and the record's order is who this is, then what they are called, then
  // the paragraph. `MIN_CAST_NAME_LENGTH` restates the host's own
  // `cast::MIN_ALIAS_LENGTH` -- the wire contract between the two, and the
  // reason a refusal below quotes the same floor.
  const aliases = document.createElement("div");
  aliases.id = "cast-aliases";

  const kind = kindSelect("cast-kind", t("cast.detail.kind.label"));

  const summary = document.createElement("textarea");
  summary.id = "cast-summary";
  summary.rows = 4;
  summary.placeholder = t("cast.summary.placeholder");
  summary.setAttribute("aria-label", t("cast.summary.label"));

  const fields = document.createElement("div");
  fields.id = "cast-fields";

  const addField = document.createElement("button");
  addField.id = "cast-add-field";
  addField.type = "button";
  addField.textContent = t("cast.add-field");

  // ---- the picture ------------------------------------------------------
  //
  // A BLOCK INSIDE THE FORM, between the detail fields and Save, because it is
  // a fact about the member exactly as the fields are. Its contents are rebuilt
  // per state rather than shown and hidden: an `<img>` with no source is a
  // broken-image glyph in every engine, and a Remove button that is disabled
  // whenever there is nothing to remove is a control a writer has to learn does
  // nothing.
  const picture = document.createElement("div");
  picture.id = "cast-picture-block";

  const pictureState = document.createElement("p");
  pictureState.id = "cast-picture-state";

  const chooseButton = document.createElement("button");
  chooseButton.id = "cast-picture-choose";
  chooseButton.type = "button";
  chooseButton.textContent = t("cast.picture.choose");

  const saveButton = document.createElement("button");
  saveButton.id = "cast-save";
  saveButton.type = "button";
  saveButton.textContent = t("cast.save");
  // The panel's reason for existing, so it is the one filled control on it.
  saveButton.dataset.weight = "primary";

  const removeButton = document.createElement("button");
  removeButton.id = "cast-remove";
  removeButton.type = "button";
  removeButton.textContent = t("cast.remove");
  removeButton.dataset.weight = "danger";

  const cancelButton = document.createElement("button");
  cancelButton.id = "cast-cancel";
  cancelButton.type = "button";
  cancelButton.textContent = t("cast.cancel");
  cancelButton.dataset.weight = "quiet";

  // THE PICTURE SITS BEFORE THE DETAIL LIST, and a capture is what settled it.
  // 037 put NO BOUND on the number of detail fields, deliberately, so anything
  // after that list sits at an unbounded depth -- and the first picture of this
  // panel showed the photograph, Save and Delete all below the fold of a
  // default window, with three fields and a summary above them. The order is
  // the record's own: who this is (name, kind, summary, picture), then the
  // open-ended list of things the writer wants to remember.
  //
  // Save and Delete are still after the list, which is unchanged and is where
  // they belong -- they act on everything above them.
  detail.append(
    name,
    aliases,
    kind,
    summary,
    picture,
    fields,
    addField,
    cancelButton,
    saveButton,
    removeButton,
  );

  // ---- the sheet (096, W3) -----------------------------------------------
  //
  // READ FIRST. Everything above (`detail`) is TODAY'S FORM, unchanged under
  // its own ids -- this is the surface a member opens INTO, and it never asks
  // the writer to fill in a box to remember what they already wrote. It shows
  // exactly what the STORE holds, never a draft: a draft is unsaved typing in
  // a form the writer chose to open, and the sheet is what the panel opens
  // WITH.
  const sheet = document.createElement("div");
  sheet.id = "cast-sheet";

  // NO SECOND EMPTY SENTENCE HERE (096 follow-up). A `#cast-sheet-empty`
  // shipped saying "the add row is below", which is exactly backwards once
  // 096 already opens that row automatically -- `.cast-empty` below (037's
  // sentence, in the LIST) is the one place a bookless writer is told
  // anything, and it already says "above", correctly. `sheetRecord` is still
  // wrapped so it can be shown or hidden as ONE UNIT.
  const sheetRecord = document.createElement("div");
  sheetRecord.id = "cast-sheet-record";

  const sheetHeader = document.createElement("div");
  sheetHeader.className = "cast-sheet-header";

  // AN EMPTY SPAN WHEN THE KIND IS ONE THIS BUILD DOES NOT KNOW, `ROW_ICONS`'s
  // own rule in the navigator: no width, no placeholder, just nothing drawn.
  const sheetIcon = document.createElement("span");
  sheetIcon.className = "cast-sheet-icon";
  // DECORATIVE. The row's name is `sheetName`'s text, never the glyph --
  // `createIcon` already marks its `<svg>` `aria-hidden`, and this span
  // repeats it so the sheet's accessible structure carries no icon at all.
  sheetIcon.setAttribute("aria-hidden", "true");

  const sheetName = document.createElement("h3");
  sheetName.id = "cast-sheet-name";

  const editButton = document.createElement("button");
  editButton.id = "cast-edit";
  editButton.type = "button";
  editButton.textContent = t("cast.edit");
  editButton.dataset.weight = "quiet";

  sheetHeader.append(sheetIcon, sheetName, editButton);

  // THE PICTURE, A 96PX SQUARE. `paintSheetPicture` rebuilds this per state,
  // `paintPicture`'s own reason: an `<img>` with no source is a broken-image
  // glyph in every engine, and a control whose whole answer is "there is
  // nothing to show" exists to disappoint.
  const sheetPicture = document.createElement("div");
  sheetPicture.id = "cast-sheet-picture";
  sheetPicture.className = "cast-sheet-picture";

  // ALSO CALLED, before the summary -- who this is, then what they are
  // called, then the paragraph (105). `paintSheet`'s own rule for an empty
  // summary applies here too: hidden rather than shown as a sentence with
  // nothing after the colon.
  const sheetAliases = document.createElement("p");
  sheetAliases.id = "cast-sheet-aliases";

  const sheetSummary = document.createElement("p");
  sheetSummary.id = "cast-sheet-summary";

  const sheetFields = document.createElement("dl");
  sheetFields.id = "cast-sheet-fields";
  sheetFields.className = "cast-sheet-fields";

  sheetRecord.append(sheetHeader, sheetPicture, sheetAliases, sheetSummary, sheetFields);
  sheet.append(sheetRecord);

  panel.append(status, newRow, entries, deletedToggle, sheet, detail);
  container.append(panel);

  /** The last list the store answered with. */
  let members: CastMemberRow[] = [];
  let deletedMembers: CastMemberRow[] = [];
  let showingDeleted = false;
  /** Which entry the form is about, or null when none is. */
  let editing: string | null = null;
  /** Read or Edit. Read is the default on every fresh selection (096, W3);
   *  Edit is entered only by pressing `#cast-edit` and left by `#cast-cancel`
   *  or a successful `#cast-save`. CSS keys on `panel.dataset.mode`, set by
   *  `setMode`, to show `#cast-sheet` or `#cast-detail` -- neither is ever
   *  added to or removed from the DOM for this. */
  let mode: "read" | "edit" = "read";
  /** Unsaved form state, per member, for the life of the panel. See the header:
   *  moving between entries is how this surface is used. */
  const drafts = new Map<string, Draft>();
  /** Whether the next press of Delete acts. See `arm`. */
  let armed = false;
  /** Bumped on every act that changes which picture the block is about, so an
   *  answer for the entry the writer LEFT cannot paint over the one they are
   *  looking at. Separate from `generation`, which the list and the form share:
   *  a picture read is neither, and one counter for both would make a slow
   *  thumbnail cancel a save. */
  let pictureGeneration = 0;
  let destroyed = false;
  /** An answer that resolves after a newer open, or after the panel closed, must
   *  not repaint or report: the writer would be told about a book they are no
   *  longer looking at. */
  let generation = 0;

  function setOpen(open: boolean): void {
    panel.hidden = !open;
  }

  /** Switch which of `#cast-sheet` / `#cast-detail` CSS shows. Never touches
   *  either element's own `hidden` -- that dimension is "is anything
   *  selected", managed by `select`/`clearSelection`, and orthogonal to this
   *  one. */
  function setMode(next: "read" | "edit"): void {
    mode = next;
    panel.dataset.mode = mode;
  }

  /** Whether the sheet has anything to show: only when a member is selected,
   *  which a bookless project never has. Called after every repaint of
   *  `members` or `editing` so the two never drift -- `paintEntries` and
   *  `clearSelection` both end in it. */
  function syncSheetVisibility(): void {
    sheetRecord.hidden = editing === null;
    sheet.hidden = editing === null;
  }

  /** ARMED, NOT CONFIRMED IN A SECOND SURFACE. Removal is recoverable through
   *  Deleted entries, but may hide a substantial record. The button says so
   *  by changing what it is called, and ANY other interaction puts it back:
   *  an armed destructive control that stays armed is one a writer meets a
   *  minute later having forgotten they armed it. */
  function disarm(): void {
    armed = false;
    removeButton.textContent = t("cast.remove");
  }

  /** The sentence for a state this build knows, or the unreadable one.
   *
   *  A KIND THIS BUILD DOES NOT KNOW FALLS THROUGH TO "could not be read", which
   *  is `kindKeyFor`'s rule for the same hazard: a newer host's fifth word must
   *  not index into `undefined` and paint a heading made of a missing-key
   *  marker. It is also the honest answer -- this build cannot show it. */
  function pictureSentence(state: string): string {
    if (state === "none") return t("cast.picture.none");
    if (state === "missing") return t("cast.picture.missing");
    // `unreadable`, a word this build does not know, AND a `present` that
    // arrived with no thumbnail. All three are the same thing to say: this
    // build cannot show you that picture.
    return t("cast.picture.unreadable");
  }

  /** Rebuild the picture block for one answer.
   *
   *  THE MEMBER'S NAME AND NOT THE FILE'S is the image's accessible name. A
   *  uuid is not a description of anybody, and the file name is the one thing
   *  about a picture a writer never chose. */
  function paintPicture(view: PictureView, memberName: string): void {
    picture.replaceChildren();
    // KEYED ON THE THUMBNAIL AND NOT ON THE WORD, because a mutation proved the
    // pair redundant: the host sends a `data_uri` only with `present`, so
    // `state === "present" &&` refused exactly what the null check already
    // refused and deleting it survived the whole suite. Two rules refusing one
    // input cover for each other. What is left is the rule that matters --
    // there is a picture to draw, or there is a sentence to say.
    if (view.data_uri !== null) {
      const img = document.createElement("img");
      img.id = "cast-picture";
      img.src = view.data_uri;
      img.alt = t("cast.picture.alt", { name: memberName });
      picture.append(img);
    } else {
      pictureState.textContent = pictureSentence(view.state);
      picture.append(pictureState);
    }
    picture.append(chooseButton);
    chooseButton.textContent =
      view.state === "none" ? t("cast.picture.choose") : t("cast.picture.replace");
    // NO ENLARGE CONTROL HERE. Viewing the picture full size is the sheet's job
    // (`paintSheetPicture`'s `#cast-picture-full`), painted alongside this block
    // by `loadPicture` -- Edit keeps only the thumbnail plus Add/Replace and
    // Remove, which are the acts a draft can still change.
    // OFFERED ONLY WHEN THERE IS SOMETHING TO REMOVE -- including when the file
    // is gone or unreadable, which is exactly when removing is the thing the
    // writer wants: the record says there was a photograph and there is no way
    // to see it, so taking the claim off is the repair.
    if (view.state !== "none") {
      const clear = document.createElement("button");
      clear.id = "cast-picture-clear";
      clear.type = "button";
      clear.textContent = t("cast.picture.remove");
      // NO `data-weight="danger"`, and a capture is what settled it. Filled red
      // it was the loudest control on the panel -- louder than Save, which is
      // the panel's reason for existing -- and it read as the same class of act
      // as `#cast-remove`, which arms because deleting a character sheet
      // destroys the writer's writing and nothing reaches it. This does not:
      // the file it unlinks is a COPY, and the photograph the writer chose is
      // still wherever they got it. Proportion is the point -- an application
      // that shouts at every removal teaches a writer to ignore it shouting.
      // Eleventh defect found by looking.
      clear.addEventListener("click", onClearPicture);
      picture.append(clear);
    }
  }

  /** Rebuild the sheet's picture square for one answer. Its OWN function
   *  rather than a second call into `paintPicture`: the sheet offers a
   *  smaller surface than the form does (no Replace/Remove text, no state
   *  sentence) and can act on the picture WITHOUT entering Edit at all --
   *  choosing one and viewing one are not draft actions, they write or read
   *  the store immediately in either mode, exactly as they already did
   *  inside the form. */
  function paintSheetPicture(view: PictureView, memberName: string): void {
    sheetPicture.replaceChildren();
    if (view.data_uri !== null) {
      // THE SQUARE ITSELF IS THE BUTTON -- "click = today's enlarge" (W3) --
      // named from the image's own alt text rather than a separate label. Its
      // id is `cast-picture-full`, not a sheet-scoped name: this square is now
      // the ONLY enlarge control the panel has, Edit's separate button retired
      // in 097 once 096 had already made Read the sheet the writer opens onto.
      const frame = document.createElement("button");
      frame.type = "button";
      frame.id = "cast-picture-full";
      frame.className = "cast-sheet-picture-frame";
      const img = document.createElement("img");
      img.src = view.data_uri;
      img.alt = t("cast.picture.alt", { name: memberName });
      frame.append(img);
      frame.addEventListener("click", onViewPicture);
      sheetPicture.append(frame);
      return;
    }
    // MISSING AND UNREADABLE FOLD INTO THE SAME SQUARE AS NONE, deliberately:
    // the sheet is the quick read and the repair for all three is the same
    // button that adds one in the first place (`onChoosePicture`, which
    // replaces whatever is or is not there). The three-way distinction and
    // the Remove control that answers "it is there and broken" stay in Edit,
    // where the sentences that name them already live -- ticket 07's "No
    // picture yet." sentence goes from the SHEET, not from the form.
    const empty = document.createElement("div");
    empty.className = "cast-sheet-picture-empty";
    empty.setAttribute("aria-hidden", "true");
    empty.append(createIcon("image"));
    sheetPicture.append(empty);
    const add = document.createElement("button");
    add.type = "button";
    add.id = "cast-sheet-picture-add";
    // REUSES `cast.picture.choose` ("Add a picture…") rather than a new key:
    // it is the same sentence for the same act, and the plan's own text asks
    // for the reuse if the wording already matches.
    add.textContent = t("cast.picture.choose");
    add.dataset.weight = "quiet";
    add.addEventListener("click", onChoosePicture);
    sheetPicture.append(add);
  }

  /** Paint the read sheet from what the STORE holds -- never a draft, which
   *  is the whole difference between this and `paintForm`. */
  function paintSheet(member: CastMemberRow): void {
    sheetIcon.replaceChildren();
    const iconName = kindIconFor(member.kind);
    if (iconName !== null) sheetIcon.append(createIcon(iconName));
    sheetName.textContent = member.name;
    // ALSO CALLED, hidden when there is none -- the summary's own rule below,
    // one line up.
    sheetAliases.textContent = t("cast.aliases.label", { aliases: member.aliases.join(", ") });
    sheetAliases.hidden = member.aliases.length === 0;
    // AN EMPTY SUMMARY SHOWS NOTHING (W3) -- no placeholder sentence, unlike
    // the form's own placeholder text, because a placeholder is an invitation
    // to type and this surface does not type.
    sheetSummary.textContent = member.summary;
    sheetSummary.hidden = member.summary.trim() === "";
    sheetFields.replaceChildren();
    for (const field of member.fields) {
      const dt = document.createElement("dt");
      dt.textContent = field.label;
      const dd = document.createElement("dd");
      dd.textContent = field.value;
      sheetFields.append(dt, dd);
    }
    // NO FIELDS SHOWS NOTHING, the same rule as the summary above.
    sheetFields.hidden = member.fields.length === 0;
  }

  /** Ask the host about `id`'s picture and paint the answer, unless the writer
   *  has moved on. */
  function loadPicture(id: string, memberName: string): void {
    pictureGeneration += 1;
    const mine = pictureGeneration;
    // PAINTED BEFORE THE READ RESOLVES, so moving between entries never leaves
    // the previous member's photograph on screen under the next member's name.
    // BOTH BLOCKS, one load: `#cast-sheet` and `#cast-detail` are both always
    // in the DOM (096), so one read answers both regardless of which the
    // writer is currently looking at.
    paintPicture({ state: "none", data_uri: null }, memberName);
    paintSheetPicture({ state: "none", data_uri: null }, memberName);
    void deps
      .picture(id)
      .then((view) => {
        if (destroyed || mine !== pictureGeneration) return;
        paintPicture(view, memberName);
        paintSheetPicture(view, memberName);
      })
      .catch((err: unknown) => {
        if (destroyed || mine !== pictureGeneration) return;
        // The block already says "no picture", which would be a LIE for a
        // member that has one -- so the failure is named rather than left to
        // read as an absence.
        paintPicture({ state: "unreadable", data_uri: null }, memberName);
        paintSheetPicture({ state: "unreadable", data_uri: null }, memberName);
        deps.onNotice(t("cast.error.picture", { error: String(err) }));
      });
  }

  function onChoosePicture(): void {
    const id = editing;
    if (id === null) return;
    disarm();
    const named = members.find((m) => m.id === id)?.name ?? "";
    pictureGeneration += 1;
    const mine = pictureGeneration;
    void deps
      .pickPicture(id)
      .then(async (updated) => {
        if (destroyed || mine !== pictureGeneration) return;
        // CANCELLED IS AN ANSWER. No notice, no announcement, no repaint --
        // `project_export_as`'s rule, and the writer did exactly what they
        // intended.
        if (updated === null) return;
        deps.onDone(t("cast.done.picture-added", { name: updated.name }));
        if (!(await reload(generation))) return;
        if (editing === id) loadPicture(id, updated.name);
      })
      .catch((err: unknown) => {
        if (destroyed || mine !== pictureGeneration) return;
        deps.onNotice(t("cast.error.picture", { error: String(err) }));
      });
  }

  /** Ask the host for the picture at full size and hand it to the viewer.
   *
   *  IT GOES THROUGH THE HOST AGAIN rather than enlarging the thumbnail the
   *  block already holds. The thumbnail is 256 px on its long side and blowing
   *  it up is exactly the picture the writer pressed this because they could not
   *  see. What crosses is still bounded -- `pictures::FULL_MAX` -- so the web
   *  process never holds an original. */
  function onViewPicture(): void {
    const id = editing;
    if (id === null) return;
    disarm();
    const named = members.find((m) => m.id === id)?.name ?? "";
    const mine = pictureGeneration;
    void deps
      .fullPicture(id)
      .then((view) => {
        if (destroyed || mine !== pictureGeneration) return;
        if (view.data_uri === null) {
          // NAMED RATHER THAN SILENT: a full read can fail where the thumbnail
          // beside it succeeded, because the file can go between the two reads,
          // and a press that appears to do nothing reads as a broken control.
          deps.onNotice(t("viewer.unavailable"));
          return;
        }
        deps.showFullSize(view.data_uri, t("cast.picture.alt", { name: named }));
      })
      .catch((err: unknown) => {
        if (destroyed || mine !== pictureGeneration) return;
        deps.onNotice(t("viewer.error", { error: String(err) }));
      });
  }

  function onClearPicture(): void {
    const id = editing;
    if (id === null) return;
    disarm();
    pictureGeneration += 1;
    const mine = pictureGeneration;
    void deps
      .clearPicture(id)
      .then(async (updated) => {
        if (destroyed || mine !== pictureGeneration) return;
        deps.onDone(t("cast.done.picture-removed", { name: updated.name }));
        if (!(await reload(generation))) return;
        if (editing === id) loadPicture(id, updated.name);
      })
      .catch((err: unknown) => {
        if (destroyed || mine !== pictureGeneration) return;
        deps.onNotice(t("cast.error.picture", { error: String(err) }));
      });
  }

  function readForm(): Draft {
    return {
      kind: kind.value,
      name: name.value,
      summary: summary.value,
      fields: Array.from(fields.querySelectorAll<HTMLElement>(".cast-field-row")).map((row) => ({
        label: row.querySelector<HTMLInputElement>(".cast-field-label")?.value ?? "",
        value: row.querySelector<HTMLInputElement>(".cast-field-value")?.value ?? "",
      })),
      aliases: Array.from(aliases.querySelectorAll<HTMLInputElement>(".cast-alias-row input")).map(
        (input) => input.value,
      ),
    };
  }

  /** Hold what the form currently says, so selecting away does not discard it. */
  function stash(): void {
    if (editing === null) return;
    drafts.set(editing, readForm());
  }

  function fieldRow(field: CastFieldRow): HTMLElement {
    const row = document.createElement("div");
    row.className = "cast-field-row";
    const label = document.createElement("input");
    label.type = "text";
    label.className = "cast-field-label";
    label.value = field.label;
    label.placeholder = t("cast.field.label.placeholder");
    label.setAttribute("aria-label", t("cast.field.label.label"));
    const value = document.createElement("input");
    value.type = "text";
    value.className = "cast-field-value";
    value.value = field.value;
    value.placeholder = t("cast.field.value.placeholder");
    value.setAttribute("aria-label", t("cast.field.value.label"));
    row.append(label, value);
    return row;
  }

  /** One alias, `fieldRow`'s own shape one input narrower: an alias has no
   *  label, only the text and the store's own `MIN_CAST_NAME_LENGTH` floor
   *  (restated on the host as `cast::MIN_ALIAS_LENGTH`). Emptying it is how an
   *  alias is deleted, `fieldRow`'s rule again: no per-row remove control. */
  function aliasRow(alias: string): HTMLElement {
    const row = document.createElement("div");
    row.className = "cast-alias-row";
    const input = document.createElement("input");
    input.type = "text";
    input.value = alias;
    input.placeholder = t("cast.alias.placeholder");
    input.setAttribute("aria-label", t("cast.alias.label"));
    row.append(input);
    return row;
  }

  /** Paint the form from a draft, plus ONE blank row so there is always
   *  somewhere to type. Emptying both halves of a row is how a detail is
   *  deleted, which is why there is no per-row remove control: the store already
   *  drops a row that is blank on both sides, and a button would be a second way
   *  to say it. */
  function paintForm(draft: Draft): void {
    kind.value = draft.kind;
    name.value = draft.name;
    summary.value = draft.summary;
    fields.replaceChildren(...draft.fields.map(fieldRow), fieldRow({ label: "", value: "" }));
    aliases.replaceChildren(...draft.aliases.map(aliasRow), aliasRow(""));
  }

  function select(id: string): void {
    if (id === editing) return;
    stash();
    disarm();
    editing = id;
    // READ IS THE DEFAULT ON EVERY FRESH SELECTION (096, W3). A writer who
    // was editing a DIFFERENT member and clicks another does not carry Edit
    // over to it -- Edit is a per-member act the writer presses into, not a
    // sticky mode of the panel.
    setMode("read");
    const held = drafts.get(id);
    const member = members.find((m) => m.id === id);
    if (held !== undefined) paintForm(held);
    else if (member !== undefined) paintForm(draftOf(member));
    if (member !== undefined) paintSheet(member);
    detail.hidden = false;
    status.textContent = t("cast.status.about", { name: member?.name ?? "" });
    // THE PICTURE IS NOT A DRAFT. Everything else in this form is unsaved
    // typing held per entry; a picture is written to the store the moment the
    // writer chooses it, so what the block shows is always what the file holds
    // and there is nothing to stash.
    loadPicture(id, member?.name ?? "");
    paintEntries();
  }

  function clearSelection(): void {
    editing = null;
    disarm();
    setMode("read");
    detail.hidden = true;
    // A read still in flight for the entry that was open must not paint into a
    // form that is now about nobody.
    pictureGeneration += 1;
    picture.replaceChildren();
    sheetPicture.replaceChildren();
    syncSheetVisibility();
  }

  function paintEntries(): void {
    // KEYBOARD FOCUS SURVIVES THE REPAINT (096 review). `entries.replaceChildren()`
    // below throws away the very button the writer just activated -- every
    // browser drops focus to <body> when its element leaves the document,
    // which is where the panel's own `keydown` listener stops hearing
    // Escape. Captured before the wipe, restored after the rebuild, onto
    // whichever entry now represents `editing` -- and ONLY when focus was
    // already inside this list, so a repaint driven by something else (a
    // picture arriving, a reload after Save) never steals focus from
    // wherever the writer actually is.
    const hadFocusInside = entries.contains(document.activeElement);
    entries.replaceChildren();
    deletedToggle.textContent = showingDeleted ? t("cast.deleted.back") : t("cast.deleted.show", { count: deletedMembers.length });
    deletedToggle.setAttribute("aria-pressed", String(showingDeleted));
    if (showingDeleted) {
      for (const member of deletedMembers) {
        const row = document.createElement("div");
        row.className = "cast-deleted-row";
        const label = document.createElement("span");
        label.textContent = member.name;
        const restore = document.createElement("button");
        restore.type = "button";
        restore.dataset.restoreId = member.id;
        restore.textContent = t("cast.deleted.restore");
        restore.setAttribute("aria-label", t("cast.deleted.restore.named", { name: member.name }));
        row.append(label, restore);
        entries.append(row);
      }
      if (deletedMembers.length === 0) {
        const empty = document.createElement("p");
        empty.className = "cast-empty";
        empty.textContent = t("cast.deleted.empty");
        entries.append(empty);
      }
      return;
    }
    if (members.length === 0) {
      // SAID, not an empty box. The recorded `renderProjects` defect: an empty
      // listbox is indistinguishable from one that failed to paint, and this
      // panel's empty state is the state every new project is in.
      const empty = document.createElement("p");
      empty.className = "cast-empty";
      empty.textContent = t("cast.empty");
      entries.append(empty);
      // THE ADD ROW IS OPEN (096, decision 4): an empty cast has no "foot of
      // the list" to hang a toggle off, and adding the first entry is the one
      // thing a brand-new book needs. `.cast-empty` above is the ONLY
      // sentence this state gets (096 follow-up: a second one lived in the
      // sheet and said "below", which contradicted this row opening here,
      // above the list, automatically).
      newRow.hidden = false;
      syncSheetVisibility();
      return;
    }
    for (const groupKind of CAST_KINDS) {
      const mine = members.filter((m) => m.kind === groupKind);
      // A kind nobody has an entry in gets NO heading. An empty heading is a
      // promise of rows that are not there.
      if (mine.length === 0) continue;
      const key = groupKeyFor(groupKind);
      const group = document.createElement("div");
      group.className = "cast-group";
      group.dataset.kind = groupKind;
      // NAMED, so the entries under it are not a flat list of buttons to a
      // screen reader. `role="group"` with a label is what carries the kind to
      // somebody who cannot see which heading a button sits under.
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", key === null ? groupKind : t(key));
      // h4, NOT h3 (096 review): #cast-sheet-name is an h3 -- the sheet is
      // this panel's main content -- and a group title in the list beside it
      // is subordinate to that, one heading level down.
      const title = document.createElement("h4");
      title.className = "cast-group-title";
      title.textContent = key === null ? groupKind : t(key);
      group.append(title);
      for (const member of mine) {
        const entry = document.createElement("button");
        entry.type = "button";
        entry.className = "cast-entry";
        entry.dataset.id = member.id;
        // THE GLYPH, `aria-hidden` (W3, ticket 02): the entry's accessible
        // name stays the plain member name -- the label span's text and
        // nothing else, `createIcon`'s own `aria-hidden` `<svg>` repeated on
        // its wrapper for the same belt-and-braces reason the navigator's row
        // icon carries it.
        const icon = document.createElement("span");
        icon.className = "cast-entry-icon";
        icon.setAttribute("aria-hidden", "true");
        const iconName = kindIconFor(member.kind);
        if (iconName !== null) icon.append(createIcon(iconName));
        const label = document.createElement("span");
        label.className = "cast-entry-label";
        label.textContent = member.name;
        entry.append(icon, label);
        entry.setAttribute("aria-pressed", String(member.id === editing));
        group.append(entry);
      }
      entries.append(group);
    }
    // "ADD…" AS THE LAST ROW OF THE LIST (W3, ticket 02). Reveals the
    // existing `#cast-new-row` IN PLACE -- that element does not move, only
    // its default visibility does -- so `shot-cli`'s `--cast-*` flags and
    // this file's DOM-order tests keep the row exactly where they left it.
    // Rebuilt every repaint like the entries above it and delegated through
    // `onEntriesClick` for the same reason: this whole container is replaced
    // on every call, so a listener attached here would leak one per repaint.
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.id = "cast-new-toggle";
    toggle.textContent = t("cast.new.toggle");
    toggle.dataset.weight = "quiet";
    entries.append(toggle);
    if (hadFocusInside && editing !== null) {
      const reselected = Array.from(entries.querySelectorAll<HTMLElement>(".cast-entry")).find(
        (e) => e.dataset.id === editing,
      );
      reselected?.focus();
    }
    syncSheetVisibility();
  }

  /** Read the store and repaint. Returns false when it could not be read, so a
   *  caller knows not to go on. */
  async function reload(mine: number): Promise<boolean> {
    let read: CastMemberRow[];
    try {
      const [active, deleted] = await Promise.all([deps.list(), deps.listDeleted()]);
      read = active;
      if (destroyed || mine !== generation) return false;
      deletedMembers = deleted;
    } catch (err) {
      if (destroyed || mine !== generation) return false;
      // NOT the designed empty state. A `catch` that painted "nobody yet" would
      // report a store this panel could not read as a book with nobody in it,
      // and the writer would add everyone again over the top of the people they
      // still have — the recorded `renderImports([])` defect. The controls are
      // disabled so nothing can be written against a list nobody read.
      entries.replaceChildren();
      clearSelection();
      newButton.disabled = true;
      deletedToggle.disabled = true;
      status.textContent = "";
      deps.onNotice(t("cast.error.list", { error: String(err) }));
      return false;
    }
    if (destroyed || mine !== generation) return false;
    members = read;
    newButton.disabled = false;
    deletedToggle.disabled = false;
    if (editing !== null && !members.some((m) => m.id === editing)) clearSelection();
    paintEntries();
    if (editing === null) {
      status.textContent = showingDeleted ? t("cast.deleted.status") : members.length === 0 ? "" : t("cast.status.choose");
    }
    return true;
  }

  function onNew(): void {
    const wanted = newName.value.trim();
    if (wanted === "") {
      // SAID, not silent. The recorded pair of `Edit > Replace…` and the project
      // panel's Create: both returned on an empty field, and the first use of
      // each was a writer pressing a button and watching nothing happen. Unlike
      // the synopsis panel's nothing-selected branch, a writer reaches this by
      // pressing the button, so the sentence is one somebody can read.
      deps.onNotice(t("cast.error.no-name"));
      return;
    }
    disarm();
    generation += 1;
    const mine = generation;
    const chosen = newKind.value;
    void deps
      .create(chosen, wanted)
      .then(async (made) => {
        if (destroyed || mine !== generation) return;
        newName.value = "";
        // A SUCCESSFUL ADD HIDES THE ROW AGAIN (096, decision 3) -- the other
        // of the two acts that close it, Escape being the first. Harmless
        // when the row had no toggle to reopen it (the cast was empty): the
        // repaint below finds a non-empty list now and grows one.
        newRow.hidden = true;
        deps.onDone(t("cast.done.created", { name: made.name }));
        if (!(await reload(mine))) return;
        // SELECTED, so the writer goes straight on to the detail. Adding a name
        // and then having to find it in the list is the shape of a form nobody
        // finishes.
        select(made.id);
      })
      .catch((err: unknown) => {
        if (destroyed || mine !== generation) return;
        deps.onNotice(t("cast.error.create", { error: String(err) }));
      });
  }

  function onSave(): void {
    const id = editing;
    // Unreachable through the shipped path — the button lives inside an element
    // that is hidden whenever nothing is selected — so this is the recorded
    // "something moved between paint and click" case rather than a guard.
    // Silence is right: there is no entry to name.
    if (id === null) return;
    disarm();
    const form = readForm();
    generation += 1;
    const mine = generation;
    void deps
      .save(id, form.kind, form.name, form.summary, form.fields, form.aliases)
      .then(async (saved) => {
        if (destroyed || mine !== generation) return;
        // The draft is dropped only once the store has it. A draft that outlived
        // its save would show the writer their own stale typing over what the
        // store actually holds.
        drafts.delete(id);
        deps.onDone(t("cast.done.saved", { name: saved.name }));
        if (!(await reload(mine))) return;
        if (editing === id) {
          paintForm(draftOf(saved));
          paintSheet(saved);
          status.textContent = t("cast.status.about", { name: saved.name });
          // A SUCCESSFUL SAVE RETURNS TO READ (096, decision 1). Inside the
          // `editing === id` guard on purpose: a save that lands after the
          // writer moved to a different member must not silently flip THAT
          // member's mode -- the generation check above already refuses a
          // save that landed after the whole panel moved on, and this is the
          // same rule one level down.
          setMode("read");
          // FOCUS MOVES WITH IT (096 review). `saveButton` is about to be
          // hidden by the mode CSS, and a hidden element cannot hold focus --
          // every engine drops it to <body>, which is exactly where the
          // panel's own `keydown` listener stops hearing Escape. `#cast-edit`
          // is the sheet's own control for the member still open, the same
          // reasoning `onEdit` already follows the other way for
          // `#cast-name`.
          editButton.focus();
        }
      })
      .catch((err: unknown) => {
        if (destroyed || mine !== generation) return;
        // LEFT OPEN, with the writing still in the form. Closing would take the
        // writer's unsaved paragraphs off the screen at the moment they are told
        // the save did not land. `cast_set`'s three alias refusals get their
        // own sentence when the host's own text says which one this was;
        // everything else falls through to the generic notice below.
        deps.onNotice(aliasRefusal(err) ?? t("cast.error.save", { error: String(err) }));
      });
  }

  function onRemove(): void {
    const id = editing;
    if (id === null) return;
    if (!armed) {
      armed = true;
      removeButton.textContent = t("cast.remove.armed");
      return;
    }
    disarm();
    const gone = members.find((m) => m.id === id);
    generation += 1;
    const mine = generation;
    void deps
      .remove(id)
      .then(async () => {
        if (destroyed || mine !== generation) return;
        drafts.delete(id);
        clearSelection();
        deps.onDone(t("cast.done.removed", { name: gone?.name ?? "" }));
        await reload(mine);
      })
      .catch((err: unknown) => {
        if (destroyed || mine !== generation) return;
        deps.onNotice(t("cast.error.remove", { error: String(err) }));
      });
  }

  /** Enters Edit for the member the sheet is currently about (096). */
  function onEdit(): void {
    if (editing === null) return;
    disarm();
    setMode("edit");
    // THE CARET GOES STRAIGHT INTO THE NAME FIELD, `rename-panel.ts`'s and
    // the synopsis panel's own rule for the control that opens a field to
    // type into: a writer who pressed Edit is about to write, not to look.
    name.focus();
  }

  /** Leaves Edit without saving, discarding THAT MEMBER'S draft -- the
   *  difference from a plain selection change, which keeps it (037's rule
   *  survives a selection change; it does not survive the writer pressing
   *  the word "Cancel"). */
  function onCancel(): void {
    const id = editing;
    if (id === null) return;
    disarm();
    // REPAINTED FROM THE STORE, so pressing Edit again on the SAME member
    // without reselecting it opens fresh rather than showing the discarded
    // typing one more time. This repaint IS the discard: leaving the member
    // later writes the form back into the draft map (`select` keeps drafts
    // across a selection change, 037), so what it writes back is the store's
    // text. A `drafts.delete(id)` stood here too and the mutation pass showed
    // it unobservable from any path; a line nothing can reach is a claim a
    // reader credits, so it is gone.
    const member = members.find((m) => m.id === id);
    if (member !== undefined) paintForm(draftOf(member));
    setMode("read");
    // See `onSave`'s own comment: `cancelButton` is about to be hidden by
    // the mode CSS, and focus does not follow a hidden element anywhere.
    editButton.focus();
  }

  const onEntriesClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const restoreId = target.closest<HTMLElement>("[data-restore-id]")?.dataset.restoreId;
    if (restoreId !== undefined) {
      generation += 1;
      const mine = generation;
      const restored = deletedMembers.find((m) => m.id === restoreId);
      void deps.restore(restoreId).then(async () => {
        if (destroyed || mine !== generation) return;
        deps.onDone(t("cast.done.restored", { name: restored?.name ?? "" }));
        showingDeleted = false;
        if (await reload(mine)) {
          select(restoreId);
          Array.from(entries.querySelectorAll<HTMLElement>(".cast-entry")).find((entry) => entry.dataset.id === restoreId)?.focus();
        }
      }).catch((err: unknown) => {
        if (destroyed || mine !== generation) return;
        deps.onNotice(t("cast.error.restore", { error: String(err) }));
      });
      return;
    }
    // THE FOOT-OF-LIST TOGGLE, delegated like the entries themselves: the
    // whole container is rebuilt on every repaint, so this button never
    // outlives the listener it would otherwise need of its own.
    if (target.closest("#cast-new-toggle") !== null) {
      newRow.hidden = false;
      newName.focus();
      return;
    }
    const entry = target.closest<HTMLElement>(".cast-entry");
    const id = entry?.dataset.id;
    if (id === undefined) return;
    select(id);
  };

  const onAddField = (): void => {
    disarm();
    fields.append(fieldRow({ label: "", value: "" }));
  };

  const onFormInput = (): void => disarm();

  const onKey = (event: Event): void => {
    if (!(event instanceof KeyboardEvent) || isCompositionKey(event)) return;
    if (event.key !== "Escape") return;
    // A CLOSABLE ADD ROW GOES FIRST (096, decision 3): it has its own toggle
    // to reopen it, so Escape collapsing it is a smaller, reversible act than
    // closing the whole panel on a writer who was only backing out of adding
    // one. The always-open row an EMPTY cast shows has no toggle to bring it
    // back, so Escape there still falls through to closing the panel,
    // unchanged from before this slice.
    if (!newRow.hidden && members.length > 0) {
      event.preventDefault();
      newRow.hidden = true;
      document.getElementById("cast-new-toggle")?.focus();
    }
    // Otherwise the shell's Escape closes the panel.
    //
    // ENTER IS NOT BOUND ANYWHERE HERE, deliberately. The summary is a textarea
    // and needs newlines; the name and the detail fields sit beside a Save the
    // writer can see, and a form where Return in one field commits the whole
    // record is one where a stray keystroke writes.
  };

  function close(): void {
    // A CLOSE BUMPS THE GENERATION, so a read still in flight cannot paint a
    // list into a panel the writer has already dismissed. Without it the
    // in-flight answer arrives, finds `mine === generation`, and repaints a
    // hidden element whose next open would then show a stale list for an
    // instant.
    generation += 1;
    // THE DRAFTS STAY, on the argument that Escape and an
    // outside click are deliberate; the cost was that a writer who dismissed
    // by accident lost what they typed. The form on screen is stashed first, so the entry
    // being edited keeps its typing too. Drafts live for the life of the panel
    // and leave when the store takes them (`onSave`) or the panel is destroyed.
    stash();
    clearSelection();
    members = [];
    deletedMembers = [];
    showingDeleted = false;
    entries.replaceChildren();
    status.textContent = "";
    setOpen(false);
  }

  panel.addEventListener("keydown", onKey);
  entries.addEventListener("click", onEntriesClick);
  deletedToggle.addEventListener("click", () => {
    stash();
    showingDeleted = !showingDeleted;
    clearSelection();
    newRow.hidden = true;
    paintEntries();
    status.textContent = showingDeleted ? t("cast.deleted.status") : members.length === 0 ? "" : t("cast.status.choose");
    deletedToggle.focus();
  });
  newButton.addEventListener("click", onNew);
  saveButton.addEventListener("click", onSave);
  removeButton.addEventListener("click", onRemove);
  addField.addEventListener("click", onAddField);
  chooseButton.addEventListener("click", onChoosePicture);
  detail.addEventListener("input", onFormInput);
  editButton.addEventListener("click", onEdit);
  cancelButton.addEventListener("click", onCancel);
  // Close, Escape and a click elsewhere (the shell's). Built AFTER `onKey` is
  // registered, so the add row's own Escape is heard first and a collapse is
  // not also a close.
  const shell = createPanelShell({
    panel,
    title: t("cast.heading"),
    titleId: "cast-heading",
    close,
    returnFocus: deps.onDismiss,
    inspector: true,
  });

  return {
    async open(focusId?: string): Promise<void> {
      generation += 1;
      const mine = generation;
      // Painted BEFORE the read resolves, so the panel says what it is from the
      // moment it appears rather than after a round trip.
      status.textContent = t("cast.status.reading");
      entries.replaceChildren();
      showingDeleted = false;
      clearSelection();
      newButton.disabled = false;
      deletedToggle.disabled = true;
      // COLLAPSED BY DEFAULT (096): `paintEntries`'s empty branch reopens it
      // if the store turns out to hold nobody, and this line must run BEFORE
      // that repaint rather than after, or it would re-close a row the
      // writer had already opened themselves on a later, unrelated reload.
      newRow.hidden = true;
      setOpen(true);
      // THE PANEL TAKES FOCUS ITSELF, not `#cast-new-name`: the row above is
      // usually collapsed now, and focusing a hidden field moves focus
      // nowhere in any engine. `covers-panel.ts`'s and `appearances-
      // panel.ts`'s own rule for a panel whose first control depends on what
      // the read comes back with -- Tab from here reaches whatever that
      // turns out to be, the add row if the book is empty or the first entry
      // otherwise, which is what `shot-cli`'s `--cast` keyboard route relies
      // on.
      panel.focus();
      // READ ON EVERY OPEN, never held: the panel outlives any number of opens
      // and a list from a held value would show whoever was in the book the
      // first time for the rest of the session.
      await reload(mine);
      // FOCUS-ONTO-A-MEMBER (098): the hover card's "Open in Cast" names who
      // it is about, and `select` is what puts the sheet on that member
      // rather than leaving the panel on whatever it last showed. A stale or
      // unknown id (the member was deleted between the card showing and the
      // click landing) falls through to the ordinary open below rather than
      // failing silently on a member that is not there to select.
      if (focusId !== undefined && mine === generation && members.some((m) => m.id === focusId)) {
        select(focusId);
        return;
      }
      // THE ONE CASE WHERE A FIELD STILL TAKES FOCUS: an empty cast opens
      // with the add row already showing, and a writer meeting an empty book
      // should be able to type the first name without reaching for Tab.
      if (!newRow.hidden) newName.focus();
    },
    close,
    isOpen(): boolean {
      return !panel.hidden;
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      // THE ONE THAT MATTERS. It is on the document, so it outlives these
      // elements and would accumulate one live closure per project switch.
      shell.destroy();
      panel.removeEventListener("keydown", onKey);
      entries.removeEventListener("click", onEntriesClick);
      newButton.removeEventListener("click", onNew);
      saveButton.removeEventListener("click", onSave);
      removeButton.removeEventListener("click", onRemove);
      addField.removeEventListener("click", onAddField);
      chooseButton.removeEventListener("click", onChoosePicture);
      // The Remove control is rebuilt per paint and lives inside `picture`, so
      // it leaves with the element rather than needing a removal of its own --
      // it binds to nothing outside itself.
      detail.removeEventListener("input", onFormInput);
      editButton.removeEventListener("click", onEdit);
      cancelButton.removeEventListener("click", onCancel);
      panel.remove();
    },
  };
}
