import { describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createStatisticsPanel, type StatisticsPanelDeps } from "../src/statistics-panel";
import { STATISTICS_EMPTY, STATISTICS_NOTE, type SessionTotals } from "../src/statistics";
import type { DocumentStatisticsCounts } from "../src/outline-counts";
import type { ProjectItem } from "../src/store/source";
import { t } from "../src/i18n";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

function item(id: string, type: string, parent_id: string | null, title = id): ProjectItem {
  return { id, parent_id, type, title, position: id, rev: 1, state: null, depth: 0 };
}

const WALK: ProjectItem[] = [
  item("chapter-one", "chapter", null, "Chapter One"),
  item("s1", "scene", "chapter-one", "Arrival"),
  item("s2", "scene", "chapter-one", "Departure"),
];

const count = (words: number, sentences = 0, paragraphs = 0) => ({ words, sentences, paragraphs });

interface Rig {
  container: HTMLElement;
  panel: ReturnType<typeof createStatisticsPanel>;
  el(): HTMLElement;
  calls: { drains: number; counts: number; dismissed: number; tracking: number };
}

function mount(over: Partial<StatisticsPanelDeps> = {}): Rig {
  const container = document.createElement("span");
  document.body.append(container);
  const calls = { drains: 0, counts: 0, dismissed: 0, tracking: 0 };
  const deps: StatisticsPanelDeps = {
    container,
    drain: async () => {
      calls.drains += 1;
    },
    items: () => WALK,
    documentCounts: async (): Promise<DocumentStatisticsCounts> => {
      calls.counts += 1;
      return { s1: { words: 120, sentences: 8, paragraphs: 2 }, s2: { words: 30, sentences: 2, paragraphs: 1 } };
    },
    openItemId: () => "s1",
    session: (): SessionTotals => ({ added: 40, deleted: 12, net: 28 }),
    today: async () => ({ writingMinutes: 12, tracking: "on" as const }),
    setTracking: async () => {
      calls.tracking += 1;
    },
    setCollecting: async () => undefined,
    resetSources: async () => undefined,
    onDismiss: () => {
      calls.dismissed += 1;
    },
    ...over,
  };
  const panel = createStatisticsPanel(deps);
  return {
    container,
    panel,
    calls,
    el: () => {
      const found = container.querySelector<HTMLElement>("#stats-panel");
      if (found === null) throw new Error("the panel is not in the container");
      return found;
    },
  };
}

function teardown(rig: Rig): void {
  rig.panel.destroy();
  rig.container.remove();
}

function valueOf(rig: Rig, key: string): string | null {
  const row = rig.el().querySelector<HTMLElement>(`.stat-row[data-stat="${key}"]`);
  return row?.querySelector<HTMLElement>(".stat-value")?.textContent ?? null;
}

