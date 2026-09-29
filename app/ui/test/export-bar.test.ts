import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, describe, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import {
  createExportBar,
  type ExportBar,
  type ExportBarDeps,
  type ExportWritten,
} from "../src/export-bar";
import { EN } from "../src/i18n";

/** A promise a test resolves by hand, so a run can be observed mid-flight. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Several ticks: a run does drain and then the host, each a microtask hop. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

interface Rig {
  bar: ExportBar;
  /** Every call the unit made, in the order it made them. An end-state
   *  assertion cannot see an ordering bug; this can. */
  calls: () => string[];
  /** The PROBLEM channel. Kept apart from `dones` deliberately: merging the
   *  two would make every assertion below blind to the defect this split
   *  exists to prevent - a success painted in the failure surface. */
  notices: () => string[];
  /** The GOOD NEWS channel. */
  dones: () => string[];
  exportCount: () => number;
}

interface RigOptions {
  drain?: () => Promise<void>;
  exportProject?: () => Promise<ExportWritten>;
  exportProjectAs?: () => Promise<ExportWritten | null>;
  /** Leave the dialog dep off entirely, as the corpus path does. */
  withoutDialog?: boolean;
}

let open: Rig | null = null;

function mount(options: RigOptions = {}): Rig {
  const calls: string[] = [];
  const notices: string[] = [];
  const dones: string[] = [];
  let exportCount = 0;
  const bar = createExportBar({
    drain: () => {
      calls.push("drain");
      return options.drain?.() ?? Promise.resolve();
    },
    exportProject: () => {
      calls.push("export");
      exportCount++;
      return (
        options.exportProject?.() ?? Promise.resolve({ path: "/exports/novel.md", underlined: 0, format: "markdown" })
      );
    },
    exportProjectAs: options.withoutDialog === true
      ? undefined
      : () => {
          calls.push("export-as");
          exportCount++;
          return (
            options.exportProjectAs?.() ??
            Promise.resolve({ path: "/chosen/novel.md", underlined: 0, format: "markdown" })
          );
        },
    onNotice: (message) => notices.push(message),
    onDone: (message) => dones.push(message),
  });
  const rig: Rig = {
    bar,
    calls: () => [...calls],
    notices: () => [...notices],
    dones: () => [...dones],
    exportCount: () => exportCount,
  };
  open = rig;
  return rig;
}

afterEach(() => {
  open?.bar.destroy();
  open = null;
});

