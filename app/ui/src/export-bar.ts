// app/ui/src/export-bar.ts
// Write the whole manuscript to a Markdown file and say where it went.
//
// NO ELEMENT OF ITS OWN as of the retirement slice. This was a button in the
// project bar until the application menu covered the same operation twice over;
// the bar now holds state and the menu holds commands, so what is left here is
// the command and nothing else. The unit keeps its name because the two menu
// items it serves are still "the export bar's" routes, and a file rename buys
// nothing a header comment does not.
//
// EXPORT IS "AS SAVED", and the drain is what makes that equal to what the
// writer sees. `project_export` reads the store, so anything still sitting in
// the flush debounce is not in the file. `drain()`, never `settled()` -
// `settled()` awaits only a flush already in flight and loses a timer armed at
// the very end, which is exactly the last sentence someone types before
// reaching for this button.
//
// A FAILURE IS A NOTICE, NEVER THE SAVE BANNER. `raiseFailure` latches
// `persistError` and returns early on every later call, so one failed export
// would suppress the banner for a genuine autosave failure afterwards - the
// only case that surface exists for. Nothing was lost here: the manuscript is
// untouched by an export that did not happen. That is why there is no latching
// banner on the dep surface at all, rather than a convention not to call one.
//
// The latch is released on both paths. An export that failed must be retryable.

import { plural, t } from "./i18n";
import { exportFormatName, type ExportFormat } from "./export-formats";

/** What the host says it wrote.
 *
 *  `format` IS THE HOST'S ANSWER, not the page's request. It exists so the
 *  notice names the file that is on disk rather than the control that was
 *  pressed -- the two agree today, and a build where they stopped agreeing is
 *  the only reason to carry the field at all. See `export::Format::id`. */
export interface ExportWritten {
  path: string;
  underlined: number;
  format: string;
}

export interface ExportBarDeps {
  /** Drains the flush scheduler. Export is "as saved"; this is what makes
   *  "as saved" equal to what the writer sees. `drain()`, never `settled()`. */
  drain: () => Promise<void>;
  /** Invokes the host command and resolves with the written path and the number
   *  of UNDERLINED RUNS the Markdown could not carry.
   *
   *  Markdown has no underline, so the exporter drops the mark -- deliberately.
   *  The count is
   *  what stops that being a silent loss: the host tallies it while it renders,
   *  on the same accumulator shape `mirror::pass` counts unreadable bodies
   *  with, and this unit says it in the notice. A build that carried the count
   *  and did not say it would have shipped the loss anyway. */
  exportProject: (format: ExportFormat) => Promise<ExportWritten>;
  /** The same, through the operating system's own save dialog. Resolves null
   *  when the writer cancelled — an ANSWER, not a failure, so it raises no
   *  notice at all. Optional because the corpus path has no host to ask. */
  exportProjectAs?: (format: ExportFormat) => Promise<ExportWritten | null>;
  /** GOOD NEWS, and a different channel from onNotice deliberately. Both used
   *  to go through onNotice, which raised a red role="alert" bar that could not
   *  be dismissed - so "Exported to <path>" was announced as an emergency and
   *  then sat across the top of the application for the rest of the session. A
   *  unit knows which of its own messages is which; the page should not have to
   *  guess from the wording. */
  onDone: (message: string) => void;
  /** Non-latching. A failed export must never suppress the autosave banner. */
  onNotice: (message: string) => void;
}

export interface ExportBar {
  /** Run an export to the library's own exports directory. File > Export
   *  manuscript. Shares the `running` latch with `runAs` rather than holding one
   *  each: two activations still produce one file. */
  run(format: ExportFormat): void;
  /** Export to a destination the writer picks in an OS dialog. File > Export
   *  as…. Shares the same latch and the same drain as `run`: the two routes
   *  differ in where the file lands, and in nothing else. */
  runAs(format: ExportFormat): void;
  destroy(): void;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createExportBar(deps: ExportBarDeps): ExportBar {
  let destroyed = false;
  // The ONLY guard against a second export now that there is no button to
  // disable. It was always the load-bearing one: `element.disabled` was the
  // browser's guarantee about the pointer, never this unit's about its own
  // state, and both menu items reach these entry points directly.
  let running = false;

  const run = async (format: ExportFormat, chooseDestination: boolean): Promise<void> => {
    // NO `destroyed` CHECK, and this is now a claim rather than an
    // impossibility. Until the retirement slice the only entry was a click on a
    // listener destroy() removed, so nothing could reach here afterwards. The
    // menu calls run()/runAs() directly, so a destroyed unit CAN export: it
    // drains, it writes the file, and only the report is suppressed below.
    //
    // Left that way deliberately. Nothing is corrupted - the store is on disk
    // either way and the file is a valid snapshot of it - and a guard here would
    // be one no input can reach through the shipped page, because the menu reads
    // `current` at call time and a switch has already replaced it. This repo has
    // a rule about guards nothing can reach, and `import_name_ok` was deleted
    // under it. What the behaviour IS is pinned by a test, not by this comment.
    if (running) return;
    // The MENU can reach `runAs` where the dep is absent (the corpus path builds
    // no host bridge). Refusing before the latch, so a route that cannot work
    // does not latch out the route that can.
    if (chooseDestination && deps.exportProjectAs === undefined) return;
    running = true;
    let message: string | null;
    let failed = false;
    try {
      // Both awaits inside one try: a failed drain must not export. A file
      // written after the save path failed is missing the writer's last edits
      // and is still called their manuscript.
      await deps.drain();
      const result = chooseDestination
        ? await deps.exportProjectAs?.(format)
        : await deps.exportProject(format);
      // null is the writer cancelling the dialog. Saying nothing is the whole
      // response: they asked for a choice, made one, and nothing happened
      // because that is what they chose. A notice here would report their own
      // decision back to them as an event.
      message =
        result === null || result === undefined
          ? null
          : // THE CAVEAT ONLY WHEN THERE IS ONE. An unconditional sentence about
            // underlines would tell a writer who has never pressed that control
            // that something went missing from their manuscript.
            result.underlined > 0
            ? plural("export.done.underlined", result.underlined, {
                path: result.path,
                // THE FORMAT THE HOST WROTE, read off the result. Wording the
                // sentence from `format` -- the argument -- would make the
                // notice a restatement of the request, which is exactly the
                // thing it cannot be evidence of.
                format: exportFormatName(result.format),
              })
            : t("export.done", {
                path: result.path,
                format: exportFormatName(result.format),
              });
    } catch (error: unknown) {
      // The REQUESTED format here, because there is no result to read one off.
      message = t("export.error", {
        error: messageOf(error),
        format: exportFormatName(format),
      });
      failed = true;
    }
    running = false;
    // A resolution landing after teardown would re-enable and report through a
    // dead project's callbacks - the defect the outline slice shipped once.
    // `running` is deliberately cleared ABOVE this line and not below it: a
    // destroyed unit that stayed latched would be indistinguishable from one
    // mid-export if it were ever revived, and clearing it costs nothing.
    if (destroyed) return;
    if (message === null) return;
    if (failed) deps.onNotice(message);
    else deps.onDone(message);
  };

  return {
    run(format: ExportFormat): void {
      void run(format, false);
    },
    runAs(format: ExportFormat): void {
      void run(format, true);
    },
    destroy(): void {
      // Still a real latch, not a formality: it is what stops an export
      // resolving after teardown from reporting through a dead project's
      // onNotice, into the banner the NEXT project has already mounted.
      destroyed = true;
    },
  };
}