describe("opening and closing", () => {
  test("it mounts hidden and the note is there before anything is measured", () => {
    const rig = mount();
    try {
      expect(rig.el().hidden).toBe(true);
      expect(rig.el().querySelector("#stats-note")?.textContent).toBe(STATISTICS_NOTE);
    } finally {
      teardown(rig);
    }
  });

  test("open shows it, takes focus, and measures", async () => {
    const rig = mount();
    try {
      await rig.panel.open();
      expect(rig.el().hidden).toBe(false);
      expect(rig.panel.isOpen()).toBe(true);
      // Focus is on the panel because Escape only fires from inside it, and the
      // recorded failure of a panel nobody could dismiss is exactly this.
      expect(document.activeElement?.id).toBe("stats-panel");
      expect(rig.calls.counts).toBe(1);
    } finally {
      teardown(rig);
    }
  });

  test("it drains before it reads, so the last keystroke is counted", async () => {
    const order: string[] = [];
    const rig = mount({
      drain: async () => {
        order.push("drain");
      },
      documentCounts: async () => {
        order.push("counts");
        return { s1: count(1) };
      },
    });
    try {
      await rig.panel.open();
      expect(order).toEqual(["drain", "counts"]);
    } finally {
      teardown(rig);
    }
  });

  test("Escape closes it and hands focus back", async () => {
    const rig = mount();
    try {
      await rig.panel.open();
      rig.el().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      expect(rig.el().hidden).toBe(true);
      expect(rig.calls.dismissed).toBe(1);
    } finally {
      teardown(rig);
    }
  });

  test("another key does not close it", async () => {
    const rig = mount();
    try {
      await rig.panel.open();
      rig.el().dispatchEvent(
        new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }),
      );
      expect(rig.el().hidden).toBe(false);
      expect(rig.calls.dismissed).toBe(0);
    } finally {
      teardown(rig);
    }
  });

  test("a click outside leaves it open, as one inside does", async () => {
    // 241: the inspector. Clicking the prose beside it is the point, so an
    // outside click leaves it open, exactly as it leaves the preview rail.
    const outside = document.createElement("button");
    document.body.append(outside);
    const rig = mount();
    try {
      await rig.panel.open();
      rig.el().click();
      expect(rig.el().hidden).toBe(false);
      outside.click();
      expect(rig.el().hidden).toBe(false);
      expect(rig.calls.dismissed).toBe(0);
    } finally {
      teardown(rig);
      outside.remove();
    }
  });

  test("reopening measures again rather than showing what it showed before", async () => {
    const rig = mount();
    try {
      await rig.panel.open();
      await rig.panel.open();
      expect(rig.calls.counts).toBe(2);
      expect(rig.calls.drains).toBe(2);
    } finally {
      teardown(rig);
    }
  });
});

describe("what it paints", () => {
  test("the figures reach the panel", async () => {
    const rig = mount();
    try {
      await rig.panel.open();
      expect(valueOf(rig, "scene")).toBe("120");
      expect(valueOf(rig, "chapter")).toBe("150");
      expect(valueOf(rig, "manuscript")).toBe("150");
      expect(valueOf(rig, "scenes")).toBe("2");
      expect(valueOf(rig, "added")).toBe("40");
      expect(valueOf(rig, "deleted")).toBe("12");
      expect(valueOf(rig, "net")).toBe("28");
    } finally {
      teardown(rig);
    }
  });

  test("every row's definition is one help mark away, named and described, never printed under it", async () => {
    // The definitions crowded the page. Each is now the
    // tooltip of a help mark after the label and that mark's accessible
    // description, so it is moved, not deleted.
    const rig = mount();
    try {
      await rig.panel.open();
      const rows = [...rig.el().querySelectorAll<HTMLElement>(".stat-row")];
      expect(rows.length).toBe(32);
      for (const row of rows) {
        const label = row.querySelector<HTMLElement>(".stat-label")?.textContent ?? "";
        const help = row.querySelector<HTMLButtonElement>("button.help-tip")!;
        expect(help.id).toBe(`stats-help-${row.dataset.stat}`);
        expect(help.getAttribute("aria-label")).toBe(`About ${label}`);
        const definition = document.getElementById(help.getAttribute("aria-describedby")!)!;
        expect(definition.hidden).toBe(true);
        expect((definition.textContent ?? "").length).toBeGreaterThan(40);
        // The row's name is the label and the figure; the definition is heard
        // on the mark, not repeated on every row.
        expect(row.getAttribute("aria-label")).toBe(`${label}: ${row.querySelector(".stat-value")?.textContent}`);
        // Nothing on screen but the label, the mark and the figure (and a
        // detail line where the figure names its scope).
        expect([...row.querySelectorAll("div")].every((div) => div.classList.contains("stat-line") || div.classList.contains("stat-detail"))).toBe(true);
      }
    } finally {
      teardown(rig);
    }
  });

  test("a help mark shows its definition on focus and on hover, and not at rest", async () => {
    const rig = mount();
    try {
      await rig.panel.open();
      const help = rig.el().querySelector<HTMLButtonElement>("#stats-help-scene")!;
      const anchor = help.parentElement!;
      expect(anchor.querySelector(".tip")).toBeNull();
      help.dispatchEvent(new Event("focus"));
      expect(anchor.querySelector(".tip")?.textContent).toBe(document.getElementById("stats-help-scene-text")?.textContent);
      help.dispatchEvent(new Event("blur"));
      expect(anchor.querySelector(".tip")).toBeNull();
      help.dispatchEvent(new Event("mouseenter"));
      expect(anchor.querySelector(".tip")).not.toBeNull();
    } finally {
      teardown(rig);
    }
  });

  test("a failed reading takes the previous one off the screen", async () => {
    // The early clear, which the successful path's replaceChildren hides: a
    // failure or an empty state never reaches `paint`, so without it the panel
    // shows a failure message OVER a table of figures nobody can date.
    const fail = { now: false };
    const rig = mount({
      documentCounts: async () => {
        if (fail.now) throw new Error("no");
        return { s1: count(120, 8, 2), s2: count(30, 2, 1) };
      },
    });
    try {
      await rig.panel.open();
      expect(rig.el().querySelectorAll(".stat-row").length).toBe(32);
      fail.now = true;
      await rig.panel.open();
      expect(rig.el().querySelectorAll(".stat-row").length).toBe(0);
      expect(rig.el().querySelector("#stats-status")?.textContent).toContain("Could not read");
    } finally {
      teardown(rig);
    }
  });

  test("nothing is left over from a previous reading", async () => {
    const counts = { value: { s1: count(120, 8, 2), s2: count(30, 2, 1) } as DocumentStatisticsCounts };
    const rig = mount({ documentCounts: async () => counts.value });
    try {
      await rig.panel.open();
      expect(valueOf(rig, "manuscript")).toBe("150");
      counts.value = { s1: count(5), s2: count(5) };
      await rig.panel.open();
      expect(valueOf(rig, "manuscript")).toBe("10");
      expect(rig.el().querySelectorAll(".stat-row").length).toBe(32);
    } finally {
      teardown(rig);
    }
  });
});

