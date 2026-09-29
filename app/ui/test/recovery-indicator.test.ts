// app/ui/test/recovery-indicator.test.ts
// The surface's one claim is that it never lets a writer believe they are
// protected when they are not. Most of these tests attack that: the two times
// the host keeps apart must stay apart, and the escalation must be reachable.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import {
  createRecoveryIndicator,
  describe as describeRecovery,
  ESCALATE_AFTER,
  formatWhen,
  readRecoveryReport,
  RECOVERY_EVENT,
  startupRecoverySentence,
  type RecoveryReport,
} from "../src/recovery-indicator";
import { EN } from "../src/i18n/en";

const NOW = 1_000_000_000_000;
const MINUTE = 60_000;

function report(over: Partial<RecoveryReport> = {}): RecoveryReport {
  return {
    slug: "book",
    status: {
      last_attempt_ms: NOW - MINUTE,
      last_attempt_ok: true,
      last_error: null,
      last_verified_ms: NOW - MINUTE,
      consecutive_failures: 0,
    },
    newest_verified_ms: NOW - 5 * MINUTE,
    verified_points: 3,
    ...over,
  };
}

function container(): HTMLElement {
  const el = document.createElement("span");
  document.body.append(el);
  return el;
}

describe("what the report is saying", () => {
  test("no project resolved at all says nothing was taken", () => {
    const out = describeRecovery(
      { slug: null, status: null, newest_verified_ms: null, verified_points: 0 },
      NOW,
    );
    expect(out.state).toBe("none");
    expect(out.text).toBe("No recovery point on this device");
  });

  test("a project with no verified point ever says nothing was taken", () => {
    const out = describeRecovery(
      report({ newest_verified_ms: null, verified_points: 0 }),
      NOW,
    );
    expect(out.state).toBe("none");
    expect(out.text).toBe("No recovery point on this device");
  });

  test("a good last attempt says recovered on this device, and says on this device", () => {
    const out = describeRecovery(report(), NOW);
    expect(out.state).toBe("protected");
    expect(out.text).toBe("Recovery point on this device 5 minutes ago");
    expect(out.label).toBe(
      "Recovery: a recovery point was taken on this device 5 minutes ago. It does not protect against losing this computer.",
    );
  });

  test("a_failed_attempt_never_moves_the_verified_time", () => {
    // The two figures DISAGREE on purpose: `newest_verified_ms` is the
    // manifest's, `last_attempt_ms` is what the attempts remember. An
    // implementation that reads the attempt time for the verified one passes
    // every fixture where they coincide.
    const out = describeRecovery(
      report({
        status: {
          last_attempt_ms: NOW - MINUTE,
          last_attempt_ok: false,
          last_error: "disk full",
          last_verified_ms: NOW - 5 * MINUTE,
          consecutive_failures: 1,
        },
      }),
      NOW,
    );
    expect(out.state).toBe("attempt-failed");
    expect(out.text).toBe(
      "Backup failed 1 minute ago \u00b7 last verified 5 minutes ago",
    );
  });

  test("a failed attempt names BOTH times in the accessible name too", () => {
    const out = describeRecovery(
      report({
        status: {
          last_attempt_ms: NOW - MINUTE,
          last_attempt_ok: false,
          last_error: "disk full",
          last_verified_ms: NOW - 5 * MINUTE,
          consecutive_failures: 1,
        },
      }),
      NOW,
    );
    expect(out.label).toBe(
      "Recovery: the last backup attempt failed 1 minute ago. The most recent good recovery point on this device is still from 5 minutes ago.",
    );
  });

  test("the_escalation_fires_at_exactly_three", () => {
    const at = (consecutive_failures: number) =>
      describeRecovery(
        report({
          status: {
            last_attempt_ms: NOW - MINUTE,
            last_attempt_ok: false,
            last_error: "disk full",
            last_verified_ms: NOW - 5 * MINUTE,
            consecutive_failures,
          },
        }),
        NOW,
      ).state;
    expect(ESCALATE_AFTER).toBe(3);
    expect(at(2)).toBe("attempt-failed");
    expect(at(3)).toBe("stale");
    expect(at(4)).toBe("stale");
  });

  test("the stale wording still names both times", () => {
    const out = describeRecovery(
      report({
        status: {
          last_attempt_ms: NOW - MINUTE,
          last_attempt_ok: false,
          last_error: "disk full",
          last_verified_ms: NOW - 5 * MINUTE,
          consecutive_failures: ESCALATE_AFTER,
        },
      }),
      NOW,
    );
    expect(out.state).toBe("stale");
    expect(out.text).toBe(
      "Backup stale: failed 1 minute ago \u00b7 last verified 5 minutes ago",
    );
  });

  test("nothing it puts in the bar is long enough to push the save indicator off", () => {
    // A RULE, not a name list. The failing states are the only values in the
    // strip whose length is not bounded by their own wording, and the element
    // after them answers "is my work in the file". The full sentence, both
    // times included, lives in the accessible name, which has no strip around
    // it to overflow. 70 is the width of the longest state at the widest
    // plural arm with room to spare; a value that needs more than that belongs
    // in the name.
    const longest = Math.max(
      ...(["none", "protected", "attempt-failed", "stale"] as const).map((state) => {
        const text = EN[`recovery.text.${state}` as keyof typeof EN] as string;
        return text.replace("{when}", "22 minutes ago").replace("{earlier}", "14 minutes ago").length;
      }),
    );
    expect(longest).toBeLessThanOrEqual(70);
  });

  test("a verified point with no status at all is still a point", () => {
    // The status file can be absent where the manifest is not: a directory
    // restored by hand, or a status write that failed after the point landed.
    const out = describeRecovery(report({ status: null }), NOW);
    expect(out.state).toBe("protected");
    expect(out.text).toBe("Recovery point on this device 5 minutes ago");
  });

  test("nothing it can say mentions restoring", () => {
    // Restore is owned elsewhere. Nothing here can put a point back, and a
    // surface that hints otherwise is the failure the design names.
    const all = [
      describeRecovery(report(), NOW),
      describeRecovery(report({ newest_verified_ms: null }), NOW),
      describeRecovery(
        report({
          status: {
            last_attempt_ms: NOW,
            last_attempt_ok: false,
            last_error: "x",
            last_verified_ms: NOW - MINUTE,
            consecutive_failures: 5,
          },
        }),
        NOW,
      ),
    ];
    for (const out of all) {
      expect(`${out.text} ${out.label}`.toLowerCase()).not.toContain("restor");
    }
  });
});

