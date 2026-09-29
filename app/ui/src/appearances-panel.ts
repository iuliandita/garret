// app/ui/src/appearances-panel.ts
// Who appears in ONE part, chapter or scene.
//
// THE ROW IS CAPTURED AT OPEN AND NEVER RE-READ, which is the SYNOPSIS panel's
// rule and deliberately not the cast panel's. The design record settles it:
// this surface is about one row, the selection stays live behind it in the
// navigator (an arrow key still reaches it), and a save that read the selection
// at press time would put this chapter's cast onto whatever row the writer had
// wandered to. The capture is taken SYNCHRONOUSLY, before either read answers.
//
// A PART OR A CHAPTER CAN BE TAGGED DIRECTLY, and that is a decision rather
// than a consequence of the table permitting it. Two things settle it. The
// product spec makes the hierarchy ARBITRARY and forbids type-based
// constraints -- "a part inside a scene is legal and approved" -- so a panel
// that refused a chapter would be the first type constraint in this
// application, in a surface with no reason to hold one. And an outline-first
// writer names who a chapter is about before its scenes exist; refusing them
// means the answer to "who is in Chapter Four" is empty until the prose is
// written, which is exactly backwards for a planning surface. What it costs is
// that a container can claim somebody no scene under it supports, and the cost
// is paid in the map panel, which says which names are the row's own and which
// arrived from below.
//
// IT DECIDES NOTHING ABOUT THE STORE. It does not know that the record is
// replaced whole, that a duplicate is one row, or that an unknown member is
// refused by name. The store owns all three, and two places deciding one thing
// is how they drift.
import { t } from "./i18n";
import { createPanelShell } from "./panel-shell";
import { CAST_KINDS, groupKeyFor, kindIconFor } from "./cast-kinds";
import { createIcon } from "./icons";
import type { CastMemberRow } from "./cast-panel";

export interface AppearancesPanelDeps {
  /** The bar anchor from index.html. Positioned absolutely against
   *  #project-bar, so it contributes nothing to the strip's line box. */
  readonly container: HTMLElement;
  /** Everybody in the book, which is what there is to tick. */
  cast(): Promise<CastMemberRow[]>;
  /** Who the store says appears on this row. */
  read(itemId: string): Promise<readonly string[]>;
  /** Replace the whole record. An empty list is a real instruction -- it is how
   *  the last tag comes off -- and is the only way back from having tagged. */
  write(itemId: string, memberIds: string[]): Promise<void>;
  /** Good news. Its own channel, never the failure banner. */
  onDone(message: string): void;
  onNotice(message: string): void;
  /** Where focus goes when the panel is dismissed with Escape. Not called for
   *  an outside click: a click already says where the writer wants to be. */
  onDismiss(): void;
}

export interface AppearancesPanel {
  /** Open against a NAMED row, prefilled with what the store holds.
   *
   *  Takes the title as well as the id, exactly as the synopsis and rename
   *  panels do and for the same reason: this unit holds no walk, and the caller
   *  that knows which row it is about is the one that knows what it is
   *  called. */
  open(itemId: string, title: string): Promise<void>;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
}