describe("the states that are not a table", () => {
  test("a manuscript with no scenes says so rather than painting zeros", async () => {
    const rig = mount({
      items: () => [item("chapter-one", "chapter", null, "Chapter One")],
      documentCounts: async () => ({}),
    });
    try {
      await rig.panel.open();
      expect(rig.el().querySelector("#stats-status")?.textContent).toBe(STATISTICS_EMPTY);
      expect(rig.el().querySelectorAll(".stat-row").length).toBe(0);
    } finally {
      teardown(rig);
    }
  });

  test("a failed reading says it failed, and does not paint the empty state", async () => {
    // THE RECORDED DEFECT THIS AVOIDS: a catch that renders the designed empty
    // state reports a host that could not answer as a manuscript holding
    // nothing, and the confident sentence is the one a reader acts on.
    const rig = mount({
      documentCounts: async () => {
        throw new Error("no");
      },
    });
    try {
      await rig.panel.open();
      const status = rig.el().querySelector("#stats-status")?.textContent ?? "";
      expect(status).toContain("Could not read");
      expect(status).not.toBe(STATISTICS_EMPTY);
      expect(rig.el().querySelectorAll(".stat-row").length).toBe(0);
    } finally {
      teardown(rig);
    }
  });

  test("a drain that fails is a failed reading, not a silent zero", async () => {
    const rig = mount({
      drain: async () => {
        throw new Error("no");
      },
    });
    try {
      await rig.panel.open();
      expect(rig.el().querySelector("#stats-status")?.textContent).toContain("Could not read");
      expect(rig.calls.counts).toBe(0);
    } finally {
      teardown(rig);
    }
  });

  test("a reading that lands after a newer one does not repaint", async () => {
    // Two opens in flight at once. The first must not overwrite the second's
    // figures, or a reader acts on numbers describing a manuscript that has
    // moved under them.
    const gates: Array<() => void> = [];
    const answers: DocumentStatisticsCounts[] = [
      { s1: count(1), s2: count(1) },
      { s1: count(500), s2: count(500) },
    ];
    const rig = mount({
      documentCounts: () =>
        new Promise<DocumentStatisticsCounts>((resolve) => {
          const answer = answers.shift() ?? {};
          gates.push(() => resolve(answer));
        }),
    });
    try {
      const first = rig.panel.open();
      // A tick, because the panel drains before it reads: without it neither
      // call has reached documentCounts yet and there is no gate to open.
      await Bun.sleep(0);
      const second = rig.panel.open();
      await Bun.sleep(0);
      expect(gates.length).toBe(2);
      // The SECOND resolves first, then the stale one lands.
      gates[1]?.();
      await second;
      gates[0]?.();
      await first;
      expect(valueOf(rig, "manuscript")).toBe((1000).toLocaleString());
    } finally {
      teardown(rig);
    }
  });

  test("a reading that lands after destroy touches nothing", async () => {
    // A mutable RECORD, not a `let`: a local assigned only inside a closure is
    // narrowed to its initializer's type for the rest of the file, which is the
    // recorded way a guard type-checks while asserting nothing.
    const gate: { release: (() => void) | null } = { release: null };
    const rig = mount({
      documentCounts: () =>
        new Promise<DocumentStatisticsCounts>((resolve) => {
          gate.release = () => resolve({ s1: count(7), s2: count(7) });
        }),
    });
    // Held BEFORE the teardown, because `destroy` removes it from the container
    // and an assertion that only looks in the container passes whether or not
    // the late reading painted into the detached element.
    const element = rig.el();
    const pending = rig.panel.open();
    await Bun.sleep(0);
    expect(gate.release).not.toBeNull();
    rig.panel.destroy();
    gate.release?.();
    await pending;
    expect(rig.container.querySelector("#stats-panel")).toBeNull();
    expect(element.querySelectorAll(".stat-row").length).toBe(0);
    rig.container.remove();
  });
});

