import { describe, expect, test } from "bun:test";
import {
  createHistory,
  diffSummaryLabel,
  documentsLabel,
  formatDelta,
  formatWhen,
  versionLabel,
  type HistoryDeps,
  type SnapshotRow,
  type VersionRow,
} from "../src/history";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = 1_700_000_000_000;

function version(over: Partial<VersionRow> = {}): VersionRow {
  return {
    id: 1,
    created_at: NOW - 10 * MINUTE,
    words: 100,
    snapshot_label: null,
    snapshot_id: null,
    ...over,
  };
}

describe("formatWhen", () => {
  test("a version taken moments ago says so rather than showing 0 minutes", () => {
    expect(formatWhen(NOW - 3000, NOW)).toBe("just now");
  });

  test("minutes, singular and plural", () => {
    expect(formatWhen(NOW - MINUTE, NOW)).toBe("1 minute ago");
    expect(formatWhen(NOW - 14 * MINUTE, NOW)).toBe("14 minutes ago");
  });

  test("hours take over where minutes stop being readable", () => {
    expect(formatWhen(NOW - 3 * HOUR, NOW)).toBe("3 hours ago");
  });

  test("days, and then the locale's own date", () => {
    expect(formatWhen(NOW - 3 * DAY, NOW)).toBe("3 days ago");
    // Beyond a week the relative form stops helping. The exact string is the
    // runtime's, so the claim is only that it is NOT relative any more.
    expect(formatWhen(NOW - 40 * DAY, NOW)).not.toContain("ago");
  });

  test("a clock skew that puts a version in the future does not render a negative", () => {
    // now_ms() is the host's clock and Date.now() is the page's. They are the
    // same clock today; a rendered "-4 minutes ago" would be the first sign
    // they had stopped being.
    expect(formatWhen(NOW + 5 * MINUTE, NOW)).toBe("just now");
  });
});

describe("formatDelta", () => {
  test("no previous version and no change are different answers", () => {
    // A writer looking for the version before they cut a chapter has to be able
    // to tell "unchanged" from "unknown".
    expect(formatDelta(100, undefined)).toBe("");
    expect(formatDelta(100, 100)).toBe("no change");
  });

  test("a gain is signed and a loss uses a real minus sign", () => {
    expect(formatDelta(1200, 1000)).toBe("+200");
    expect(formatDelta(1000, 1900)).toBe("−900");
  });
});

describe("versionLabel", () => {
  test("the accessible name carries the figures, not the rendered words", () => {
    const label = versionLabel(version({ words: 1240 }), 1060, NOW);
    expect(label).toBe("10 minutes ago, 1,240 words, 180 more than the version before");
  });

  test("a loss is said as a loss rather than as a signed number", () => {
    expect(versionLabel(version({ words: 100 }), 900, NOW)).toContain("800 fewer than");
  });

  test("an equal-length version says so", () => {
    expect(versionLabel(version({ words: 100 }), 100, NOW)).toContain("the same length as");
  });

  test("the oldest version claims nothing about a version before it", () => {
    expect(versionLabel(version({ words: 100 }), undefined, NOW)).toBe("10 minutes ago, 100 words");
  });

  test("a snapshot version is named by its label", () => {
    const label = versionLabel(
      version({ snapshot_label: "before the cut", snapshot_id: 3 }),
      undefined,
      NOW,
    );
    expect(label).toContain('snapshot "before the cut"');
  });
});

/** One stored body, as the host holds it: this schema's JSON, one paragraph per
 *  argument. The panel projects it through the editor's schema, so a test that
 *  fed it plain text would be testing a format the store never produces. */
function body(...paragraphs: string[]): string {
  return JSON.stringify({
    type: "doc",
    content: paragraphs.map((text) => ({
      type: "paragraph",
      content: text === "" ? [] : [{ type: "text", text }],
    })),
  });
}

interface Rig {
  readonly container: HTMLElement;
  readonly history: ReturnType<typeof createHistory>;
  readonly calls: string[];
  readonly done: string[];
  readonly notices: string[];
  readonly applied: { body: string; rev: number }[];
  destroy(): void;
}

