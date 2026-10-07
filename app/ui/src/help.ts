// app/ui/src/help.ts
// Offline writing guidance and keyboard shortcuts, opened from Help.
//
// THIS FILE RESTATES BINDINGS IT DOES NOT OWN, and that is the whole hazard.
// The chords live in four other places -- the editor's keymap (editor.ts), the
// find bar's document handler, the navigator's keydown listener, and the menu
// bar's Alt+<key> handler -- and none of them can be imported for their key
// strings, because in each case the string is an argument to a call and not a
// value the module exports.
//
// So a shortcut that changes there and not here leaves this panel confidently
// telling a writer a lie, and NOTHING ELSE IN THE APPLICATION WOULD NOTICE:
// there is no rendering difference, no failing gate, and no screenshot that
// looks wrong. `help.test.ts` parses editor.ts's keymap and fails when a chord
// bound there is absent from this list. That covers the editor's four and NOT
// the other three, which are stated here and are not yet checked anywhere --
// recorded as a known gap rather than left to be discovered.

export interface ShortcutRow {
  keys: string;
  description: string;
}

/** Grouped only for reading. The groups carry no behaviour and no element of
 *  their own beyond a heading. */
export interface ShortcutGroup {
  title: string;
  rows: readonly ShortcutRow[];
}

export const SHORTCUTS: readonly ShortcutGroup[] = [
  {
    title: t("help.group.writing"),
    rows: [
      { keys: t("help.keys.undo"), description: t("help.undo") },
      { keys: t("help.keys.redo"), description: t("help.redo") },
      { keys: t("help.keys.italic"), description: t("help.italic") },
      { keys: t("help.keys.bold"), description: t("help.bold") },
      { keys: t("help.keys.underline"), description: t("help.underline") },
      // The chord Word and Google Docs both bind, so a writer arriving from
      // either already has it. It is in Writing rather than in a group of its
      // own because it acts on the prose the caret is in.
      { keys: t("help.keys.comment"), description: t("help.comment") },
      // with the caret inside a marked name, shows the same card a
      // hover does -- the keyboard route to a surface a pointer would
      // otherwise be the only way to reach.
      { keys: t("help.keys.cast-card"), description: t("help.cast-card") },
      { keys: t("help.keys.continuous"), description: t("continuous.boundary") },
    ],
  },
  {
    title: t("help.group.moving"),
    rows: [
      { keys: t("help.keys.quick-open"), description: t("help.quick-open") },
      { keys: t("help.keys.find"), description: t("help.find") },
      // inspector.ts binds it on the document, beside no other chord.
      { keys: t("help.keys.inspector"), description: t("help.inspector") },
      // The same two keys the Outline group binds below, and the panel says so
      // rather than leaving a writer to discover the collision. Which one you
      // get is decided by where the caret is: in the outline they reshape a row,
      // anywhere else they walk the scenes you have opened.
      { keys: t("help.keys.nav-history"), description: t("help.nav-history") },
      { keys: t("help.keys.up-down"), description: t("help.outline-select") },
      { keys: t("help.keys.open"), description: t("help.open") },
      { keys: t("help.keys.left-right"), description: t("help.collapse") },
      { keys: t("help.keys.home-end"), description: t("help.home-end") },
      { keys: t("help.keys.page"), description: t("help.page") },
      // The outline has had type-ahead since the navigator slice and has never
      // told anyone. It is the fastest way through a long manuscript and it was
      // undiscoverable: nothing in the application named it until this row.
      { keys: t("help.keys.type-ahead"), description: t("help.type-ahead") },
    ],
  },
  {
    title: t("help.group.find"),
    rows: [
      { keys: t("help.keys.up-down"), description: t("help.find.move") },
      { keys: t("help.keys.enter"), description: t("help.find.open") },
      { keys: t("help.keys.escape"), description: t("help.find.close") },
    ],
  },
  {
    title: t("help.group.outline"),
    rows: [
      { keys: t("help.keys.move-item"), description: t("help.move-item") },
      { keys: t("help.keys.nav-history"), description: t("help.indent") },
      { keys: t("help.keys.delete"), description: t("help.delete") },
      // The keyboard route to the context menu the pointer gets from a
      // right-click. Two chords, because Shift+F10 is the convention everywhere
      // and the Menu key is the dedicated one on keyboards that have it - and
      // an affordance a keyboard cannot reach is not an affordance in this
      // application.
      {
        keys: t("help.keys.context-menu"),
        description: t("help.context-menu"),
      },
      { keys: t("help.keys.enter"), description: t("help.rename") },
      // structural undo, above the modifier guard the same way Alt+Arrow
      // and Delete are, and named here rather than caught by the automatic
      // navigator scan the same way Shift+F10 is - that scan reads bare
      // `event.key` literals and this is a Ctrl chord.
      { keys: t("help.keys.outline-undo"), description: t("help.outline-undo") },
    ],
  },
  {
    title: t("help.group.menus"),
    rows: [
      { keys: t("help.keys.menu.file"), description: t("help.menu.file") },
      { keys: t("help.keys.menu.edit"), description: t("help.menu.edit") },
      { keys: t("help.keys.menu.outline"), description: t("help.menu.outline") },
      { keys: t("help.keys.menu.help"), description: t("help.menu.help") },
      // Reuses the File menu's own shortcut string rather than a second key
      // naming the identical chord -- application chrome, so it works
      // with nothing open, exactly like Alt+<key> above it.
      { keys: t("menu.shortcut.library"), description: t("help.library") },
      { keys: t("help.keys.export"), description: t("help.export") },
      { keys: t("help.keys.escape"), description: t("help.menu.close") },
      // In Menus rather than in a group of its own: the File menu is where
      // the item lives, and a one-row group for leaving reads as a warning.
      { keys: t("privacy.shortcut"), description: t("privacy.lock") },
      { keys: t("help.keys.quit"), description: t("help.quit") },
    ],
  },
];