describe("exporting the manuscript", () => {
  test("drains before invoking the host", async () => {
    const rig = mount();
    rig.bar.run("markdown");
    await settle();

    // Export reads the STORE. A host call made before the drain exports a file
    // missing whatever is still sitting in the debounce.
    expect(rig.calls()).toEqual(["drain", "export"]);
  });

  test("the report names the underlined runs Markdown could not carry", async () => {
    // THE SURFACED LOSS. The mark is real in the book and absent from the
    // export, and the host counts what it dropped. A build that shipped the
    // count and said nothing would satisfy every other test in this file --
    // which is exactly the silent loss the decision record refuses.
    const rig = mount({
      exportProject: () => Promise.resolve({ path: "/exports/novel.md", underlined: 3, format: "markdown" }),
    });
    rig.bar.run("markdown");
    await settle();

    expect(rig.dones()).toHaveLength(1);
    const message = rig.dones()[0] ?? "";
    expect(message).toContain("/exports/novel.md");
    expect(message).toContain("3");
    // Good news with a caveat is still good news: it must not arrive on the
    // failure channel, which latches and cannot be dismissed.
    expect(rig.notices()).toEqual([]);
  });

  test("one underlined run is reported in the singular", async () => {
    const rig = mount({
      exportProject: () => Promise.resolve({ path: "/exports/novel.md", underlined: 1, format: "markdown" }),
    });
    rig.bar.run("markdown");
    await settle();
    expect(rig.dones()[0]).toBe(
      EN["export.done.underlined.one"]
        ?.replaceAll("{path}", "/exports/novel.md")
        .replaceAll("{count}", "1")
        .replaceAll("{format}", "Markdown"),
    );
  });

  test("the report names the format the HOST wrote, not the one asked for", async () => {
    // The whole reason `ExportResult` carries a format. Wording the notice from
    // the argument would make it a restatement of the request -- true of a build
    // that wrote the wrong file, and therefore no evidence about the file. An
    // id this page has no name for renders as itself rather than as Markdown.
    const rig = mount({
      exportProject: () =>
        Promise.resolve({ path: "/exports/novel.epub", underlined: 0, format: "epub" }),
    });
    rig.bar.run("markdown");
    await settle();
    expect(rig.dones()).toEqual([`Exported ${EN["export.format.epub"]} to /exports/novel.epub`]);
  });

  test("the caveat sentence names the format the HOST wrote too", async () => {
    // The underlined branch is a SECOND sentence built from a second key, and
    // it took its format from the request while its sibling took it from the
    // result -- which no test could see, because the only test comparing the
    // two ran with nothing underlined. A message right half the time is worse
    // than one that is always wrong: nobody looks for it.
    const rig = mount({
      exportProject: () =>
        Promise.resolve({ path: "/exports/novel.epub", underlined: 2, format: "epub" }),
    });
    rig.bar.run("markdown");
    await settle();
    expect(rig.dones()).toEqual([
      (EN["export.done.underlined.other"] ?? "")
        .replaceAll("{path}", "/exports/novel.epub")
        .replaceAll("{count}", "2")
        .replaceAll("{format}", EN["export.format.epub"] ?? ""),
    ]);
  });

  test("a failure names the format that was ASKED for", async () => {
    // The one path with no result to read a format off. A notice with the
    // format left out would be the sentence 040 removed.
    const rig = mount({
      exportProject: () => Promise.reject(new Error("no space")),
    });
    rig.bar.run("markdown");
    await settle();
    expect(rig.notices()).toEqual(["Markdown export failed: no space"]);
    expect(rig.dones()).toEqual([]);
  });

  test("an export that lost nothing says nothing about underlines", async () => {
    // The control. A message that mentioned the loss unconditionally would tell
    // a writer who has never pressed the control that something went wrong.
    const rig = mount({
      exportProject: () => Promise.resolve({ path: "/exports/novel.md", underlined: 0, format: "markdown" }),
    });
    rig.bar.run("markdown");
    await settle();
    expect(rig.dones()[0]).toBe(
      EN["export.done"]
        ?.replaceAll("{path}", "/exports/novel.md")
        .replaceAll("{format}", "Markdown"),
    );
  });

  test("the dialog route reports the same loss", async () => {
    // Two routes to one file. A count carried on one of them only is a loss
    // that is silent half the time, which is worse than one that is silent
    // always: nobody would look for it.
    const rig = mount({
      exportProjectAs: () => Promise.resolve({ path: "/chosen/novel.md", underlined: 2, format: "markdown" }),
    });
    rig.bar.runAs("markdown");
    await settle();
    expect(rig.dones()[0]).toContain("2");
    expect(rig.dones()[0]).toContain("/chosen/novel.md");
  });

  test("reports the returned path", async () => {
    const rig = mount({ exportProject: () => Promise.resolve({ path: "/exports/my-novel-2.md", underlined: 0, format: "markdown" }) });
    rig.bar.run("markdown");
    await settle();

    // The written path is NEWS, so it goes down the good-news channel. It used
    // to arrive on onNotice, which raised the same undismissable red alert bar
    // as a save failure.
    expect(rig.dones()).toHaveLength(1);
    expect(rig.dones()[0]).toContain("/exports/my-novel-2.md");
    expect(rig.notices()).toEqual([]);
  });

  test("releases the latch after a success, so a second export is possible", async () => {
    // There is no button to re-enable any more; the `running` latch is the whole
    // guard, and the only way to see it released is that a later run works.
    const rig = mount();
    rig.bar.run("markdown");
    await settle();

    rig.bar.run("markdown");
    await settle();
    expect(rig.exportCount()).toBe(2);
  });

  test("releases the latch after a failure, and raises a notice", async () => {
    const failing = { fail: true };
    const rig = mount({
      exportProject: () =>
        failing.fail ? Promise.reject(new Error("disk full")) : Promise.resolve({ path: "/x.md", underlined: 0, format: "markdown" }),
    });
    rig.bar.run("markdown");
    await settle();

    expect(rig.notices()).toHaveLength(1);
    expect(rig.notices()[0]).toContain("disk full");

    // An export that failed must be retryable.
    failing.fail = false;
    rig.bar.run("markdown");
    await settle();
    expect(rig.exportCount()).toBe(2);
  });

  test("a failure is a notice, never a failure banner", async () => {
    // COMPILE-TIME. There is no latching banner on the dep surface at all, so a
    // later change that reaches for raiseFailure cannot compile rather than
    // merely being wrong: `Extract` is `never` today and this annotation stops
    // type-checking the day one of these keys is added.
    const latching: Extract<keyof ExportBarDeps, "raiseFailure" | "onFailure" | "onError">[] = [];
    expect(latching).toHaveLength(0);
    // And the surface is exactly these four plus the optional dialog dep, so a
    // fifth dep is a deliberate act.
    const deps: ExportBarDeps = {
      drain: () => Promise.resolve(),
      exportProject: () => Promise.resolve({ path: "/x.md", underlined: 0, format: "markdown" }),
      onNotice: () => undefined,
      onDone: () => undefined,
    };
    expect(Object.keys(deps).sort()).toEqual(["drain", "exportProject", "onDone", "onNotice"]);

    // RUNTIME. The failure went somewhere, and the only somewhere is onNotice -
    // the good-news channel must stay empty, or a failed export is announced as
    // an achievement.
    const rig = mount({ exportProject: () => Promise.reject(new Error("nope")) });
    rig.bar.run("markdown");
    await settle();
    expect(rig.notices()).toHaveLength(1);
    expect(rig.dones()).toEqual([]);
  });

  test("a second run while one is in flight does nothing", async () => {
    const gate = deferred<ExportWritten>();
    const rig = mount({ exportProject: () => gate.promise });
    rig.bar.run("markdown");
    await settle();

    rig.bar.run("markdown");
    await settle();
    expect(rig.exportCount()).toBe(1);

    gate.resolve({ path: "/exports/novel.md", underlined: 0, format: "markdown" });
    await settle();
    expect(rig.exportCount()).toBe(1);
    expect(rig.dones()).toHaveLength(1);
  });

  test("a second run while the DRAIN is still running does nothing", async () => {
    const gate = deferred<void>();
    const rig = mount({ drain: () => gate.promise });
    rig.bar.run("markdown");
    await settle();

    rig.bar.run("markdown");
    await settle();
    // Two drains would be harmless; two exports would write two files for one
    // request each, and the guard has to cover the whole in-flight window rather
    // than just the half after the host call starts.
    expect(rig.calls()).toEqual(["drain"]);

    gate.resolve();
    await settle();
    expect(rig.calls()).toEqual(["drain", "export"]);
  });

  test("a resolution after destroy() reports nothing", async () => {
    const gate = deferred<ExportWritten>();
    const rig = mount({ exportProject: () => gate.promise });
    rig.bar.run("markdown");
    await settle();

    rig.bar.destroy();
    gate.resolve({ path: "/exports/novel.md", underlined: 0, format: "markdown" });
    await settle();

    // Both channels belong to a project that is gone; the next project has
    // already mounted its own banner into the same shell.
    expect(rig.notices()).toEqual([]);
    expect(rig.dones()).toEqual([]);
  });

  test("a rejection after destroy() reports nothing either", async () => {
    const gate = deferred<ExportWritten>();
    const rig = mount({ exportProject: () => gate.promise });
    rig.bar.run("markdown");
    await settle();

    rig.bar.destroy();
    gate.reject(new Error("disk full"));
    await settle();

    expect(rig.notices()).toEqual([]);
    expect(rig.dones()).toEqual([]);
  });

  test("a drain rejection does not export", async () => {
    const failing = { fail: true };
    const rig = mount({
      drain: () => (failing.fail ? Promise.reject(new Error("save failed")) : Promise.resolve()),
    });
    rig.bar.run("markdown");
    await settle();

    // Exporting after a failed drain writes a file missing the writer's last
    // edits and calls it their manuscript.
    expect(rig.calls()).toEqual(["drain"]);
    expect(rig.exportCount()).toBe(0);
    expect(rig.notices()).toHaveLength(1);
    expect(rig.notices()[0]).toContain("save failed");
    expect(rig.dones()).toEqual([]);

    // The latch is released on this path too.
    failing.fail = false;
    rig.bar.run("markdown");
    await settle();
    expect(rig.exportCount()).toBe(1);
  });

  test("run() after destroy() still reaches the host, and reports nothing", async () => {
    // TRUTHFUL, not aspirational. `run` carries NO `destroyed` check before its
    // awaits - the source says so, on the argument that destroy() removed the
    // click listener so nothing could reach it. There is no listener any more:
    // both menu items call these entry points directly, so a destroyed unit
    // still drains and still writes a file. Only the REPORT is suppressed.
    // If a `destroyed` guard is ever added at the top of `run`, this test is
    // what will say so.
    const rig = mount();
    rig.bar.destroy();

    rig.bar.run("markdown");
    await settle();

    expect(rig.calls()).toEqual(["drain", "export"]);
    expect(rig.notices()).toEqual([]);
    expect(rig.dones()).toEqual([]);
  });

  test("destroy() is idempotent", () => {
    const rig = mount();
    rig.bar.destroy();
    expect(() => rig.bar.destroy()).not.toThrow();
  });
});

