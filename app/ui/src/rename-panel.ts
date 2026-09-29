// app/ui/src/rename-panel.ts
// Renaming a part, chapter or scene: one field, in a panel of its own.
//
// A PANEL, NOT AN INLINE EDIT ON THE ROW, and that is a decision rather than an
// omission. The navigator is virtualized: it unmounts any row that scrolls out
// of range, and it calls scrollToIndex on selection. An <input> living on a row
// would therefore be removed from the DOM mid-edit, discarding whatever had been
// typed, with no error and nothing to notice. Exempting an edited row from
// unmounting means new rendering state in the one component whose windowing
// invariants the accessibility gates rest on. Do not "improve" this into one.
//
// It used to be a field in the outline bar, which is the same decision with a
// worse home: `#rename-field` was `flex: 1 1 auto` against five 13px buttons
// filling 8..311px of the 320px navigator column, so it opened as an 8px sliver
// the writer could not read what they were typing in. It shipped that way for
// several slices, and `outline_rename_persists` passed throughout, because a rig
// types into the field by keyboard and a focused input does not have to be
// VISIBLE to accept text. A rig typing blind cannot see that the writer is too.
// The bar is retired; the field gets room.
//
// THE ROW IS CAPTURED AT OPEN AND NEVER RE-READ. Same rule as the navigator's
// context menu, same reason: a rename must land on the row the writer was
// looking at when they typed the title, even if something moved the selection
// while the field was open.
//
// The panel decides nothing about the manuscript. It does not check whether a
// title changed, whether it is blank, or which row is selected - the outline
// unit and its callers already own all three, and two places deciding the same
// thing is how they drift.
import { isCompositionKey } from "./composition-key";
import { t } from "./i18n";
import { createPanelShell } from "./panel-shell";

export interface RenamePanelDeps {
  /** The bar anchor from index.html. The panel is positioned absolutely against
   *  #project-bar, exactly as #find-panel and #quick-open-panel are, so it
   *  contributes nothing to the strip's line box. */
  container: HTMLElement;
  rename: (id: string, title: string) => Promise<unknown>;
  /** Where focus goes when the panel closes, whether it committed or not.
   *
   *  The navigator is an `aria-activedescendant` surface: DOM focus lives on
   *  #nav and the "focused row" is the one aria-activedescendant names. So this
   *  focuses the CONTAINER - a row element is not a tab stop and `.focus()` on
   *  it is a no-op that drops focus to <body>, a recorded defect this
   *  exists to avoid rather than repeat. */
  returnFocus: () => void;
}

export interface RenamePanel {
  /** Open against a NAMED row, prefilled with what it is currently called.
   *
   *  It takes the title as well as the id rather than looking one up: this unit
   *  holds no walk, and the caller that knows which row it is about is the one
   *  that knows what it is called. Both callers - the Outline menu, which reads
   *  the selection, and the navigator's context menu, which reads the row it
   *  opened on - answer that question differently and neither answer belongs
   *  here. */
  open(id: string, title: string): void;
  destroy(): void;
}

export function createRenamePanel(deps: RenamePanelDeps): RenamePanel {
  const { container } = deps;
  container.replaceChildren();

  const panel = document.createElement("div");
  panel.id = "rename-panel";
  panel.setAttribute("role", "dialog");
  // Nothing here traps focus, and aria-modal="true" would tell a screen reader
  // the rest of the page is inert when it is not. Same as the find panel.
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-label", t("rename.panel.label"));
  panel.hidden = true;

  const field = document.createElement("input");
  field.id = "rename-field";
  field.type = "text";
  // No visible label exists to point at, so the name has to be authored. The
  // string is unchanged from the outline bar's field: it is the accessible name
  // a graded rig compares against a literal.
  field.setAttribute("aria-label", t("rename.field.label"));

  const commit = document.createElement("button");
  commit.id = "rename-commit";
  // The panel's reason for existing, so it is the one filled control on it.
  // Styling only: a weight changes background and border-colour and nothing that
  // has a size, which control-weight.test.ts checks against the stylesheet.
  commit.dataset.weight = "primary";
  // Without this a button inside a form submits it.
  commit.type = "button";
  commit.textContent = t("rename.commit");

  panel.append(field, commit);
  container.append(panel);

  // The id the panel was opened against, not the current selection. Null
  // whenever the panel is closed, so a commit can never fire against a row a
  // previous open captured.
  let renaming: string | null = null;

  function close(): void {
    renaming = null;
    panel.hidden = true;
    field.value = "";
  }

  /** Close, hand the keyboard back, and only then ask for the rename.
   *
   *  In that order: the outline unit re-reads the whole walk and repaints the
   *  navigator when it answers, and the control that was pressed is inside a
   *  panel this is about to hide. Focus has to have somewhere to be before
   *  either happens. */
  function commitRename(): void {
    const id = renaming;
    const title = field.value;
    close();
    deps.returnFocus();
    // Nothing captured is not an error - there is simply no row to name. Only
    // reachable through a commit on a closed panel, which nothing can do.
    if (id === null) return;
    // Swallowed, not reported: the outline unit turns a failure into a banner of
    // its own, and a rejection escaping a synchronous handler would be
    // unhandled.
    void deps.rename(id, title).catch(() => undefined);
  }

  const onFieldKeyDown = (event: Event): void => {
    if (!(event instanceof KeyboardEvent) || isCompositionKey(event)) return;
    if (event.key !== "Enter") return;
    event.preventDefault();
    commitRename();
  };

  const onCommitClick = (): void => {
    commitRename();
  };

  field.addEventListener("keydown", onFieldKeyDown);
  commit.addEventListener("click", onCommitClick);
  // Close, Escape and a click elsewhere: the shell's three dismissals. The
  // click moves no focus; the other two hand it back to the navigator.
  const shell = createPanelShell({ panel, title: t("rename.title"), close, returnFocus: deps.returnFocus });

  let destroyed = false;
  return {
    open(id: string, title: string): void {
      renaming = id;
      // Read every time the panel opens. Prefilling once would show the title of
      // whatever happened to be renamed first for the rest of the session.
      field.value = title;
      panel.hidden = false;
      field.focus();
      // Selected, so typing replaces the old title rather than appending to it.
      // A writer renaming an item usually means to call it something else.
      field.select();
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      field.removeEventListener("keydown", onFieldKeyDown);
      commit.removeEventListener("click", onCommitClick);
      // THE ONE THAT MATTERS. Its outside-click listener is on the document, so
      // it outlives these elements and would accumulate one per project switch.
      shell.destroy();
      container.replaceChildren();
    },
  };
}