export interface HelpPanelDeps {
  onDismiss?: () => void;
  privacyShortcut?: () => import("./privacy").PrivacyShortcut;
  /** Where the panel is appended. The menu bar's own container, so the panel is
   *  inside the element whose click-outside handler closes the menu -- a writer
   *  clicking inside the help panel must not have it taken away. */
  container: HTMLElement;
}

export interface HelpPanel {
  open(): void;
  close(): void;
  destroy(): void;
}

import { t } from "./i18n";
import { privacyShortcutLabel } from "./privacy";
import { createPanelShell } from "./panel-shell";

export function createHelpPanel(deps: HelpPanelDeps): HelpPanel {
  const panel = document.createElement("div");
  panel.id = "help-panel";
  panel.setAttribute("role", "dialog");
  // Nothing here traps focus, and aria-modal="true" would tell a screen reader
  // the rest of the page is inert when it is not. Same call as every other
  // panel in this application.
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-label", t("help.heading"));
  panel.hidden = true;
  // Focusable so open() has somewhere to put the caret, but not a tab stop:
  // Tab should leave the panel, not cycle its rows, which are not interactive.
  panel.tabIndex = -1;

  const guide = document.createElement("section");
  guide.id = "help-guide";
  const guideTitle = document.createElement("h3");
  guideTitle.textContent = t("help.guide.heading");
  guide.append(guideTitle);
  for (const task of ["structure", "annotate", "export", "protect"] as const) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.setAttribute("role", "button");
    summary.textContent = t(`help.guide.${task}.title`);
    const text = document.createElement("p");
    text.textContent = t(`help.guide.${task}.body`);
    details.append(summary, text);
    guide.append(details);
  }
  const shortcutsTitle = document.createElement("h3");
  shortcutsTitle.textContent = t("help.shortcuts.heading");
  panel.append(guide, shortcutsTitle);

  // The groups flow in two columns inside their own box. The columns
  // used to be on the panel itself, which also has a max-height, and a
  // multicol box with a constrained height does not scroll: it spawns a third
  // column sideways, and the last group (Menus) sat there, off-screen.
  const columns = document.createElement("div");
  columns.id = "help-columns";
  panel.append(columns);

  let privacyKeys: HTMLElement | undefined;
  for (const group of SHORTCUTS) {
    const section = document.createElement("div");
    section.className = "help-section";
    const title = document.createElement("div");
    title.className = "help-group";
    title.textContent = group.title;
    section.append(title);

    // A definition list, because that is what this is: a term and its meaning.
    // A table would promise row and column semantics a screen reader would then
    // offer to navigate, over two columns where one is always the answer to the
    // other.
    const list = document.createElement("dl");
    list.className = "help-rows";
    for (const row of group.rows) {
      const keys = document.createElement("dt");
      keys.textContent = row.keys;
      if (row.description === t("privacy.lock")) privacyKeys = keys;
      const description = document.createElement("dd");
      description.textContent = row.description;
      list.append(keys, description);
    }
    section.append(list);
    columns.append(section);
  }

  function close(): void {
    panel.hidden = true;
  }

  // THE FIFTH PANEL, and it was the one missed when the other four got this.
  // Escape only fires while focus is inside the panel, so a writer who opened
  // the shortcuts, clicked into their prose to try one, and pressed Escape was
  // sending it to the editor - and the panel stayed over the page with no way
  // out short of working out that Alt+H, Return, Escape re-focuses and closes
  // it. Reading a shortcut and then trying it is the whole point of the panel,
  // so that is the ordinary path, not an edge of one. The shell's three
  // dismissals (Close, Escape, a click elsewhere) cover all of it.
  const shell = createPanelShell({ panel, title: t("help.heading"), titleId: "help-heading", close, returnFocus: deps.onDismiss });

  deps.container.append(panel);

  let destroyed = false;
  return {
    open(): void {
      if (privacyKeys) privacyKeys.textContent = privacyShortcutLabel(deps.privacyShortcut?.() ?? "ctrl_alt_l") || t("privacy.shortcut.off");
      panel.hidden = false;
      panel.focus();
    },
    close,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      // Its outside-click listener is on the DOCUMENT, so it outlives this element.
      shell.destroy();
      panel.remove();
    },
  };
}