describe("when a point was taken, as a reader scans it", () => {
  test("the singular and the plural are different sentences", () => {
    expect(formatWhen(NOW - MINUTE, NOW)).toBe("1 minute ago");
    expect(formatWhen(NOW - 2 * MINUTE, NOW)).toBe("2 minutes ago");
  });

  test("a point taken seconds ago is just now", () => {
    expect(formatWhen(NOW - 3000, NOW)).toBe("just now");
  });

  test("hours and days have their own arms", () => {
    expect(formatWhen(NOW - 3 * 60 * MINUTE, NOW)).toBe("3 hours ago");
    expect(formatWhen(NOW - 3 * 24 * 60 * MINUTE, NOW)).toBe("3 days ago");
  });
});

describe("the element in the project bar", () => {
  test("it is a group, never a live region", () => {
    // save-indicator.ts:15-20's recorded reason, and here the argument is
    // stronger: the design forbids announcing this at all.
    const el = container();
    const indicator = createRecoveryIndicator({ container: el, status: async () => report() });
    try {
      const node = el.querySelector("#recovery-indicator");
      expect(node?.getAttribute("role")).toBe("group");
      expect(node?.getAttribute("aria-live")).toBeNull();
      expect(node?.getAttribute("role")).not.toBe("alert");
    } finally {
      indicator.destroy();
      el.remove();
    }
  });

  test("every state change is reported to onState, the first one before the first await", async () => {
    const el = container();
    const seen: string[] = [];
    const indicator = createRecoveryIndicator({
      container: el,
      status: async () => report(),
      now: () => NOW,
      onState: (state) => seen.push(state),
    });
    expect(seen).toEqual(["none"]);
    await indicator.refresh();
    expect(seen).toEqual(["none", "protected"]);
    indicator.destroy();
  });

  test("the accessible name is rewritten on every repaint, not only at mount", () => {
    const el = container();
    const indicator = createRecoveryIndicator({
      container: el,
      status: async () => report(),
      now: () => NOW,
    });
    try {
      const node = el.querySelector<HTMLElement>("#recovery-indicator");
      expect(node?.getAttribute("aria-label")).toBe(
        "Recovery: no recovery point has been taken on this device yet.",
      );
      indicator.set(describeRecovery(report(), NOW));
      expect(node?.textContent).toBe("Recovery point on this device 5 minutes ago");
      expect(node?.getAttribute("aria-label")).toBe(
        "Recovery: a recovery point was taken on this device 5 minutes ago. It does not protect against losing this computer.",
      );
    } finally {
      indicator.destroy();
      el.remove();
    }
  });

  test("the state is on a data attribute so the stylesheet does not key on wording", async () => {
    const el = container();
    const indicator = createRecoveryIndicator({
      container: el,
      now: () => NOW,
      status: async () =>
        report({
          status: {
            last_attempt_ms: NOW - MINUTE,
            last_attempt_ok: false,
            last_error: "disk full",
            last_verified_ms: NOW - 5 * MINUTE,
            consecutive_failures: ESCALATE_AFTER,
          },
        }),
    });
    try {
      await indicator.refresh();
      expect(el.querySelector<HTMLElement>("#recovery-indicator")?.dataset.state).toBe("stale");
    } finally {
      indicator.destroy();
      el.remove();
    }
  });

  test("a host that cannot answer leaves the last thing said standing", async () => {
    const el = container();
    let fail = false;
    const indicator = createRecoveryIndicator({
      container: el,
      now: () => NOW,
      status: async () => {
        if (fail) throw new Error("no host");
        return report();
      },
    });
    try {
      await indicator.refresh();
      fail = true;
      await indicator.refresh();
      expect(el.querySelector<HTMLElement>("#recovery-indicator")?.textContent).toBe(
        "Recovery point on this device 5 minutes ago",
      );
    } finally {
      indicator.destroy();
      el.remove();
    }
  });

  test("it re-reads the files on the host's event rather than trusting a payload", async () => {
    const el = container();
    let calls = 0;
    // A mutable RECORD, not a `let`: a local assigned only inside a closure
    // narrows to `null` for the rest of the file, and the recorded consequence
    // is a guard that type-checks while asserting nothing.
    const hook: { fire: (() => void) | null } = { fire: null };
    const indicator = createRecoveryIndicator({
      container: el,
      now: () => NOW,
      status: async () => {
        calls++;
        return report();
      },
      subscribe: (cb) => {
        hook.fire = cb;
        return Promise.resolve(() => undefined);
      },
    });
    try {
      await indicator.refresh();
      expect(calls).toBe(1);
      hook.fire?.();
      await indicator.refresh();
      expect(calls).toBeGreaterThan(1);
    } finally {
      indicator.destroy();
      el.remove();
    }
  });

  test("the subscription is released on destroy, so a switch does not stack them", async () => {
    const el = container();
    let released = 0;
    const indicator = createRecoveryIndicator({
      container: el,
      status: async () => report(),
      subscribe: () =>
        Promise.resolve(() => {
          released++;
        }),
    });
    // The unlisten arrives on a microtask; await one before tearing down.
    await Promise.resolve();
    await Promise.resolve();
    indicator.destroy();
    el.remove();
    expect(released).toBe(1);
  });

  test("the event name is the host's", () => {
    expect(RECOVERY_EVENT).toBe("app://recovery-changed");
  });
});

