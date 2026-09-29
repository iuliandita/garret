// app/ui/src/synopsis-panel.ts
// What a part, a chapter or a scene is ABOUT, in the writer's own words.
//
// A PANEL, for the geometry reason every panel since the import slice has been
// one: the project bar's 39px and #nav-header's 39px are click-geometry
// constants restated in five rigs, and a sixth control in either strip risks
// wrapping it. This hangs off #project-bar exactly as #state-panel,
// #stats-panel and #rename-panel do, and costs the bar nothing.
//
// THE ROW IS CAPTURED AT OPEN AND NEVER RE-READ, which is the RENAME panel's
// rule and deliberately NOT the revision panel's. The revision panel reads the
// selection live because pressing one of its five buttons is one act and the
// writer is looking at the row while they do it. Here the writer types
// paragraphs, the selection is still live behind the panel (an arrow key
// reaches the navigator), and a save that read the selection at press time
// would put this chapter's summary onto whatever row they had wandered to.
//
// READ FIRST, EDIT SECOND, the cast sheet's own shape: `#synopsis-
// read` shows what the store holds as a PARAGRAPH, in the editor's own prose
// face, with an Edit control; `#synopsis-form` is the field this panel has
// always had, plus a Cancel beside Save. `panel.dataset.mode` is the only
// thing that decides which one is on screen -- see the two mode rules in
// style.css, `#cast-panel`'s own precedent.
//
// AN EMPTY SYNOPSIS HAS NO READ STATE. There is nothing to read, so opening on
// one goes straight to Edit -- and a Save that empties the field lands there
// too, rather than in a Read view with nothing in it. A Save or a Cancel that
// leaves real text behind returns to Read, and focus goes to `#synopsis-edit`
// because the field it was on is about to be hidden and no engine carries
// focus through that.
//
// IT DECIDES NOTHING ABOUT THE STORE. It does not know that an empty body
// deletes the row, that the body is trimmed, or that a synopsis is excluded
// from the word count. The store owns all three, and two places deciding one
// thing is how they drift -- so an emptied field is sent as an empty body and
// the answer comes back as the absence.
import { t } from "./i18n";
import { createPanelShell } from "./panel-shell";

export interface SynopsisPanelDeps {
  /** The bar anchor from index.html. Positioned absolutely against
   *  #project-bar, so it contributes nothing to the strip's line box. */
  readonly container: HTMLElement;
  /** What the store holds for this item, or null when nobody has written one. */
  read(itemId: string): Promise<string | null>;
  /** Write it. An empty body is a real instruction -- the store deletes the row
   *  -- and is the only way back from having written one. */
  write(itemId: string, body: string): Promise<void>;
  /** Good news. Its own channel, never the failure banner: every success in
   *  this application was painted in the alert surface for four slices. */
  onDone(message: string): void;
  onNotice(message: string): void;
  /** Where focus goes when the panel is dismissed with Escape. Not called for
   *  an outside click: a click already says where the writer wants to be. */
  onDismiss(): void;
}

export interface SynopsisPanel {
  /** Open against a NAMED row, prefilled with what the store holds.
   *
   *  Takes the title as well as the id, exactly as the rename panel does and
   *  for the same reason: this unit holds no walk, and the caller that knows
   *  which row it is about is the one that knows what it is called. */
  open(itemId: string, title: string): Promise<void>;
  /** Put it away without saving. */
  close(): void;
  isOpen(): boolean;
  destroy(): void;
}

/** The textarea's own bound: a paragraph is not a two-line
 *  slot with a scrollbar, and a synopsis is not an epic either -- 16 lines is
 *  already taller than this panel's own comfortable height. */
const MIN_ROWS = 4;
const MAX_ROWS = 16;