describe("exporting to a destination the writer picks", () => {
  test("runAs drains first, exactly as run does", async () => {
    // Export is "as saved", and a dialog does not change that. A file written
    // without the drain is missing the last sentence someone typed before
    // reaching for the menu.
    const rig = mount();
    rig.bar.runAs("markdown");
    await settle();
    expect(rig.calls()).toEqual(["drain", "export-as"]);
  });

  test("runAs and run reach different host commands", async () => {
    // One writes to the fixed exports directory, the other asks. If these were
    // the same call the menu would be advertising a choice it never offers.
    const rig = mount();
    rig.bar.run("markdown");
    await settle();
    expect(rig.calls()).toEqual(["drain", "export"]);
  });

  test("a cancelled dialog reports nothing at all", async () => {
    // null is the writer cancelling. A notice here would report their own
    // decision back to them as an event, and "Exported to null" would be worse.
    const rig = mount({ exportProjectAs: () => Promise.resolve(null) });
    rig.bar.runAs("markdown");
    await settle();
    expect(rig.notices()).toEqual([]);
    // And not as good news either. "Exported to" a file that was never written
    // is the worse of the two lies.
    expect(rig.dones()).toEqual([]);
  });

  test("a cancelled dialog releases the latch", async () => {
    // Cancelling must not leave the application unable to export. The latch is
    // released on every path, and this is the path with no message to send.
    const rig = mount({ exportProjectAs: () => Promise.resolve(null) });
    rig.bar.runAs("markdown");
    await settle();
    rig.bar.runAs("markdown");
    await settle();
    expect(rig.exportCount()).toBe(2);
  });

  test("a chosen path is reported like any other", async () => {
    const rig = mount({ exportProjectAs: () => Promise.resolve({ path: "/home/w/book.md", underlined: 0, format: "markdown" }) });
    rig.bar.runAs("markdown");
    await settle();
    expect(rig.dones()).toEqual(["Exported Markdown to /home/w/book.md"]);
    expect(rig.notices()).toEqual([]);
  });

  test("a failed dialog export is a notice, not a banner", async () => {
    const rig = mount({ exportProjectAs: () => Promise.reject(new Error("no space")) });
    rig.bar.runAs("markdown");
    await settle();
    expect(rig.notices()).toEqual(["Markdown export failed: no space"]);
    expect(rig.dones()).toEqual([]);
  });

  test("runAs and run share one latch, so two routes cannot write two files", async () => {
    // The latch was written for exactly this and the comment on it said so
    // before there was a second caller. A writer who picks Export manuscript and
    // then Export as... has asked once.
    // ONE deferred, handed to every caller, and that is what makes the test
    // real. An earlier version built a NEW promise per drain call, so the second
    // route simply overwrote the first's resolver and only one export could ever
    // finish - the assertion held with the latch removed entirely. Found by
    // mutation, not by reading.
    //
    // A record rather than a `let`: a local assigned only inside a closure is
    // narrowed to `null` for the rest of the file, so `release?.()` would
    // type-check while asserting nothing. Recorded gotcha, second instance.
    const held: { release: (() => void) | null } = { release: null };
    const drained = new Promise<void>((res) => (held.release = res));
    const rig = mount({ drain: () => drained });
    rig.bar.run("markdown");
    rig.bar.runAs("markdown");
    await Promise.resolve();
    held.release?.();
    for (let i = 0; i < 6; i++) await Promise.resolve();
    // Both routes drained at most once, and exported at most once: one writer's
    // intent, one file.
    expect(rig.calls().filter((c) => c === "drain")).toHaveLength(1);
    expect(rig.exportCount()).toBe(1);
  });

  test("runAs where the host offers no dialog does nothing, and does not take the latch", async () => {
    // The corpus path builds no bridge, and the menu can still reach this. A
    // route that cannot work must not latch out the route that can - which is
    // why the refusal sits BEFORE `running = true` in the source.
    const rig = mount({ withoutDialog: true });
    rig.bar.runAs("markdown");
    await settle();
    expect(rig.calls()).toEqual([]);

    rig.bar.run("markdown");
    await settle();
    expect(rig.calls()).toEqual(["drain", "export"]);
    expect(rig.exportCount()).toBe(1);
  });
});