describe("the manual backup a writer asked for", () => {
  test("a point taken is good news, on the notice channel and not the save banner", async () => {
    const el = container();
    const done: string[] = [];
    const problems: string[] = [];
    const indicator = createRecoveryIndicator({
      container: el,
      status: async () => report(),
      backup: async () => ({ id: "2026-08-21T00-00-00Z" }),
      onDone: (m) => done.push(m),
      onNotice: (m) => problems.push(m),
    });
    try {
      await indicator.backupNow();
      expect(done).toEqual(["Recovery point taken on this device."]);
      expect(problems).toEqual([]);
    } finally {
      indicator.destroy();
      el.remove();
    }
  });

  test("a refusal names its cause and never latches a failure banner", async () => {
    const el = container();
    const done: string[] = [];
    const problems: string[] = [];
    const indicator = createRecoveryIndicator({
      container: el,
      status: async () => report(),
      backup: async () => {
        throw new Error("disk full");
      },
      onDone: (m) => done.push(m),
      onNotice: (m) => problems.push(m),
    });
    try {
      await indicator.backupNow();
      expect(problems).toEqual(["Could not take a recovery point: disk full"]);
      expect(done).toEqual([]);
    } finally {
      indicator.destroy();
      el.remove();
    }
  });

  test("both outcomes re-read the status, because the host emits on both", async () => {
    const el = container();
    let calls = 0;
    const indicator = createRecoveryIndicator({
      container: el,
      status: async () => {
        calls++;
        return report();
      },
      backup: async () => {
        throw new Error("disk full");
      },
      onNotice: () => undefined,
    });
    try {
      await indicator.backupNow();
      expect(calls).toBe(1);
    } finally {
      indicator.destroy();
      el.remove();
    }
  });
});

