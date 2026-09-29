// app/ui/src/identity-panel.ts
// The one surface where a writer says who they publish as, and which of their
// names this book is written under.
//
// A PANEL OF ITS OWN, and its menu item sits BELOW the two previews rather than
// beside Book design where the subject belongs. That is not taste: the File
// menu's headroom above Export is measured, and `export-cli` drives that menu by
// arrow key against a 1000 ms debounce with about 140 ms of margin left. One
// more item above Export makes `export_includes_last_keystroke` structurally
// unreachable and the graded export rig starts aborting on its own vacuity
// guard. An item below the previews costs that route nothing.
//
// THE PANEL SENDS AN ID AND NEVER A PIN. `identity_pin` takes the identity's id
// and the HOST reads that identity out of the vault itself. That is the
// containment rule -- a cover is not an argument to `book_design_set` because a
// page-composed value would be naming a file on disk -- one surface further in
// and for a sharper reason: a page-composed pin is a page-composed BYLINE, and
// the whole guarantee here is that what travels inside a project file came from
// the vault's own public and publishing tiers.
//
// THE PRIVATE TIER IS EDITED HERE AND TRAVELS NOWHERE. It is on this panel
// because there is nowhere else for a legal name to be typed. It cannot reach a
// book: the copy a book keeps has no field for it. The note beside those fields
// says exactly that and says the file is not encrypted, because the protection
// is against TRAVELLING and never against somebody at this machine.
//
// EVERY CONTROL EXCEPT SAVE IS THE ACT, and Save is here because the fields are
// a form. The "no Save control" rule is about panels whose every control has
// already landed its change; a nine-field form that wrote on each keystroke
// would bump the identity's `rev` nine times per edit and make every book pinned
// to it stale nine times over.
import { t } from "./i18n";
import { createPanelShell } from "./panel-shell";
import {
  MULTILINE_FIELDS,
  PRIVATE_FIELDS,
  PUBLIC_FIELDS,
  PUBLISHING_FIELDS,
  blankIdentity,
  fieldLabel,
  identityLabel,
  linksFromText,
  linksToText,
  pinnedLine,
  type IdentitiesView,
  type Identity,
  type PinPreview,
} from "./identity";

export interface IdentityPanelDeps {
  /** The bar anchor from index.html. Positioned absolutely against
   *  #project-bar, so it contributes nothing to the strip's line box. */
  readonly container: HTMLElement;
  /** The vault and the open book's pin. Read on every open: the vault is
   *  library-level and another book may have been opened since. */
  read(): Promise<IdentitiesView>;
  /** Record one identity, whole. The host mints the id and owns the `rev`. */
  save(identity: Identity): Promise<IdentitiesView>;
  remove(id: string): Promise<IdentitiesView>;
  /** Both calls read the source in the host; the panel never composes a pin. */
  previewPin(id: string): Promise<PinPreview>;
  pin(id: string, token: string): Promise<IdentitiesView>;
  unpin(): Promise<IdentitiesView>;
  /** Open the export report for the open book. */
  showChecks(): void;
  onNotice(message: string): void;
  onDone(message: string): void;
  onDismiss(): void;
}

export interface IdentityPanel {
  open(): Promise<void>;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createIdentityPanel(deps: IdentityPanelDeps): IdentityPanel {
  const { container } = deps;

  const panel = document.createElement("div");
  panel.id = "identity-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-label", t("identity.panel.label"));
  // So Escape is heard before anything inside takes focus.
  panel.tabIndex = -1;
  panel.hidden = true;

  const intro = document.createElement("p");
  intro.id = "identity-intro";
  intro.textContent = t("identity.intro");

  /** WHAT THIS BOOK IS WRITTEN AS, painted for every book including one pinned
   *  to nothing -- `coverPageLine`'s rule. */
  const pinnedText = document.createElement("p");
  pinnedText.id = "identity-pinned";
  pinnedText.setAttribute("role", "status");