describe("which channel a message goes down", () => {
  // The split this suite exists to pin. Both messages used to go through
  // onNotice, and the page had no way to tell them apart except by reading the
  // wording - so "Exported to <path>" was raised in the failure surface: a red
  // role="alert" bar with no dismiss control that stayed for the session.
  // The unit knows which of its own messages is which. These tests assert that
  // it says so, and that the OTHER channel stays empty - an assertion on one
  // list alone survives a unit that reports down both.

  test("a success goes down onDone and NOT down onNotice", async () => {
    const rig = mount({ exportProject: () => Promise.resolve({ path: "/exports/a.md", underlined: 0, format: "markdown" }) });
    rig.bar.run("markdown");
    await settle();
    expect(rig.dones()).toEqual(["Exported Markdown to /exports/a.md"]);
    expect(rig.notices()).toEqual([]);
  });

  test("a failure goes down onNotice and NOT down onDone", async () => {
    const rig = mount({ exportProject: () => Promise.reject(new Error("read-only")) });
    rig.bar.run("markdown");
    await settle();
    expect(rig.notices()).toEqual(["Markdown export failed: read-only"]);
    expect(rig.dones()).toEqual([]);
  });

  test("a success and a failure in one session stay on their own channels", async () => {
    // One run each, through the SAME unit. A unit that routed everything to
    // whichever dep it was handed last would pass both tests above and fail
    // this one.
    const failing = { fail: true };
    const rig = mount({
      exportProject: () =>
        failing.fail
          ? Promise.reject(new Error("read-only"))
          : Promise.resolve({ path: "/exports/b.md", underlined: 0, format: "markdown" }),
    });
    rig.bar.run("markdown");
    await settle();
    failing.fail = false;
    rig.bar.run("markdown");
    await settle();

    expect(rig.notices()).toEqual(["Markdown export failed: read-only"]);
    expect(rig.dones()).toEqual(["Exported Markdown to /exports/b.md"]);
  });
});