describe("the sentence on the screen that explains a failed open", () => {
  test("a verified point is named, with its time and with `on this device`", () => {
    expect(startupRecoverySentence(report(), NOW)).toBe(
      "This project has a same-device recovery point from 5 minutes ago. It sits beside the project file, so it is lost with the computer. Restoring it adds a NEW project and replaces nothing: open another project and use the recovery list in the project panel, or run `app-shell-tauri restore <point.point> <library-dir>` from a terminal.",
    );
  });

  test("the sentence no longer says a restore is impossible", () => {
    // It said so truthfully until a restore existed. A sentence describing a
    // mechanism the reader cannot check is the exact defect this whole feature
    // exists to undo, and it does not stop being one when it errs the other
    // way.
    const said = startupRecoverySentence(report(), NOW);
    expect(said).not.toContain("can do yet");
    expect(said).not.toContain("not something this application");
  });

  test("it names a route that exists on THAT screen", () => {
    // `showStartupFailure` is deliberately plain and PREPENDS to the body: it
    // depends on no unit having been constructed, so the menu bar may not be
    // painted when this renders. The terminal subcommand needs no window, which
    // is why the advice paragraph beside it already names `validate` and
    // `salvage`.
    expect(startupRecoverySentence(report(), NOW)).toContain("app-shell-tauri restore");
  });

  test("it still refuses to imply device-loss coverage", () => {
    const said = startupRecoverySentence(report(), NOW);
    expect(said).toContain("lost with the computer");
  });

  test("no point at all promises nothing", () => {
    expect(
      startupRecoverySentence(report({ newest_verified_ms: null, verified_points: 0 }), NOW),
    ).toBe("There is no same-device recovery point for this project.");
  });

  test("a newest point that FAILED verification gets the same plain negative", () => {
    // `newest_verified_ms` is null exactly then: the manifest holds the point
    // and it is not verified. Saying anything else is the removed sentence's
    // defect with a new mechanism behind it.
    expect(
      startupRecoverySentence(
        report({ newest_verified_ms: null, verified_points: 0, status: {
          last_attempt_ms: NOW - MINUTE,
          last_attempt_ok: true,
          last_error: null,
          last_verified_ms: null,
          consecutive_failures: 0,
        } }),
        NOW,
      ),
    ).toBe("There is no same-device recovery point for this project.");
  });

  test("nothing to ask, nothing to say", () => {
    expect(startupRecoverySentence(null, NOW)).toBe("");
  });
});

describe("asking the host on the one screen that exists because something failed", () => {
  test("a host that answers hands the report back", async () => {
    const asked: string[] = [];
    const out = await readRecoveryReport(async (cmd) => {
      asked.push(cmd);
      return report();
    });
    expect(asked).toEqual(["recovery_status"]);
    expect(out?.newest_verified_ms).toBe(NOW - 5 * MINUTE);
  });

  test("no host to ask means no report, and no throw", async () => {
    expect(await readRecoveryReport(undefined)).toBeNull();
  });

  test("a REJECTING host means no report, and no throw", async () => {
    // This runs on the screen whose whole job is to explain an error. A
    // rejection escaping here would replace that explanation with an unhandled
    // one, which is the removed sentence's defect wearing a different costume.
    expect(
      await readRecoveryReport(() => Promise.reject(new Error("no project is open"))),
    ).toBeNull();
  });

  test("a host that answers with nothing usable still composes no sentence", async () => {
    const out = await readRecoveryReport(async () => null);
    expect(startupRecoverySentence(out, NOW)).toBe("");
  });
});