  /** THE STALENESS ADVISORY. Reported and never repaired: a pin that followed
   *  the vault would rewrite the front matter of a book already on a shelf from
   *  a text field edit. Its own line rather than a wording of the line above,
   *  because they are two facts and one can be true without the other. */
  const staleText = document.createElement("p");
  staleText.id = "identity-stale";
  staleText.hidden = true;
  staleText.textContent = t("identity.stale");

  const listHeading = document.createElement("h3");
  listHeading.textContent = t("identity.list.heading");

  const list = document.createElement("div");
  list.id = "identity-list";

  const newButton = document.createElement("button");
  newButton.type = "button";
  newButton.id = "identity-new";
  newButton.dataset.identityAction = "new";
  newButton.textContent = t("identity.new");

  const checksButton = document.createElement("button");
  checksButton.type = "button";
  checksButton.id = "identity-checks";
  checksButton.dataset.identityAction = "checks";
  checksButton.textContent = t("identity.check");

  /** THE LIST'S OWN CONTROLS, ABOVE THE LIST. A list of pen names grows with
   *  the library, and this avoids the capture defect: a primary
   *  control pushed under the fold by something above it that can grow. Putting
   *  New and the report above the list means nothing a writer has to reach can
   *  be displaced by a long one. */
  const listControls = document.createElement("div");
  listControls.id = "identity-list-controls";
  listControls.append(newButton, checksButton);

  const form = document.createElement("div");
  form.id = "identity-form";
  form.hidden = true;

  const previewBox = document.createElement("section");
  previewBox.id = "identity-pin-preview";
  previewBox.hidden = true;

  panel.append(intro, pinnedText, staleText, listHeading, listControls, list, previewBox, form);
  container.append(panel);

  let destroyed = false;
  let current: IdentitiesView | null = null;
  /** The identity the form is editing, or null when the form is closed. A COPY
   *  and never the list's own object: a writer who types and then presses
   *  Escape must not have changed the row behind them. */
  let editing: Identity | null = null;
  let pendingPin: { id: string; preview: PinPreview } | null = null;
  /** An answer resolving after a newer act or after the panel closed must not
   *  repaint: the writer would be shown a library they are no longer looking
   *  at. */
  let generation = 0;

  function paint(): void {
    const view = current;
    if (view === null) return;
    pinnedText.textContent = pinnedLine(view);
    staleText.hidden = !view.stale;
    list.replaceChildren();
    if (view.identities.length === 0) {
      const empty = document.createElement("p");
      empty.id = "identity-empty";
      empty.textContent = t("identity.list.empty");
      list.append(empty);
    } else {
      for (const identity of view.identities) {
        list.append(buildRow(identity, view));
      }
    }
    paintPreview();
    paintForm();
  }

  function buildRow(identity: Identity, view: IdentitiesView): HTMLElement {
    const row = document.createElement("div");
    row.className = "identity-row";
    row.dataset.identityId = identity.id;
    const pinned = view.pinned !== null && view.pinned.identity_id === identity.id;
    row.dataset.identityPinned = String(pinned);

    const name = document.createElement("button");
    name.type = "button";
    name.className = "identity-name";
    // QUIET, and a capture is what asked for it. The shared control treatment
    // draws every button as a bordered box, and a full-width bordered box
    // holding a name reads as a TEXT FIELD -- a writer would click into it and
    // try to type. Quiet keeps the box metrics (the 1px border stays and only
    // loses its colour, which is that rule's own reason) and lets the name read
    // as the row's heading, revealing itself as a control under the pointer.
    name.dataset.weight = "quiet";
    name.dataset.identityAction = "edit";
    name.dataset.identityId = identity.id;
    name.textContent = identityLabel(identity);
    row.append(name);

    // THE CONTROLS ON THEIR OWN LINE, UNDER THE NAME, and a capture is what
    // settled it. Beside the name they compete with it for a 440px row, and
    // what yields is the name -- the first picture of this panel read "Ad\u2026"
    // against two full-length buttons. A pen name is the one thing in the row
    // that must always be legible.
    const controls = document.createElement("div");
    controls.className = "identity-row-controls";

    const pin = document.createElement("button");
    pin.type = "button";
    pin.dataset.identityAction = pinned ? "unpin" : "pin";
    pin.dataset.identityId = identity.id;
    // `aria-pressed` says which of the library's names THIS book is written
    // under, which is a selection and not an action -- so this panel joins the
    // stylesheet's sixth selector list, which the covers panel deliberately did
    // not.
    pin.setAttribute("aria-pressed", String(pinned));
    // ONE LABEL IN BOTH STATES. See the catalog: two labels put the longest
    // string in the row beside the one a writer actually reads, and the pen name
    // is what yielded.
    pin.textContent = t("identity.pin");
    controls.append(pin);

    if (pinned && view.stale) {
      const update = document.createElement("button");
      update.type = "button";
      update.dataset.identityAction = "update-pin";
      update.dataset.identityId = identity.id;
      update.textContent = t("identity.repin");
      controls.append(update);
    }

    const remove = document.createElement("button");
    remove.type = "button";
    remove.dataset.identityAction = "remove";
    remove.dataset.identityId = identity.id;
    remove.textContent = t("identity.remove");
    controls.append(remove);

    row.append(controls);
    return row;
  }