describe("teardown", () => {
  test("destroy removes every document listener it added", () => {
    // Counting, not symptom-hunting: the outside-click closer is on the
    // document and a leaked copy changes nothing observable while accumulating
    // one live closure per project switch. The recorded shape only counting
    // finds.
    const added: string[] = [];
    const removed: string[] = [];
    const realAdd = document.addEventListener.bind(document);
    const realRemove = document.removeEventListener.bind(document);
    document.addEventListener = ((type: string, ...rest: unknown[]) => {
      added.push(type);
      return (realAdd as unknown as (...a: unknown[]) => void)(type, ...rest);
    }) as typeof document.addEventListener;
    document.removeEventListener = ((type: string, ...rest: unknown[]) => {
      removed.push(type);
      return (realRemove as unknown as (...a: unknown[]) => void)(type, ...rest);
    }) as typeof document.removeEventListener;
    try {
      const rig = mount();
      // 241: no outside-click closer on the inspector.
      expect(added).not.toContain("click");
      rig.panel.destroy();
      rig.container.remove();
      expect(removed.slice().sort()).toEqual(added.slice().sort());
    } finally {
      document.addEventListener = realAdd;
      document.removeEventListener = realRemove;
    }
  });

  test("destroy takes the panel out of the container", () => {
    const rig = mount();
    rig.panel.destroy();
    expect(rig.container.querySelector("#stats-panel")).toBeNull();
    rig.container.remove();
  });

  test("an outside click after destroy does nothing", () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    const rig = mount();
    rig.panel.destroy();
    outside.click();
    expect(rig.calls.dismissed).toBe(0);
    rig.container.remove();
    outside.remove();
  });
});

describe("the time switch", () => {
  test("the switch names the opposite state, persists it, and the panel re-reads", async () => {
    const state: { tracking: "on" | "off" } = { tracking: "on" };
    const rig = mount({
      today: async () => ({ writingMinutes: 12, tracking: state.tracking }),
      setTracking: async (next) => {
        state.tracking = next;
      },
    });
    try {
      await rig.panel.open();
      const button = rig.el().querySelector<HTMLButtonElement>("#stats-tracking");
      expect(button?.hidden).toBe(false);
      expect(button?.textContent).toBe("Stop counting my time");
      const reads = rig.calls.counts;
      button?.click();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(state.tracking).toBe("off");
      expect(rig.calls.counts).toBe(reads + 1);
      expect(button?.textContent).toBe("Count my time again");
      expect(rig.el().querySelector('[data-stat="writing-time"] .help-tip-text')?.textContent).toContain("Not counted");
    } finally {
      teardown(rig);
    }
  });
});