describe("the stylesheet cannot move the project bar", () => {
  // The bar's 39px is a click-geometry constant restated in five rigs, and a
  // declaration that grows this span's line box moves every row below it.
  // Comments are stripped first: three guards in this repo have found their
  // target in the prose explaining the target's absence.
  const css = readFileSync(join(import.meta.dir, "..", "style.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );

  /** Every rule whose selector mentions `name`, with its declaration block.
   *  One pass over every rule rather than a pattern anchored to the previous
   *  rule's brace: an anchored one consumes the `}` it matched on and then
   *  cannot see the rule that follows immediately after it. */
  const blocksFor = (name: string): string[] => {
    const out: string[] = [];
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (new RegExp(name).test(m[1] ?? "")) out.push(m[2] ?? "");
    }
    return out;
  };

  test("the guard finds the rules it is about to make claims over", () => {
    // VACUITY GUARD. A parser matching nothing passes every stylesheet,
    // including one with no recovery rules in it at all.
    expect(blocksFor("recovery-indicator").length).toBeGreaterThanOrEqual(2);
    expect(blocksFor("save-indicator").length).toBeGreaterThanOrEqual(2);
  });

  test("it declares no height and no padding of its own", () => {
    // Anchored to a property boundary: a bare `not.toContain("height:")` also
    // matches `line-height:` and fails against a correct stylesheet.
    for (const block of blocksFor("recovery-indicator")) {
      expect(/(?:^|;)\s*(?:min-|max-|line-)?height\s*:/.test(block)).toBe(false);
      expect(/(?:^|;)\s*padding(?:-[a-z]+)?\s*:/.test(block)).toBe(false);
    }
  });

  test("its type size is the save indicator's, which is the safe precedent", () => {
    const sizeOf = (name: string): string[] =>
      blocksFor(name)
        .flatMap((b) => [...b.matchAll(/(?:^|;)\s*font-size\s*:\s*([^;]+)/g)])
        .map((m) => (m[1] ?? "").trim());
    expect(sizeOf("recovery-indicator")).toEqual(sizeOf("save-indicator"));
  });

  test("the escalation is a colour change, and not the save failure's colour", () => {
    // --danger means "your work is not in the file". A stale recovery point
    // says nothing of the kind: the manuscript is written and safe, and the
    // second copy is old. Painting them the same red makes the one that stops
    // a writer indistinguishable from the one that should not.
    const stale = blocksFor('recovery-indicator\\[data-state="stale"\\]');
    expect(stale.length).toBe(1);
    expect(stale[0]).toContain("color:");
    expect(stale[0]).not.toContain("--danger");
  });
});

describe("the three protections never blur into one sentence", () => {
  test("no recovery string borrows 016's phrasing or promises off-device safety", () => {
    // The design's section 6 argument: in-project history, same-device
    // recovery, and a file the writer moves off the computer themselves are
    // three different promises, and a surface that blurs them is the failure
    // this feature exists to prevent. Restore owns "move this file off this
    // computer yourself" and this must not borrow it.
    const forbidden = [
      "off this computer",
      "off-site",
      "offsite",
      "cloud",
      "safe from",
      "protects against losing this computer",
    ];
    const recoveryKeys = Object.keys(EN).filter(
      (k) => k.startsWith("recovery.") || k.startsWith("switcher.recovery."),
    );
    expect(recoveryKeys.length).toBeGreaterThan(10);
    for (const key of recoveryKeys) {
      const value = (EN as Record<string, string>)[key] ?? "";
      for (const phrase of forbidden) {
        expect(`${key}: ${value.toLowerCase()}`).not.toContain(phrase);
      }
    }
  });
});