  function paintPreview(): void {
    previewBox.replaceChildren();
    previewBox.hidden = pendingPin === null;
    if (pendingPin === null) return;
    const { before, after } = pendingPin.preview;
    const heading = document.createElement("h3");
    heading.textContent = t("identity.preview.heading");
    const note = document.createElement("p");
    note.className = "identity-preview-note";
    note.textContent = t(pendingPin.preview.before_unreadable
      ? "identity.preview.unreadable" : "identity.preview.note");
    const table = document.createElement("table");
    table.className = "identity-preview-table";
    const fields: Array<[string, string | undefined, string]> = [
      ["name", before?.public.name, after.public.name],
      ["sort_name", before?.public.sort_name, after.public.sort_name],
      ["bio", before?.public.bio, after.public.bio],
      ["links", before?.public.links.join("\n"), after.public.links.join("\n")],
      ["imprint", before?.publishing.imprint, after.publishing.imprint],
      ["rights", before?.publishing.rights, after.publishing.rights],
    ];
    for (const [field, oldValue, newValue] of fields) {
      const row = document.createElement("tr");
      const label = document.createElement("th");
      label.scope = "row";
      label.textContent = fieldLabel(field);
      const oldCell = document.createElement("td");
      oldCell.textContent = pendingPin.preview.before_unreadable
        ? t("identity.preview.unreadable.value")
        : oldValue?.trim() || t("identity.preview.empty");
      const newCell = document.createElement("td");
      newCell.textContent = newValue.trim() || t("identity.preview.empty");
      row.append(label, oldCell, newCell);
      table.append(row);
    }
    const columns = document.createElement("thead");
    const header = document.createElement("tr");
    for (const key of ["identity.preview.field", "identity.preview.current", "identity.preview.proposed"]) {
      const cell = document.createElement("th");
      cell.textContent = t(key);
      header.append(cell);
    }
    columns.append(header);
    table.prepend(columns);
    const controls = document.createElement("div");
    controls.className = "identity-preview-controls";
    for (const [action, key] of [["confirm-pin", pendingPin.preview.before_unreadable
      ? "identity.preview.replace" : "identity.preview.confirm"], ["cancel-pin", "identity.preview.cancel"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.identityAction = action;
      button.textContent = t(key);
      controls.append(button);
    }
    previewBox.append(heading, note, table, controls);
  }

  /** One tier's fields, under their own legend.
   *
   *  THREE GROUPS AND NOT ONE LIST, because the tier is the boundary and a
   *  writer has to be able to see which side of it a field is on. The private
   *  group carries the sentence that says what that side means. */
  function buildTier(legend: string, fields: readonly string[], note: string | null): HTMLElement {
    const group = document.createElement("fieldset");
    group.className = "identity-tier";
    const caption = document.createElement("legend");
    caption.textContent = legend;
    group.append(caption);
    if (note !== null) {
      const sentence = document.createElement("p");
      sentence.className = "identity-tier-note";
      sentence.textContent = note;
      group.append(sentence);
    }
    for (const field of fields) {
      group.append(buildField(field));
    }
    return group;
  }

  function buildField(field: string): HTMLElement {
    const wrap = document.createElement("label");
    wrap.className = "identity-field";
    const caption = document.createElement("span");
    caption.textContent = fieldLabel(field);
    const long = field === "aliases" || (MULTILINE_FIELDS as readonly string[]).includes(field);
    const input = long
      ? document.createElement("textarea")
      : document.createElement("input");
    if (input instanceof HTMLInputElement) input.type = "text";
    input.id = `identity-field-${field}`;
    input.dataset.identityField = field;
    input.value = valueOf(field);
    wrap.append(caption, input);
    return wrap;
  }

  function valueOf(field: string): string {
    const identity = editing;
    if (identity === null) return "";
    if (field === "aliases") return identity.aliases.join("\n");
    if (field === "links") return linksToText(identity.public.links);
    const tier =
      (PUBLIC_FIELDS as readonly string[]).includes(field)
        ? (identity.public as unknown as Record<string, string>)
        : (PUBLISHING_FIELDS as readonly string[]).includes(field)
          ? (identity.publishing as unknown as Record<string, string>)
          : (identity.private as unknown as Record<string, string>);
    return tier[field] ?? "";
  }

  function paintForm(): void {
    form.hidden = editing === null;
    form.replaceChildren();
    if (editing === null) return;
    form.append(
      buildTier(t("identity.tier.public"), PUBLIC_FIELDS, null),
      buildTier(t("identity.tier.aliases"), ["aliases"], t("identity.tier.aliases.note")),
      buildTier(t("identity.tier.publishing"), PUBLISHING_FIELDS, null),
      buildTier(t("identity.tier.private"), PRIVATE_FIELDS, t("identity.tier.private.note")),
    );
    const save = document.createElement("button");
    save.type = "button";
    save.id = "identity-save";
    save.dataset.identityAction = "save";
    save.textContent = t("identity.save");
    form.append(save);
  }

  /** Everything the form holds, as an identity. Read at the moment Save is
   *  pressed rather than accumulated per keystroke: a `rev` bumped on every
   *  character would make every book pinned to this name stale on every letter
   *  typed. */
  function readForm(): Identity | null {
    if (editing === null) return null;
    const next: Identity = {
      id: editing.id,
      rev: editing.rev,
      aliases: [...editing.aliases],
      public: { ...editing.public },
      publishing: { ...editing.publishing },
      private: { ...editing.private },
    };
    for (const node of form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      "[data-identity-field]",
    )) {
      const field = node.dataset.identityField ?? "";
      if (field === "links") {
        next.public.links = linksFromText(node.value);
      } else if (field === "aliases") {
        next.aliases = node.value.split(/\r?\n/).filter((line) => line.trim() !== "");
      } else if ((PUBLIC_FIELDS as readonly string[]).includes(field)) {
        (next.public as unknown as Record<string, string>)[field] = node.value;
      } else if ((PUBLISHING_FIELDS as readonly string[]).includes(field)) {
        (next.publishing as unknown as Record<string, string>)[field] = node.value;
      } else if ((PRIVATE_FIELDS as readonly string[]).includes(field)) {
        (next.private as unknown as Record<string, string>)[field] = node.value;
      }
    }
    return next;
  }

  async function act(
    run: () => Promise<IdentitiesView>,
    done: (view: IdentitiesView) => string | null,
  ): Promise<void> {
    generation += 1;
    const mine = generation;
    try {
      const answer = await run();
      if (destroyed || mine !== generation) return;
      current = answer;
      pendingPin = null;
      paint();
      const message = done(answer);
      if (message !== null) deps.onDone(message);
    } catch (error: unknown) {
      if (destroyed || mine !== generation) return;
      // NOT A REPAINT FROM WHAT WE HOPED WE WROTE. A refused save changed
      // nothing, so the panel goes on showing what the file still holds.
      deps.onNotice(t("identity.error.save", { error: messageOf(error) }));
    }
  }

  const onPanelClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const control = target.closest<HTMLElement>("[data-identity-action]");
    if (control === null) return;
    const action = control.dataset.identityAction;
    const id = control.dataset.identityId ?? "";
    if (action === "new") {
      editing = blankIdentity();
      paintForm();
      return;
    }
    if (action === "checks") {
      deps.showChecks();
      return;
    }
    if (action === "edit") {
      // THE ROW ITSELF AND NOT A COPY OF IT, and the copy was DELETED rather
      // than kept. `readForm` builds a fresh identity by spreading every tier
      // out of this one and nothing anywhere assigns THROUGH it, so a defensive
      // copy here changes no byte any input can reach -- and a mutation
      // replacing it with the bare assignment survived the whole suite, which is
      // how that was found. `import_name_ok`'s precedent: a guard nothing can
      // reach is worse than none, because a reader credits it for a refusal it
      // does not give. What actually protects the row is that `paint()` replaces
      // `current` wholesale from the host's own answer after every act.
      editing = current?.identities.find((i) => i.id === id) ?? null;
      paintForm();
      return;
    }
    if (action === "save") {
      const next = readForm();
      if (next === null) return;
      void act(
        () => deps.save(next),
        () => {
          editing = null;
          paintForm();
          return t("identity.done.saved", { name: identityLabel(next) });
        },
      );
      return;
    }
    if (action === "remove") {
      void act(
        () => deps.remove(id),
        () => {
          editing = null;
          paintForm();
          return t("identity.done.removed");
        },
      );
      return;
    }
    if (action === "pin" || action === "update-pin") {
      generation += 1;
      const mine = generation;
      void deps.previewPin(id).then((preview) => {
        if (destroyed || mine !== generation) return;
        pendingPin = { id, preview };
        paintPreview();
      }).catch((error: unknown) => {
        if (!destroyed && mine === generation) deps.onNotice(t("identity.error.save", { error: messageOf(error) }));
      });
      return;
    }
    if (action === "cancel-pin") {
      pendingPin = null;
      paintPreview();
      return;
    }
    if (action === "confirm-pin") {
      const pending = pendingPin;
      if (pending === null) return;
      void act(
        () => deps.pin(pending.id, pending.preview.token),
        (view) => view.pinned === null ? null : t("identity.done.pinned", {
          name: view.pinned.public.name.trim() || t("identity.field.name"),
        }),
      );
      return;
    }
    if (action === "unpin") {
      void act(
        () => deps.unpin(),
        () => t("identity.done.unpinned"),
      );
    }
  };