/** What a line costs in pixels when `getComputedStyle` cannot say. happy-dom
 *  never lays text out, so it answers `scrollHeight` with 0 rather than a real
 *  height -- caught by the caller before this constant is ever consulted --
 *  but it also answers `line-height` with `normal`, a keyword `parseFloat`
 *  turns into `NaN`, which a real engine can also report for a field with no
 *  `line-height` of its own. This is the field's own 13px face at the 1.5
 *  ratio the prose paragraph next to it already uses. */
const FALLBACK_LINE_HEIGHT_PX = 20;

export function createSynopsisPanel(deps: SynopsisPanelDeps): SynopsisPanel {
  const { container } = deps;

  const panel = document.createElement("div");
  panel.id = "synopsis-panel";
  panel.setAttribute("role", "dialog");
  // Nothing here traps focus and nothing behind it is inert, so claiming modal
  // would be a lie a screen reader acts on.
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-label", t("synopsis.panel.label"));
  // So Escape is heard even before the field takes focus. The recorded failure
  // of the fifth panel is one a writer could not dismiss at all.
  panel.tabIndex = -1;
  panel.hidden = true;
  // See the two mode rules in style.css: this is the only thing that decides
  // which of #synopsis-read / #synopsis-form is on screen, and neither block
  // is ever added to or removed from the DOM for it.
  panel.dataset.mode = "edit";

  /** WHICH ROW THIS IS ABOUT. Without it the writer has a textarea over their
   *  manuscript and nothing saying what it belongs to - which is the recorded
   *  compose-quote defect in the comments panel, found by capture. */
  const status = document.createElement("div");
  status.id = "synopsis-status";
  // A status rather than an alert: it names the row and reports what happened,
  // which is information rather than an interruption.
  status.setAttribute("role", "status");

  // ---- read -----------------------------------------------------
  const readBlock = document.createElement("div");
  readBlock.id = "synopsis-read";

  // THE EDITOR'S OWN PROSE FACE, the cast sheet's own reasoning: this is what
  // a writer reads, not a form label, so it reads like the manuscript rather
  // than like UI chrome. Styled in style.css off the same `--prose-family`
  // variable #cast-sheet-summary already names.
  const text = document.createElement("p");
  text.id = "synopsis-text";

  const editButton = document.createElement("button");
  editButton.id = "synopsis-edit";
  editButton.type = "button";
  editButton.textContent = t("synopsis.edit");
  editButton.dataset.weight = "quiet";

  readBlock.append(text, editButton);

  // ---- edit -----------------------------------------------------------------
  const form = document.createElement("div");
  form.id = "synopsis-form";

  const field = document.createElement("textarea");
  field.id = "synopsis-field";
  field.rows = MIN_ROWS;
  field.placeholder = t("synopsis.field.placeholder");
  // No visible label exists to point at, so the name has to be authored.
  field.setAttribute("aria-label", t("synopsis.field.label"));

  const cancelButton = document.createElement("button");
  cancelButton.id = "synopsis-cancel";
  cancelButton.type = "button";
  cancelButton.textContent = t("synopsis.cancel");
  cancelButton.dataset.weight = "quiet";

  const saveButton = document.createElement("button");
  saveButton.id = "synopsis-save";
  // Without this a button inside a form submits it.
  saveButton.type = "button";
  saveButton.textContent = t("synopsis.save");
  // The panel's reason for existing, so it is the one filled control on it.
  saveButton.dataset.weight = "primary";

  // ONE ROW, RIGHT-ALIGNED: `#synopsis-form` is a
  // column flex so the field can stretch to the panel's width, and the
  // default cross-axis `stretch` that comes with it stretched Cancel and
  // Save to that same width too -- two full-height stacked buttons instead
  // of one line. This anchor is its own flex row, the cast panel's own
  // Save/Cancel shape restated rather than reused, because the cast panel's
  // pair sits in plain block flow and has no row of its own to borrow.
  const controls = document.createElement("div");
  controls.id = "synopsis-form-controls";
  controls.append(cancelButton, saveButton);

  form.append(field, controls);

  panel.append(status, readBlock, form);
  container.append(panel);

  /** The row the panel was OPENED against. Null while it is closed, so a save
   *  can never fire against a row a previous open captured. */
  let editing: { id: string; title: string } | null = null;
  /** What the STORE holds, trimmed, or null when there is nothing written --
   *  the same "no row, never a row holding ''" rule the store keeps. This is
   *  what Cancel reverts to and what decides whether there is a Read state to
   *  return to at all; it is never the field's own live, unsaved text. */
  let stored: string | null = null;
  let destroyed = false;
  /** An answer that resolves after a newer open, or after the panel closed,
   *  must not repaint or report: the writer would be told about a row they are
   *  no longer looking at. */
  let generation = 0;
  /** `getComputedStyle` is read ONCE per panel rather than on every keystroke:
   *  it does not change while the panel is open, and a layout query on every
   *  `input` event is the cost `autosize` exists to spare the writer's typing
   *  from. Scoped to this closure, not the module, so two panels never share a
   *  reading meant for one field. */
  let lineHeightPx: number | null = null;

  function setOpen(open: boolean): void {
    panel.hidden = !open;
  }

  function setMode(next: "read" | "edit"): void {
    panel.dataset.mode = next;
  }

  function lineHeight(): number {
    if (lineHeightPx !== null) return lineHeightPx;
    const parsed = Number.parseFloat(getComputedStyle(field).lineHeight);
    lineHeightPx = Number.isFinite(parsed) ? parsed : FALLBACK_LINE_HEIGHT_PX;
    return lineHeightPx;
  }

  /** Grows the field with what is typed, never past the bound:
   *  a paragraph is not a two-line slot with a scrollbar, and this is also
   *  run whenever the field's own value changes from OUTSIDE typing -- opening
   *  Edit on a long-existing synopsis -- so the box is never undersized for
   *  content that was already there.
   *
   * SIZED FROM `scrollHeight`, NOT THE LINE COUNT: a paragraph
   *  with not one literal newline in it used to open at the 4-row minimum
   *  regardless of how long it read, wrapped or not -- the box is reset to
   *  the minimum FIRST so `scrollHeight` reports the content's own overflow
   *  rather than whatever height the previous size happened to leave it at.
   *
   *  THE NEWLINE COUNT IS STILL THE FALLBACK, for a `scrollHeight` of zero:
   *  that is what every engine reports for an element with no layout box yet
   *  -- happy-dom always, and a real one for a field not yet attached to a
   *  visible document -- and a paragraph is a better guess there than
   *  reporting the minimum for text that plainly has more than four lines. */
  function autosize(): void {
    field.rows = MIN_ROWS;
    const height = field.scrollHeight;
    const rows =
      height > 0
        ? Math.ceil(height / lineHeight())
        : field.value.split("\n").length;
    field.rows = Math.min(MAX_ROWS, Math.max(MIN_ROWS, rows));
  }

  /** Show the store's own text as a paragraph. Does not touch `editing`,
   *  `stored` or the field -- callers set those first, this only paints. */
  function paintRead(body: string): void {
    text.textContent = body;
  }

  /** Sets the field to text the writer did not just type -- the stored body,
   *  on open, on Edit, on Cancel -- and puts the caret at its START.
   *
   *  WITHOUT THIS a long-existing synopsis opens scrolled to its OWN END: an
   *  engine that sets `value` on a textarea moves the caret there too, and
   *  `autosize`'s box is sized to the LINE COUNT, not the wrapped height, so
   *  a paragraph with no literal newline gets the 4-row minimum regardless of
   *  how long it reads -- which used to fit under the fixed 6-row field this
   *  panel had before autosizing, and stopped fitting the moment the box
   *  could be smaller. Found by capture: the first one showed the writer's
   *  own paragraph missing its own first sentence. */
  function fillField(value: string): void {
    field.value = value;
    field.setSelectionRange(0, 0);
    field.scrollTop = 0;
  }

  function close(): void {
    // BUMPED HERE TOO, the appearances map's own rule (`appearances-map.ts`'s
    // `close`): a write started before this close resolves after it and must
    // not repaint a panel the writer already dismissed. Escape and Cancel on
    // an empty synopsis both go through this, and a `commit` in flight when
    // either fires is exactly the review's found gap -- `mine !== generation`
    // in `commit`'s own callback only trips if closing counts as a new
    // generation, and it did not.
    generation += 1;
    editing = null;
    stored = null;
    setOpen(false);
    setMode("edit");
    field.value = "";
    text.textContent = "";
  }

  function commit(): void {
    const row = editing;
    // Unreachable through the shipped path - the button lives inside a panel
    // that is hidden whenever nothing is captured - so this is the recorded
    // "reachable only if something moved between paint and click" case rather
    // than a guard. Silence is right here: there is no row to name.
    if (row === null) return;
    const body = field.value;
    const trimmed = body.trim();
    generation += 1;
    const mine = generation;
    void deps
      .write(row.id, body)
      .then(() => {
        if (destroyed || mine !== generation) return;
        // TWO SENTENCES, because clearing and writing are different acts and a
        // writer who emptied the field deliberately should be told it took.
        deps.onDone(trimmed === "" ? t("synopsis.done.cleared") : t("synopsis.done.saved"));
        if (trimmed === "") {
          // AN EMPTY SYNOPSIS HAS NO READ STATE (decision 1) -- there is
          // nothing to read, so a Save that clears the field GOES TO Edit --
          // deliberately restated rather than left alone, because the panel
          // can be in Read at the moment this fires: the field carries the
          // prefilled text throughout Read as well, so a writer can clear it
          // and press Save without ever pressing Edit first.
          stored = null;
          field.value = "";
          setMode("edit");
          autosize();
          field.focus();
          return;
        }
        // SAVE RETURNS TO READ (decision 1). `field.value` is reset to the
        // TRIMMED text -- what the store now actually holds -- so a stray
        // leading or trailing blank line typed this time is not still there
        // the next time Edit is pressed.
        stored = trimmed;
        fillField(trimmed);
        paintRead(trimmed);
        setMode("read");
        // FOCUS MOVES WITH IT, the cast panel's own reasoning: `saveButton` is
        // about to be hidden by the mode CSS, and a hidden element cannot
        // hold focus -- every engine drops it to <body>, which is exactly
        // where this panel's own `keydown` listener stops hearing Escape.
        // `#synopsis-edit` is the read view's own control for the row still
        // open.
        editButton.focus();
      })
      .catch((err: unknown) => {
        if (destroyed || mine !== generation) return;
        // LEFT OPEN, with the text still in the field. Closing would take the
        // writer's unsaved paragraphs off the screen at the moment they are
        // told the save did not land.
        deps.onNotice(t("synopsis.error.write", { error: String(err) }));
      });
  }

  /** Enters Edit for the row the panel is currently open on. */
  function onEditClick(): void {
    if (editing === null) return;
    fillField(stored ?? "");
    // SHOW FIRST, MEASURE SECOND. `autosize` reads `scrollHeight`, and a field
    // inside a `display: none` block measures 0, which sends it down the
    // newline fallback: an earlier capture showed a one-paragraph synopsis
    // at four rows with a scrollbar for exactly this order.
    setMode("edit");
    autosize();
    // THE CARET GOES STRAIGHT INTO THE FIELD, the cast panel's own rule for
    // the control that opens a field to type into: a writer who pressed Edit
    // is about to write, not to look.
    field.focus();
  }

  /** Leaves Edit without saving. When there IS stored text this reverts to it
   *  and returns to Read; when there is not -- an empty synopsis has no Read
   *  state to return to -- Cancel dismisses the whole panel instead, exactly
   *  as Escape does. */
  function onCancelClick(): void {
    const row = editing;
    if (row === null) return;
    if (stored === null) {
      close();
      deps.onDismiss();
      return;
    }
    // NOTHING TO REVERT HERE. The paragraph under Read was painted from the
    // store before Edit and Edit does not touch it; the field is refilled from
    // the store by `onEditClick` on the way back in. A refill and a repaint
    // stood here too and the mutation pass showed them unobservable from any
    // path; a line nothing can reach is a claim a reader credits, so both are
    // gone and Cancel is the mode change and the focus move below.
    setMode("read");
    // See `commit`'s own comment: `cancelButton` is about to be hidden by the
    // mode CSS, and focus does not follow a hidden element anywhere.
    editButton.focus();
  }

  // ENTER IS NOT BOUND, deliberately. The rename field commits on Enter
  // because a title is one line; a synopsis is paragraphs, and the same
  // binding here would make the second one impossible to type.

  const onSaveClick = (): void => commit();
  const onFieldInput = (): void => autosize();

  editButton.addEventListener("click", onEditClick);
  cancelButton.addEventListener("click", onCancelClick);
  saveButton.addEventListener("click", onSaveClick);
  field.addEventListener("input", onFieldInput);
  // Close, Escape and a click elsewhere (the shell's). The click moves no
  // focus; Close and Escape hand it back.
  const shell = createPanelShell({
    panel,
    title: t("synopsis.heading"),
    titleId: "synopsis-heading",
    close,
    returnFocus: deps.onDismiss,
    inspector: true,
  });

  return {
    async open(itemId: string, title: string): Promise<void> {
      editing = { id: itemId, title };
      stored = null;
      generation += 1;
      const mine = generation;
      // Painted BEFORE the read resolves, so the panel names its row from the
      // moment it appears rather than after a round trip.
      status.textContent = t("synopsis.about", { title });
      // OPTIMISTICALLY EDIT WHILE LOADING, exactly as before this slice: the
      // field takes focus immediately so a keystroke that lands before the
      // store answers is not lost, and the mode below is corrected once the
      // answer is known.
      field.value = "";
      field.rows = MIN_ROWS;
      field.disabled = false;
      cancelButton.disabled = false;
      saveButton.disabled = false;
      text.textContent = "";
      setMode("edit");
      setOpen(true);
      field.focus();
      let held: string | null;
      try {
        held = await deps.read(itemId);
      } catch (err) {
        if (destroyed || mine !== generation) return;
        // NOT the designed empty state. A `catch` that painted an empty field
        // would report a store this panel could not read as a row nobody has
        // written about, and the writer would then type over prose they still
        // have - the recorded `renderImports([])` defect. Every control is
        // disabled so an empty body cannot be saved over it.
        field.disabled = true;
        cancelButton.disabled = true;
        saveButton.disabled = true;
        deps.onNotice(t("synopsis.error.read", { error: String(err) }));
        return;
      }
      if (destroyed || mine !== generation) return;
      // Read on every open, never held: the panel outlives any number of opens
      // and a prefill from a held value would show whatever was edited first
      // for the rest of the session.
      if (held === null) {
        // AN EMPTY SYNOPSIS OPENS IN EDIT DIRECTLY (decision 1) -- there is
        // nothing to read, so Read would be an empty paragraph and an Edit
        // button leading to the same field the writer is already looking at.
        // The field was cleared synchronously above, so THIS BRANCH TOUCHES
        // NOTHING FURTHER -- writing `field.value = ""` here as well would be
        // the same write for a row with none, except in the window where the
        // writer started typing before the answer arrived, and there it
        // silently wipes what they typed. Found by a mutation in the
        // predecessor of this file, which is worth recording the other way
        // round: the mutant was the better implementation and this is it.
        return;
      }
      stored = held;
      fillField(held);
      autosize();
      paintRead(held);
      setMode("read");
      editButton.focus();
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
      editButton.removeEventListener("click", onEditClick);
      cancelButton.removeEventListener("click", onCancelClick);
      saveButton.removeEventListener("click", onSaveClick);
      field.removeEventListener("input", onFieldInput);
      panel.remove();
    },
  };
}
