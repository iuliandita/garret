// app/ui/src/pen-name-form.ts
// The library screen's inline "New pen name…" form.
//
// A SMALL MODULE OF ITS OWN, NOT `identity-panel.ts` REUSED: that panel
// captures a pin and runs the export preflight, both of which need an open
// book, and the library screen exists precisely because nothing is open. This
// form does one thing -- `identity_save` with an empty id, public tier only
// (name required, sort name and bio optional, links always empty) -- and its
// Save answer is what the screen repaints the strip from and selects.
import { t } from "./i18n";

export interface PenNameFields {
  name: string;
  sort_name: string;
  bio: string;
}

export interface PenNameFormDeps {
  /** The element the form is built into. Cleared and repopulated on every
   *  `open()`, mirroring `pen-name-form`'s own life: it exists only while the
   *  library screen's "New pen name…" button is in its pressed state. */
  container: HTMLElement;
  /** `identity_save` with an empty id and the public tier only. Resolves to
   *  the id the host minted. */
  save(fields: PenNameFields): Promise<string>;
  onNotice(message: string): void;
  onCreated(id: string): void;
  onCancel(): void;
}

export interface PenNameForm {
  open(): void;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function createPenNameForm(deps: PenNameFormDeps): PenNameForm {
  let open = false;
  let saving = false;
  let root: HTMLElement | null = null;

  /** One labelled field: a `<label>` holding a small text caption and the
   *  control, so the caption and its gap from the control are one flex
   *  column rather than two elements a stylesheet has to keep aligned by
   *  coincidence. */
  function field(labelText: string, control: HTMLInputElement | HTMLTextAreaElement): HTMLLabelElement {
    const label = document.createElement("label");
    label.className = "pen-name-field";
    const caption = document.createElement("span");
    caption.className = "pen-name-caption";
    caption.textContent = labelText;
    label.append(caption, control);
    return label;
  }

  function build(): HTMLElement {
    const form = document.createElement("div");
    form.id = "library-pen-name-form";

    const name = document.createElement("input");
    name.type = "text";
    name.id = "library-pen-name-name";
    const sortName = document.createElement("input");
    sortName.type = "text";
    sortName.id = "library-pen-name-sort-name";
    const sortNote = document.createElement("span");
    sortNote.id = "library-pen-name-sort-note";
    sortNote.className = "pen-name-caption";
    sortNote.textContent = t("library.pen-name.sort-note");
    sortName.setAttribute("aria-describedby", sortNote.id);
    // Name and sort name side by side -- two short fields on one line, with
    // a real gap between the caption and the control and between the two
    // fields, rather than three labels and two inputs run together with no
    // layout of their own.
    const row = document.createElement("div");
    row.className = "pen-name-row";
    const sortField = field(t("library.pen-name.sort-name"), sortName);
    sortField.firstElementChild?.setAttribute("id", "library-pen-name-sort-caption");
    sortName.setAttribute("aria-labelledby", "library-pen-name-sort-caption");
    sortField.append(sortNote);
    row.append(field(t("library.pen-name.name"), name), sortField);

    const bio = document.createElement("textarea");
    bio.id = "library-pen-name-bio";
    const bioField = field(t("library.pen-name.bio"), bio);
    bioField.classList.add("pen-name-field-wide");

    const saveButton = document.createElement("button");
    saveButton.type = "button";
    saveButton.id = "library-pen-name-save";
    saveButton.textContent = t("library.pen-name.save");
    saveButton.addEventListener("click", () => void onSave());

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.id = "library-pen-name-cancel";
    cancelButton.className = "pen-name-cancel";
    cancelButton.textContent = t("library.pen-name.cancel");
    cancelButton.addEventListener("click", () => deps.onCancel());

    // Right-aligned, Cancel before Save in reading order but Save closer to
    // the edge a writer's eye lands on last -- the same order the switcher's
    // own dialog-shaped controls use.
    const actions = document.createElement("div");
    actions.className = "pen-name-actions";
    actions.append(cancelButton, saveButton);

    async function onSave(): Promise<void> {
      if (saving) return;
      const typedName = name.value.trim();
      if (typedName === "") {
        name.focus();
        return;
      }
      saving = true;
      try {
        const id = await deps.save({
          name: typedName,
          sort_name: sortName.value.trim(),
          bio: bio.value.trim(),
        });
        deps.onCreated(id);
      } catch (error: unknown) {
        deps.onNotice(messageOf(error));
      } finally {
        saving = false;
      }
    }

    form.append(row, bioField, actions);
    return form;
  }

  return {
    open(): void {
      if (open) return;
      root = build();
      deps.container.append(root);
      open = true;
      const name = root.querySelector<HTMLInputElement>("#library-pen-name-name");
      name?.focus();
    },
    close(): void {
      root?.remove();
      root = null;
      open = false;
    },
    isOpen: () => open,
    destroy(): void {
      root?.remove();
      root = null;
      open = false;
    },
  };
}