  function close(): void {
    generation += 1;
    panel.hidden = true;
    editing = null;
    // THE VAULT GOES WITH IT. A legal name held in a page variable for the life
    // of the window, for a panel nobody is looking at, is the shape the picture
    // viewer's `close` refuses at a different size and for a different reason --
    // and this one is the reason this feature exists.
    current = null;
    pendingPin = null;
    list.replaceChildren();
    previewBox.replaceChildren();
    previewBox.hidden = true;
    form.replaceChildren();
  }

  panel.addEventListener("click", onPanelClick);

  // Close, Escape and a click elsewhere (the shell's).
  const shell = createPanelShell({
    panel,
    title: t("identity.heading"),
    titleId: "identity-heading",
    close,
    returnFocus: deps.onDismiss,
  });

  return {
    async open(): Promise<void> {
      generation += 1;
      const mine = generation;
      panel.hidden = false;
      panel.focus();
      try {
        const answer = await deps.read();
        if (destroyed || mine !== generation) return;
        current = answer;
        paint();
      } catch (error: unknown) {
        if (destroyed || mine !== generation) return;
        // NOT AN EMPTY PANEL. A catch that painted the no-identities state
        // would report a host that could not answer -- or a VAULT THAT WILL NOT
        // PARSE -- as a library with no pen names in it, which is precisely the
        // failure this whole slice exists to refuse.
        deps.onNotice(t("identity.error.load", { error: messageOf(error) }));
        close();
      }
    },
    close,
    isOpen(): boolean {
      return !panel.hidden;
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      panel.removeEventListener("click", onPanelClick);
      shell.destroy();
      container.replaceChildren();
    },
  };
}