export function createAppearancesPanel(deps: AppearancesPanelDeps): AppearancesPanel {
  const { container } = deps;

  const panel = document.createElement("div");
  panel.id = "appears-panel";
  panel.setAttribute("role", "dialog");
  // Nothing here traps focus and nothing behind it is inert, so claiming modal
  // would be a lie a screen reader acts on.
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-label", t("appears.panel.label"));
  // So Escape is heard even before anything inside takes focus. The recorded
  // failure of the fifth panel is one a writer could not dismiss at all.
  panel.tabIndex = -1;
  panel.hidden = true;

  /** WHICH ROW THIS IS ABOUT. Without it the writer has a list of names over
   *  their manuscript and nothing saying what it belongs to. */
  const status = document.createElement("div");
  status.id = "appears-status";
  status.setAttribute("role", "status");

  const list = document.createElement("div");
  list.id = "appears-list";
  // NAMED, so the boxes under it are not a flat run of checkboxes to a screen
  // reader. Each KIND gets its own named group inside, exactly as the cast
  // panel's entries do.
  list.setAttribute("role", "group");
  list.setAttribute("aria-label", t("appears.list.label"));

  const saveButton = document.createElement("button");
  saveButton.id = "appears-save";
  // Without this a button inside a form submits it.
  saveButton.type = "button";
  saveButton.textContent = t("appears.save");
  // The panel's reason for existing, so it is the one filled control on it.
  saveButton.dataset.weight = "primary";

  panel.append(status, list, saveButton);
  container.append(panel);

  /** The row the panel was OPENED against. Null while it is closed, so a save
   *  can never fire against a row a previous open captured. */
  let editing: { id: string; title: string } | null = null;
  let destroyed = false;
  /** An answer that resolves after a newer open, or after the panel closed,
   *  must not repaint or report: the writer would be told about a row they are
   *  no longer looking at. */
  let generation = 0;

  function setOpen(open: boolean): void {
    panel.hidden = !open;
  }

  function close(): void {
    // A CLOSE BUMPS THE GENERATION, so a read still in flight cannot paint into
    // a panel the writer has already dismissed.
    generation += 1;
    editing = null;
    setOpen(false);
    list.replaceChildren();
    status.textContent = "";
  }

  /** Which boxes are ticked, in the order the list paints them -- which is the
   *  cast's own order, not the order the writer ticked. A set has no order to
   *  preserve and the store sorts what it stores. */
  function ticked(): string[] {
    return [...list.querySelectorAll<HTMLInputElement>("input[type='checkbox']")]
      .filter((box) => box.checked)
      .map((box) => box.value);
  }

  /** Paint one checkbox per cast member, grouped by kind.
   *
   *  A KIND NOBODY HAS AN ENTRY IN GETS NO HEADING, which is the cast panel's
   *  rule: an empty heading is a promise of rows that are not there. */
  function paint(members: readonly CastMemberRow[], held: readonly string[]): void {
    list.replaceChildren();
    if (members.length === 0) {
      // NOT AN EMPTY LIST OF BOXES. Tagging is impossible before there is
      // anybody to tag, and a panel painting nothing is indistinguishable from
      // one that failed to paint -- the recorded `renderProjects` defect. The
      // sentence names the route out.
      const empty = document.createElement("p");
      empty.className = "appears-empty";
      empty.textContent = t("appears.empty-cast");
      list.append(empty);
      // SAVE IS NOT THERE, RATHER THAN THERE AND DISABLED, and a capture is
      // what settled it: the first picture of this state showed the sentence
      // with a Save button under it, which reads as an action the writer could
      // take on a panel that has nothing to act on. It is the cast panel's own
      // recorded rule for its picture block -- "a Remove button that is
      // disabled whenever there is nothing to remove is a control a writer has
      // to learn does nothing" -- and this is the same control in the same
      // panel family. Twelfth defect found by looking.
      return;
    }
    saveButton.hidden = false;
    const on = new Set(held);
    for (const kind of CAST_KINDS) {
      const mine = members.filter((m) => m.kind === kind);
      if (mine.length === 0) continue;
      const key = groupKeyFor(kind);
      const group = document.createElement("div");
      group.className = "appears-group";
      group.dataset.kind = kind;
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", key === null ? kind : t(key));
      const title = document.createElement("h3");
      title.className = "appears-group-title";
      title.textContent = key === null ? kind : t(key);
      group.append(title);
      for (const member of mine) {
        const row = document.createElement("label");
        row.className = "appears-row";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.className = "appears-box";
        box.value = member.id;
        box.checked = on.has(member.id);
        // THE GLYPH, `aria-hidden` on this
        // panel's own list: the label's accessible name stays the plain
        // member name -- the text node below and nothing else --
        // `createIcon`'s own `aria-hidden` `<svg>` repeated on its wrapper
        // for the cast panel's own belt-and-braces reason.
        //
        // THE SPAN ITSELF IS OMITTED for a kind this build cannot draw a
        // glyph for, rather than appended empty: `.appears-row` is a flex
        // row with its own `gap`, and an empty `<span>` is still a flex item
        // that charges it -- 8px of the row's own width for a glyph that was
        // never drawn.
        const iconName = kindIconFor(member.kind);
        row.append(box);
        if (iconName !== null) {
          const icon = document.createElement("span");
          icon.className = "appears-box-icon";
          icon.setAttribute("aria-hidden", "true");
          icon.append(createIcon(iconName));
          row.append(icon);
        }
        // The NAME is the label's own text, so the accessible name comes from
        // content and there is no second string to drift from what is drawn.
        row.append(document.createTextNode(member.name));
        group.append(row);
      }
      list.append(group);
    }
  }

  function commit(): void {
    const row = editing;
    // Unreachable through the shipped path - the button lives inside a panel
    // that is hidden whenever nothing is captured - so this is the recorded
    // "reachable only if something moved between paint and click" case rather
    // than a guard. Silence is right here: there is no row to name.
    if (row === null) return;
    const chosen = ticked();
    generation += 1;
    const mine = generation;
    void deps
      .write(row.id, chosen)
      .then(() => {
        if (destroyed || mine !== generation) return;
        close();
        deps.onDone(
          chosen.length === 0
            ? t("appears.done.cleared", { title: row.title })
            : t("appears.done.saved", { title: row.title }),
        );
      })
      .catch((err: unknown) => {
        if (destroyed || mine !== generation) return;
        // LEFT OPEN, with the boxes as the writer left them. Closing would take
        // their unsaved choice off the screen at the moment they are told the
        // save did not land.
        deps.onNotice(t("appears.error.write", { error: String(err) }));
      });
  }

  const onSaveClick = (): void => commit();

  saveButton.addEventListener("click", onSaveClick);
  // Close, Escape and a click elsewhere (the shell's). The click moves no
  // focus; Close and Escape hand it back.
  const shell = createPanelShell({
    panel,
    title: t("appears.heading"),
    titleId: "appears-heading",
    close,
    returnFocus: deps.onDismiss,
    inspector: true,
  });

  return {
    async open(itemId: string, title: string): Promise<void> {
      // CAPTURED SYNCHRONOUSLY, before either read is even started. See the
      // header: the navigator's selection is live behind this panel.
      editing = { id: itemId, title };
      generation += 1;
      const mine = generation;
      // Painted BEFORE the reads resolve, so the panel names its row from the
      // moment it appears rather than after two round trips.
      status.textContent = t("appears.about", { title });
      list.replaceChildren();
      // HIDDEN UNTIL THERE IS A CAST TO SAVE, which is also what keeps an
      // unread store from being written over: only `paint` brings it back, and
      // the failure path below never reaches `paint`.
      saveButton.hidden = true;
      setOpen(true);
      panel.focus();
      let members: CastMemberRow[];
      let held: readonly string[];
      try {
        // TOGETHER, not one after the other: they are independent reads and the
        // panel cannot paint until it has both, so serialising them would cost
        // the writer two round trips to see one list.
        [members, held] = await Promise.all([deps.cast(), deps.read(itemId)]);
      } catch (err) {
        if (destroyed || mine !== generation) return;
        // NOT the designed empty state. A `catch` that painted "this book has
        // nobody in it yet" would report a store this panel could not read as a
        // book with no cast, and the writer would go and add everybody again --
        // the recorded `renderImports([])` defect.
        //
        // SAVE IS NOT HIDDEN AGAIN HERE, and its absence is deliberate rather
        // than an omission: `open` hides it before the reads start and only
        // `paint` brings it back, so a second statement of it on this path is a
        // line no input can falsify -- and a mutation deleting the earlier
        // version of it survived the whole suite, which is how that was found.
        // The `import_name_ok` precedent: a guard nothing can reach is worse
        // than none, because a reader credits it for the refusal. The PROPERTY
        // is still asserted by the test; what is gone is the second statement.
        status.textContent = t("appears.about", { title });
        deps.onNotice(t("appears.error.read", { error: String(err) }));
        return;
      }
      if (destroyed || mine !== generation) return;
      // Read on every open, never held: the panel outlives any number of opens
      // and a prefill from a held value would show whatever was ticked first
      // for the rest of the session.
      paint(members, held);
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
      saveButton.removeEventListener("click", onSaveClick);
      panel.remove();
    },
  };
}
