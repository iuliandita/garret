/** How many Shift+Tabs reach a version row's Restore button.
 *
 *  `history-cli` opens the panel with focus on `#snapshot-name` and walks
 *  BACKWARDS into the version list, because that costs no AT-SPI walk and
 *  several walks in one window kill the application. What it needs to know is
 *  how many focusable controls a version row puts after Restore.
 *
 *  That number was a literal `1` -- correct until the comparison slice appended
 *  a Compare button to every row, after which one Shift+Tab landed on Compare,
 *  Return opened a diff, and three restore gates FAILed reporting an
 *  application that was behaving perfectly. Exactly the `FILE_EXPORT_INDEX = 3`
 *  failure `menu-drive.ts` was written to end, one file over.
 *
 *  So it is not restated here either: it is READ from `app/ui/src/history.ts`,
 *  the one place a row's controls are actually decided. A parse can only
 *  promise the keystroke count matches the source -- the rig still has to check
 *  the EFFECT, which is why the restore gates read the store and not the panel.
 */
import { readFileSync } from "node:fs";

/** The row builder's own append call, e.g.
 *  `el.append(when, words, delta, restore, compare);` */
const APPEND = /\bel\.append\(([^)]*)\)/g;
/** `const compare = document.createElement("button")` -- which of the appended
 *  names are focusable. A span or a div is neither a tab stop nor a control. */
const BUTTON = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*document\.createElement\(\s*"button"\s*\)/g;

export interface RowControls {
  /** Every appended name, in paint order. */
  readonly appended: readonly string[];
  /** Those of them that are buttons, in paint order. */
  readonly buttons: readonly string[];
  /** Shift+Tab presses from the control immediately after the list to reach
   *  Restore: one for Restore itself, plus one per button painted after it. */
  readonly shiftTabsToRestore: number;
}

export function parseVersionRowControls(sourcePath = "app/ui/src/history.ts"): RowControls {
  const source = readFileSync(sourcePath, "utf8");

  const buttons = new Set<string>();
  for (const match of source.matchAll(BUTTON)) buttons.add(match[1]!);
  if (buttons.size === 0) {
    throw new Error(`${sourcePath}: no button is created here at all; the panel's shape changed`);
  }

  // The file has more than one `el.append` -- the snapshot rows build one too.
  // The version row is the one that appends `restore`, and it is the only place
  // in the panel a Restore button is painted.
  const candidates: string[][] = [];
  for (const match of source.matchAll(APPEND)) {
    const names = match[1]!
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name !== "");
    if (names.includes("restore")) candidates.push(names);
  }
  if (candidates.length === 0) {
    throw new Error(
      `${sourcePath}: no el.append(...) appends \`restore\`; the version row's shape changed and ` +
        `history-cli's Shift+Tab route can no longer be derived`,
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      `${sourcePath}: ${candidates.length} el.append(...) calls append \`restore\`, so which row ` +
        `the rig walks into is ambiguous`,
    );
  }

  const appended = candidates[0]!;
  const rowButtons = appended.filter((name) => buttons.has(name));
  const restoreAt = rowButtons.indexOf("restore");
  if (restoreAt < 0) {
    throw new Error(
      `${sourcePath}: \`restore\` is appended but is not created as a button; it is no longer a ` +
        `tab stop and the backwards walk cannot reach it`,
    );
  }

  return {
    appended,
    buttons: rowButtons,
    shiftTabsToRestore: rowButtons.length - restoreAt,
  };
}