describe("the saved-word controls", () => {
  const sources = (collecting: boolean) => ({
    available: true, collecting, interrupted: false, started_at: 1_600_000_000_000, today_typing: 3, warning: null,
    totals: { typing: { added: 3, deleted: 0 }, pasted: { added: 0, deleted: 0 }, imported: { added: 0, deleted: 0 },
      restored: { added: 0, deleted: 0 }, unattributed: { added: 0, deleted: 0 } },
  });
  const tick = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  };
  const q = (rig: Rig, id: string) => rig.el().querySelector<HTMLElement>(`#${id}`);

  test("pause persists through the caller, the panel re-reads, and the label and definitions follow", async () => {
    const state = { collecting: true, calls: [] as boolean[] };
    const rig = mount({
      today: async () => ({ writingMinutes: 1, tracking: "on" as const, sources: sources(state.collecting) }),
      setCollecting: async (next) => {
        state.calls.push(next);
        state.collecting = next;
      },
    });
    try {
      await rig.panel.open();
      expect(q(rig, "stats-sources-controls")?.hidden).toBe(false);
      expect(q(rig, "stats-sources-collect")?.textContent).toBe("Pause counting saved words");
      q(rig, "stats-sources-collect")?.click();
      await tick();
      expect(state.calls).toEqual([false]);
      expect(q(rig, "stats-sources-collect")?.textContent).toBe("Resume counting saved words");
      expect(rig.el().querySelector('[data-stat="typing-today"] .help-tip-text')?.textContent)
        .toContain("Counting is paused");
    } finally {
      teardown(rig);
    }
  });

  test("reset arms on one button and acts only on a separate confirm beside the scope text", async () => {
    let resets = 0;
    const rig = mount({
      today: async () => ({ writingMinutes: 1, tracking: "on" as const, sources: sources(true) }),
      resetSources: async () => {
        resets += 1;
      },
    });
    try {
      await rig.panel.open();
      const reset = q(rig, "stats-sources-reset");
      const group = q(rig, "stats-sources-reset-confirm-group");
      expect(group?.hidden).toBe(true);
      reset?.click();
      await tick();
      expect(resets).toBe(0);
      expect(group?.hidden).toBe(false);
      expect(reset?.textContent).toBe("Cancel reset");
      expect(q(rig, "stats-sources-reset-confirm")?.textContent).toBe("Delete the counts and start again");
      const note = q(rig, "stats-sources-reset-note")?.textContent ?? "";
      expect(note).toContain("deletes the saved-word counts");
      expect(note).toContain("manuscript, version history, snapshots, time writing");
      q(rig, "stats-sources-reset-confirm")?.click();
      await tick();
      expect(resets).toBe(1);
      expect(group?.hidden).toBe(true);
    } finally {
      teardown(rig);
    }
  });

  test("a double-click or a held Enter on the arming control never resets", async () => {
    let resets = 0;
    const rig = mount({
      today: async () => ({ writingMinutes: 1, tracking: "on" as const, sources: sources(true) }),
      resetSources: async () => {
        resets += 1;
      },
    });
    try {
      await rig.panel.open();
      const reset = q(rig, "stats-sources-reset");
      reset?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      reset?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
      reset?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));
      await tick();
      expect(resets).toBe(0);
      // A button activated by Enter clicks once per auto-repeated keydown.
      for (let i = 0; i < 7; i++) {
        reset?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", repeat: i > 0, bubbles: true }));
        reset?.click();
      }
      await tick();
      expect(resets).toBe(0);
    } finally {
      teardown(rig);
    }
  });

  test("closing the panel disarms a pending reset", async () => {
    let resets = 0;
    const rig = mount({
      today: async () => ({ writingMinutes: 1, tracking: "on" as const, sources: sources(true) }),
      resetSources: async () => {
        resets += 1;
      },
    });
    try {
      await rig.panel.open();
      q(rig, "stats-sources-reset")?.click();
      rig.el().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await rig.panel.open();
      expect(q(rig, "stats-sources-reset-confirm-group")?.hidden).toBe(true);
      q(rig, "stats-sources-reset-confirm")?.click();
      await tick();
      expect(resets).toBe(0);
    } finally {
      teardown(rig);
    }
  });

  test("after a command repaints, focus stays in the panel and Escape still closes it", async () => {
    const fail = { now: false };
    const rig = mount({
      today: async () => ({ writingMinutes: 1, tracking: "on" as const, sources: sources(true) }),
      documentCounts: async () => {
        if (fail.now) throw new Error("no");
        return { s1: count(1), s2: count(1) };
      },
    });
    try {
      await rig.panel.open();
      q(rig, "stats-sources-reset")?.click();
      q(rig, "stats-sources-reset-confirm")?.focus();
      q(rig, "stats-sources-reset-confirm")?.click();
      await tick();
      // The confirm is gone after the repaint; its place is the arming control.
      expect(document.activeElement?.id).toBe("stats-sources-reset");

      fail.now = true;
      q(rig, "stats-sources-collect")?.focus();
      q(rig, "stats-sources-collect")?.click();
      await tick();
      // No controls after a failed reading: the panel itself holds focus.
      expect(document.activeElement?.id).toBe("stats-panel");
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      expect(rig.el().hidden).toBe(true);
    } finally {
      teardown(rig);
    }
  });

  test("a refused command is said, and the controls work again", async () => {
    const rig = mount({
      today: async () => ({ writingMinutes: 1, tracking: "on" as const, sources: sources(true) }),
      setCollecting: async () => {
        throw new Error("the open book changed");
      },
    });
    try {
      await rig.panel.open();
      q(rig, "stats-sources-collect")?.click();
      await tick();
      expect(q(rig, "stats-sources-error")?.hidden).toBe(false);
      expect(q(rig, "stats-sources-error")?.textContent).toContain("the open book changed");
      expect((q(rig, "stats-sources-collect") as HTMLButtonElement).disabled).toBe(false);
      expect(q(rig, "stats-sources-collect")?.textContent).toBe("Pause counting saved words");
    } finally {
      teardown(rig);
    }
  });

  test("controls are hidden without source figures, and a later failed reading hides them again", async () => {
    const fail = { now: false };
    const rig = mount({
      today: async () => ({ writingMinutes: 1, tracking: "on" as const, sources: sources(true) }),
      documentCounts: async () => {
        if (fail.now) throw new Error("no");
        return { s1: count(1), s2: count(1) };
      },
    });
    const bare = mount();
    try {
      await bare.panel.open();
      expect(bare.el().querySelector<HTMLElement>("#stats-sources-controls")?.hidden).toBe(true);
      await rig.panel.open();
      expect(q(rig, "stats-sources-controls")?.hidden).toBe(false);
      fail.now = true;
      await rig.panel.open();
      expect(q(rig, "stats-sources-controls")?.hidden).toBe(true);
    } finally {
      teardown(rig);
      teardown(bare);
    }
  });

  test("destroy removes the control listeners", async () => {
    let calls = 0;
    const rig = mount({
      today: async () => ({ writingMinutes: 1, tracking: "on" as const, sources: sources(true) }),
      setCollecting: async () => {
        calls += 1;
      },
    });
    await rig.panel.open();
    const collect = q(rig, "stats-sources-collect");
    rig.panel.destroy();
    collect?.click();
    await tick();
    expect(calls).toBe(0);
    rig.container.remove();
  });
});

describe("the two statistics files are the footer's actions (240)", () => {
  test("each button asks for its own format, and none is drawn without a host", () => {
    const asked: string[] = [];
    const rig = mount({ exportFile: (kind) => asked.push(kind) });
    const csv = rig.el().querySelector<HTMLButtonElement>(".panel-footer #stats-export-csv");
    const json = rig.el().querySelector<HTMLButtonElement>(".panel-footer #stats-export-json");
    expect(csv?.textContent).toBe(t("stats.export.csv"));
    expect(json?.textContent).toBe(t("stats.export.json"));
    csv?.click();
    json?.click();
    expect(asked).toEqual(["csv", "json"]);
    teardown(rig);

    const bare = mount();
    expect(bare.el().querySelector(".panel-footer")).toBeNull();
    expect(bare.el().querySelector("#stats-export-csv")).toBeNull();
    teardown(bare);
  });
});