function mount(
  over: Partial<HistoryDeps> = {},
  opts: {
    versions?: VersionRow[];
    snapshots?: SnapshotRow[];
    currentBody?: string;
    versionBody?: string;
  } = {},
): Rig {
  const container = document.createElement("div");
  document.body.append(container);
  const calls: string[] = [];
  const done: string[] = [];
  const notices: string[] = [];
  const applied: { body: string; rev: number }[] = [];
  const history = createHistory({
    container,
    drain: async () => {
      calls.push("drain");
    },
    activeDocId: () => "scene-1",
    revOf: () => 7,
    versions: async (itemId) => {
      calls.push(`versions:${itemId}`);
      return opts.versions ?? [];
    },
    restore: async (itemId, versionId, baseRev) => {
      calls.push(`restore:${itemId}:${versionId}:${baseRev}`);
      return { rev: baseRev + 1, body: '{"type":"doc","content":[]}' };
    },
    currentBody: async (itemId) => {
      calls.push(`currentBody:${itemId}`);
      return opts.currentBody ?? body("the sea was calm and the boat was small");
    },
    versionBody: async (versionId) => {
      calls.push(`versionBody:${versionId}`);
      return opts.versionBody ?? body("the sea was calm");
    },
    snapshots: async () => {
      calls.push("snapshots");
      return opts.snapshots ?? [];
    },
    takeSnapshot: async (label) => {
      calls.push(`take:${label}`);
      return { id: 9, label, created_at: NOW, documents: 12 };
    },
    restoreSnapshot: async (id) => {
      calls.push(`restoreSnapshot:${id}`);
      return { documents: 4, covered: 12 };
    },
    applyRestored: (body, rev) => {
      applied.push({ body, rev });
    },
    reloadProject: async () => {
      calls.push("reload");
    },
    onDone: (m) => done.push(m),
    onNotice: (m) => notices.push(m),
    onDismiss: () => calls.push("dismiss"),
    now: () => NOW,
    ...over,
  });
  return {
    container,
    history,
    calls,
    done,
    notices,
    applied,
    destroy() {
      history.destroy();
      container.remove();
    },
  };
}

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

const rows = (): VersionRow[] => [
  { id: 3, created_at: NOW - MINUTE, words: 1200, snapshot_label: null, snapshot_id: null },
  { id: 2, created_at: NOW - 20 * MINUTE, words: 1000, snapshot_label: "act one", snapshot_id: 1 },
  { id: 1, created_at: NOW - 3 * HOUR, words: 400, snapshot_label: null, snapshot_id: null },
];

describe("documentsLabel", () => {
  test("a manuscript of one scene is not '1 documents'", () => {
    // Every new project starts in that state, so the singular is the first
    // thing a writer sees. Found by a screenshot, which is the fourth time in
    // this repo.
    expect(documentsLabel(1)).toBe("1 document");
    expect(documentsLabel(0)).toBe("0 documents");
    expect(documentsLabel(15200)).toBe("15,200 documents");
  });
});

describe("diffSummaryLabel", () => {
  test("both figures, because the row's delta is net", () => {
    expect(diffSummaryLabel(142, 89)).toBe("142 words added, 89 removed since this version.");
  });

  test("a version nothing was added to still says what the number counts", () => {
    expect(diffSummaryLabel(0, 89)).toBe("89 words removed since this version.");
    expect(diffSummaryLabel(0, 1)).toBe("1 word removed since this version.");
  });

  test("an identical pair is said in words, not rendered as an empty box", () => {
    expect(diffSummaryLabel(0, 0)).toContain("No difference");
  });

  test("the direction is in the sentence rather than left to the reader", () => {
    expect(diffSummaryLabel(3, 0)).toBe("3 words added since this version.");
  });
});

describe("the panel", () => {
  test("a delta compares against the version BELOW, because the list is newest first", async () => {
    // Getting this backwards renders every figure as its own negation, which
    // reads perfectly plausibly and is wrong for every row.
    const rig = mount({}, { versions: rows() });
    try {
      await rig.history.open();
      const deltas = [...rig.container.querySelectorAll(".history-delta")].map(
        (el) => el.textContent,
      );
      expect(deltas).toEqual(["+200", "+600", ""]);
    } finally {
      rig.destroy();
    }
  });

  test("an empty snapshot list says so rather than painting nothing", async () => {
    // The recorded defect: an empty listbox is indistinguishable from one that
    // failed to paint, and `renderProjects` shipped that way for six slices.
    const rig = mount({}, { versions: rows() });
    try {
      await rig.history.open();
      expect(rig.container.querySelector("#snapshot-empty")).not.toBeNull();
    } finally {
      rig.destroy();
    }
  });

  test("a scene with no history says so rather than showing an empty list", async () => {
    const rig = mount();
    try {
      await rig.history.open();
      expect(rig.container.querySelector("#history-status")?.textContent).toContain(
        "No earlier versions",
      );
    } finally {
      rig.destroy();
    }
  });

  test("restoring drains first, sends the known rev, and hands the body back to the page", async () => {
    const rig = mount({}, { versions: rows() });
    try {
      await rig.history.open();
      rig.container.querySelector<HTMLButtonElement>(".history-restore")?.click();
      await settle();
      expect(rig.calls).toContain("drain");
      expect(rig.calls).toContain("restore:scene-1:3:7");
      expect(rig.applied).toEqual([{ body: '{"type":"doc","content":[]}', rev: 8 }]);
    } finally {
      rig.destroy();
    }
  });

  test("the drain happens BEFORE the rev is read", async () => {
    // Reading the rev first and draining after would send the rev the page held
    // before its own pending keystrokes were written, so the restore would be
    // refused - or, if the flush landed in between, silently overwritten.
    const order: string[] = [];
    const rig = mount(
      {
        drain: async () => {
          order.push("drain");
        },
        revOf: () => {
          order.push("revOf");
          return 7;
        },
      },
      { versions: rows() },
    );
    try {
      await rig.history.open();
      rig.container.querySelector<HTMLButtonElement>(".history-restore")?.click();
      await settle();
      expect(order).toEqual(["drain", "revOf"]);
    } finally {
      rig.destroy();
    }
  });

  test("an unknown rev refuses the restore and says why", async () => {
    // Guessing a base_rev is how the discipline becomes decorative, and what it
    // guards is the writer's most recent keystrokes.
    const rig = mount({ revOf: () => undefined }, { versions: rows() });
    try {
      await rig.history.open();
      rig.container.querySelector<HTMLButtonElement>(".history-restore")?.click();
      await settle();
      expect(rig.calls.some((c) => c.startsWith("restore:"))).toBe(false);
      expect(rig.notices.join(" ")).toContain("revision is not known");
    } finally {
      rig.destroy();
    }
  });

  test("a snapshot with no name is refused OUT LOUD, not by a bare return", async () => {
    const rig = mount();
    try {
      await rig.history.open();
      rig.container.querySelector<HTMLButtonElement>("#snapshot-take")?.click();
      await settle();
      expect(rig.calls.some((c) => c.startsWith("take:"))).toBe(false);
      expect(rig.notices.join(" ")).toContain("name");
    } finally {
      rig.destroy();
    }
  });

  test("taking a snapshot reports what it covered and clears the field", async () => {
    const rig = mount();
    try {
      await rig.history.open();
      const input = rig.container.querySelector<HTMLInputElement>("#snapshot-name");
      if (input === null) throw new Error("no name field");
      input.value = "before the cut";
      rig.container.querySelector<HTMLButtonElement>("#snapshot-take")?.click();
      await settle();
      expect(rig.calls).toContain("take:before the cut");
      expect(input.value).toBe("");
      expect(rig.done.join(" ")).toContain("12 documents");
    } finally {
      rig.destroy();
    }
  });

  test("restoring a whole snapshot takes TWO presses", async () => {
    // One press is not enough for an operation whose blast radius is the book.
    const snaps: SnapshotRow[] = [
      { id: 5, label: "act one", created_at: NOW - DAY, documents: 12 },
    ];
    const rig = mount({}, { snapshots: snaps });
    try {
      await rig.history.open();
      const row = rig.container.querySelector<HTMLButtonElement>(".snapshot-row");
      row?.click();
      await settle();
      expect(rig.calls.some((c) => c.startsWith("restoreSnapshot:"))).toBe(false);
      expect(row?.textContent).toContain("Really restore");

      row?.click();
      await settle(12);
      expect(rig.calls).toContain("restoreSnapshot:5");
      expect(rig.calls).toContain("reload");
      expect(rig.done.join(" ")).toContain("4 of 12");
    } finally {
      rig.destroy();
    }
  });

  test("a restore closes the panel and hands focus back", async () => {
    // Not a nicety. `refresh()` replaces the list's children, so the button
    // that was just pressed is destroyed and focus falls to <body> - a writer
    // who then types reaches nothing at all, anywhere. Found by the graded rig,
    // whose typing after a restore never reached the store.
    const rig = mount({}, { versions: rows() });
    try {
      await rig.history.open();
      rig.container.querySelector<HTMLButtonElement>(".history-restore")?.click();
      await settle();
      expect(rig.history.isOpen()).toBe(false);
      expect(rig.calls).toContain("dismiss");
    } finally {
      rig.destroy();
    }
  });

  test("a snapshot restore closes the panel and hands focus back", async () => {
    const snaps: SnapshotRow[] = [
      { id: 5, label: "act one", created_at: NOW - DAY, documents: 12 },
    ];
    const rig = mount({}, { snapshots: snaps });
    try {
      await rig.history.open();
      const row = rig.container.querySelector<HTMLButtonElement>(".snapshot-row");
      row?.click();
      await settle();
      row?.click();
      await settle(12);
      expect(rig.history.isOpen()).toBe(false);
      expect(rig.calls).toContain("dismiss");
    } finally {
      rig.destroy();
    }
  });

  test("the reload happens BEFORE the writer is told the restore is done", async () => {
    // Otherwise the banner says the manuscript is back while the editor is
    // still showing the body that was replaced, which is the one moment a
    // writer would test the claim.
    const order: string[] = [];
    const snaps: SnapshotRow[] = [
      { id: 5, label: "act one", created_at: NOW - DAY, documents: 12 },
    ];
    const rig = mount(
      {
        reloadProject: async () => {
          order.push("reload");
        },
        onDone: () => order.push("done"),
      },
      { snapshots: snaps },
    );
    try {
      await rig.history.open();
      const row = rig.container.querySelector<HTMLButtonElement>(".snapshot-row");
      row?.click();
      await settle();
      row?.click();
      await settle(12);
      expect(order).toEqual(["reload", "done"]);
    } finally {
      rig.destroy();
    }
  });

  test("closing the panel disarms a snapshot restore", async () => {
    // Otherwise the arm survives out of sight and the NEXT single press on that
    // row rewrites the manuscript, having asked nothing.
    const snaps: SnapshotRow[] = [
      { id: 5, label: "act one", created_at: NOW - DAY, documents: 12 },
    ];
    const rig = mount({}, { snapshots: snaps });
    try {
      await rig.history.open();
      let row = rig.container.querySelector<HTMLButtonElement>(".snapshot-row");
      row?.click();
      await settle();
      rig.container
        .querySelector("#history-panel")
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await rig.history.open();
      row = rig.container.querySelector<HTMLButtonElement>(".snapshot-row");
      row?.click();
      await settle();
      expect(rig.calls.some((c) => c.startsWith("restoreSnapshot:"))).toBe(false);
    } finally {
      rig.destroy();
    }
  });

  test("arming a second snapshot disarms the first", async () => {
    const snaps: SnapshotRow[] = [
      { id: 5, label: "act one", created_at: NOW - DAY, documents: 12 },
      { id: 6, label: "act two", created_at: NOW - HOUR, documents: 14 },
    ];
    const rig = mount({}, { snapshots: snaps });
    try {
      await rig.history.open();
      const all = [...rig.container.querySelectorAll<HTMLButtonElement>(".snapshot-row")];
      all[0]?.click();
      await settle();
      all[1]?.click();
      await settle();
      expect(all[0]?.hasAttribute("data-armed")).toBe(false);
      // And the first row is now a single press away from nothing, not from a
      // restore.
      all[0]?.click();
      await settle();
      expect(rig.calls.some((c) => c.startsWith("restoreSnapshot:"))).toBe(false);
    } finally {
      rig.destroy();
    }
  });

  test("Escape closes and hands focus back", async () => {
    const rig = mount();
    try {
      await rig.history.open();
      expect(rig.history.isOpen()).toBe(true);
      rig.container
        .querySelector("#history-panel")
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(rig.history.isOpen()).toBe(false);
      expect(rig.calls).toContain("dismiss");
    } finally {
      rig.destroy();
    }
  });

  test("a listing that resolves after destroy paints nothing", async () => {
    // The element is detached but its CONTAINER is not: #history-controls is
    // what the next project mounts into, which is the shape of the recorded
    // outline-after-teardown defect.
    let release: (rows: VersionRow[]) => void = () => undefined;
    const rig = mount({
      versions: () =>
        new Promise<VersionRow[]>((resolve) => {
          release = resolve;
        }),
    });
    const opening = rig.history.open();
    rig.history.destroy();
    release(rows());
    await opening;
    expect(rig.container.querySelectorAll(".history-row").length).toBe(0);
    rig.container.remove();
  });

  test("a failed listing says so rather than rendering the designed empty state", async () => {
    // The recorded `reloadImports` defect: a catch that paints "there is
    // nothing here" reports a host that could not READ as a project with no
    // history, and the writer acts on the confident sentence.
    const rig = mount({
      versions: async () => {
        throw new Error("no project is open");
      },
    });
    try {
      await rig.history.open();
      expect(rig.notices.join(" ")).toContain("Could not read");
      expect(rig.container.querySelector("#history-status")?.textContent).not.toContain(
        "No earlier versions",
      );
    } finally {
      rig.destroy();
    }
  });

  test("every row's accessible name carries its figures", async () => {
    const rig = mount({}, { versions: rows() });
    try {
      await rig.history.open();
      const names = [...rig.container.querySelectorAll(".history-row")].map((el) =>
        el.getAttribute("aria-label"),
      );
      expect(names[0]).toContain("1,200 words");
      expect(names[0]).toContain("200 more");
      expect(names[1]).toContain('snapshot "act one"');
    } finally {
      rig.destroy();
    }
  });

  test("comparing reports both figures, which the row's net delta cannot", async () => {
    const rig = mount(
      {},
      {
        versions: rows(),
        versionBody: body("the sea was calm"),
        currentBody: body("the sea was calm and the boat was small"),
      },
    );
    try {
      await rig.history.open();
      rig.container.querySelector<HTMLButtonElement>(".history-compare")?.click();
      await settle(12);
      // Six and one, not five and none: `diff.ts` compares a token together
      // with the whitespace that follows it, so the word at the seam - "calm",
      // which gained a following space when the sentence continued - is
      // reported as removed and re-added. That is the recorded cost of a diff
      // whose pieces join back into the exact text they came from, and the
      // summary must show what the diff actually marked rather than a tidier
      // number the body below it contradicts.
      expect(rig.container.querySelector("#history-diff-summary")?.textContent).toBe(
        "6 words added, 1 removed since this version.",
      );
    } finally {
      rig.destroy();
    }
  });

  test("the direction is in the visible words and in the accessible name", async () => {
    // A diff whose direction has to be inferred is one half its readers will
    // infer backwards, and being confidently backwards about which draft holds
    // a paragraph is worse than having no comparison at all.
    const rig = mount(
      {},
      {
        versions: rows(),
        versionBody: body("gone words here"),
        currentBody: body("here new words"),
      },
    );
    try {
      await rig.history.open();
      rig.container.querySelector<HTMLButtonElement>(".history-compare")?.click();
      await settle(12);
      const region = rig.container.querySelector("#history-diff");
      expect(rig.container.querySelector("#history-diff-summary")?.textContent).toContain(
        "since this version",
      );
      expect(rig.container.querySelector("#history-diff-legend")?.textContent).toContain(
        "in that version, not now",
      );
      expect(region?.getAttribute("aria-label")).toContain("as it is now");
      expect(region?.getAttribute("aria-label")).toContain("removed since that version");
      // And the control says which way round it runs BEFORE it is pressed.
      expect(
        rig.container.querySelector(".history-compare")?.getAttribute("aria-label"),
      ).toContain("with this scene as it is now");
    } finally {
      rig.destroy();
    }
  });

  test("the region says WHICH version it is comparing, on screen and not only in ARIA", async () => {
    // Found by capture: `aria-expanded` and the button's accessible name are
    // the whole of what identifies the comparison, and neither is visible. A
    // reader who compared one version and then another had nothing on screen
    // saying which of the two they were reading.
    const rig = mount({}, { versions: rows() });
    try {
      await rig.history.open();
      const buttons = [...rig.container.querySelectorAll<HTMLButtonElement>(".history-compare")];
      buttons[1]?.click();
      await settle(12);
      // Row 1 is the snapshot version, so the diff must call it what the row
      // calls it rather than by its timestamp.
      expect(rig.container.querySelector("#history-diff-of")?.textContent).toContain("act one");
      expect(rig.container.querySelector("#history-diff-of")?.textContent).toContain(
        "as it is now",
      );
    } finally {
      rig.destroy();
    }
  });

  test("the two sides are marked by ELEMENT, not by colour alone", async () => {
    // `del`/`ins` carry the distinction into the accessibility tree, where
    // there is no colour at all, and the stylesheet adds a strike and an
    // underline on top.
    const rig = mount(
      {},
      {
        versions: rows(),
        versionBody: body("the old ending"),
        currentBody: body("the new ending"),
      },
    );
    try {
      await rig.history.open();
      rig.container.querySelector<HTMLButtonElement>(".history-compare")?.click();
      await settle(12);
      expect(rig.container.querySelector("#history-diff-body del")?.textContent).toContain("old");
      expect(rig.container.querySelector("#history-diff-body ins")?.textContent).toContain("new");
    } finally {
      rig.destroy();
    }
  });

  test("only ONE diff is open at a time: comparing another version replaces it", async () => {
    // Two diffs in a 420px panel is a scroll fold, and the recorded
    // shortcuts-panel failure is that what sits below a fold does not exist for
    // the reader.
    const rig = mount({}, { versions: rows() });
    try {
      await rig.history.open();
      const buttons = [...rig.container.querySelectorAll<HTMLButtonElement>(".history-compare")];
      buttons[0]?.click();
      await settle(12);
      buttons[1]?.click();
      await settle(12);
      expect(rig.container.querySelectorAll("#history-diff").length).toBe(1);
      expect(buttons[0]?.getAttribute("aria-expanded")).toBe("false");
      expect(buttons[1]?.getAttribute("aria-expanded")).toBe("true");
      expect(rig.calls.filter((c) => c === "versionBody:2").length).toBe(1);
    } finally {
      rig.destroy();
    }
  });

  test("pressing Compare again on the open row puts the diff away", async () => {
    const rig = mount({}, { versions: rows() });
    try {
      await rig.history.open();
      const button = rig.container.querySelector<HTMLButtonElement>(".history-compare");
      button?.click();
      await settle(12);
      button?.click();
      await settle(12);
      expect(rig.container.querySelector<HTMLElement>("#history-diff")?.hidden).toBe(true);
      expect(button?.getAttribute("aria-expanded")).toBe("false");
    } finally {
      rig.destroy();
    }
  });

  test("the drain happens BEFORE either body is read", async () => {
    // The "now" side is the STORE's. Reading it while the writer's last
    // keystrokes are still unflushed makes the comparison describe a state the
    // store does not hold, and the diff then reports the writer's own sentence
    // as missing from the manuscript.
    const order: string[] = [];
    const rig = mount(
      {
        drain: async () => {
          order.push("drain");
        },
        currentBody: async () => {
          order.push("currentBody");
          return body("now");
        },
        versionBody: async () => {
          order.push("versionBody");
          return body("then");
        },
      },
      { versions: rows() },
    );
    try {
      await rig.history.open();
      rig.container.querySelector<HTMLButtonElement>(".history-compare")?.click();
      await settle(12);
      expect(order[0]).toBe("drain");
      expect(order).toContain("currentBody");
      expect(order).toContain("versionBody");
    } finally {
      rig.destroy();
    }
  });

  test("a comparison that cannot be read says so rather than saying nothing changed", async () => {
    // The recorded `reloadImports` defect, in its worst form here: "no
    // difference" is the one answer that tells a writer to stop looking.
    const rig = mount(
      {
        versionBody: async () => {
          throw new Error("no such version");
        },
      },
      { versions: rows() },
    );
    try {
      await rig.history.open();
      rig.container.querySelector<HTMLButtonElement>(".history-compare")?.click();
      await settle(12);
      expect(rig.notices.join(" ")).toContain("Could not compare");
      expect(rig.container.querySelector("#history-diff-summary")?.textContent).not.toContain(
        "No difference",
      );
      expect(rig.container.querySelector<HTMLElement>("#history-diff")?.hidden).toBe(true);
    } finally {
      rig.destroy();
    }
  });

  test("two identical bodies say 'No difference' in words rather than painting an empty box", async () => {
    const same = body("nothing moved at all");
    const rig = mount({}, { versions: rows(), versionBody: same, currentBody: same });
    try {
      await rig.history.open();
      rig.container.querySelector<HTMLButtonElement>(".history-compare")?.click();
      await settle(12);
      expect(rig.container.querySelector("#history-diff-summary")?.textContent).toContain(
        "No difference",
      );
      expect(rig.container.querySelector<HTMLElement>("#history-diff")?.hidden).toBe(false);
      // And the legend is not left captioning two marks that are not there.
      expect(rig.container.querySelector<HTMLElement>("#history-diff-legend")?.hidden).toBe(true);
    } finally {
      rig.destroy();
    }
  });

  test("a comparison that resolves after destroy paints nothing", async () => {
    let release: (b: string) => void = () => undefined;
    const rig = mount(
      {
        versionBody: () =>
          new Promise<string>((resolve) => {
            release = resolve;
          }),
      },
      { versions: rows() },
    );
    await rig.history.open();
    rig.container.querySelector<HTMLButtonElement>(".history-compare")?.click();
    await settle(4);
    rig.history.destroy();
    release(body("whatever this held"));
    await settle(12);
    expect(rig.container.querySelectorAll("#history-diff-body del").length).toBe(0);
    expect(rig.notices.join(" ")).toBe("");
    rig.container.remove();
  });

  test("a refresh takes the open diff down with the rows it described", async () => {
    // `renderVersions` replaces the list's children, so the button that owned
    // the diff is destroyed. A region left up is then describing a comparison
    // nothing on screen points at.
    const rig = mount({}, { versions: rows() });
    try {
      await rig.history.open();
      rig.container.querySelector<HTMLButtonElement>(".history-compare")?.click();
      await settle(12);
      expect(rig.container.querySelector<HTMLElement>("#history-diff")?.hidden).toBe(false);
      await rig.history.open();
      await settle(12);
      expect(rig.container.querySelector<HTMLElement>("#history-diff")?.hidden).toBe(true);
    } finally {
      rig.destroy();
    }
  });

  test("it adds no capture-phase document listener, and destroy leaves none", async () => {
    // 241: the inspector has no outside-click closer, so the count stays at
    // zero; this is what would notice one coming back. A leaked closeOnOutsideClick handler returns immediately when the panel is
    // hidden, so it changes no DOM state and no behaviour a test can reach while
    // accumulating one live closure per project switch. Counting is the only
    // thing that finds it - the recorded menu-bar defect.
    const realAdd = document.addEventListener.bind(document);
    const realRemove = document.removeEventListener.bind(document);
    let live = 0;
    document.addEventListener = ((...args: Parameters<typeof realAdd>) => {
      if (args[0] === "click") live += 1;
      return realAdd(...args);
    }) as typeof document.addEventListener;
    document.removeEventListener = ((...args: Parameters<typeof realRemove>) => {
      if (args[0] === "click") live -= 1;
      return realRemove(...args);
    }) as typeof document.removeEventListener;
    try {
      const rig = mount();
      await rig.history.open();
      expect(live).toBe(0);
      rig.destroy();
      expect(live).toBe(0);
    } finally {
      document.addEventListener = realAdd;
      document.removeEventListener = realRemove;
    }
  });
});
