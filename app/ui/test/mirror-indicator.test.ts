// app/ui/test/mirror-indicator.test.ts
// The bar's third statement: is the folder I can open in another editor
// keeping up with what I have typed.
//
// Read beside `archive-indicator.test.ts` and `recovery-indicator.test.ts`.
// Those two are about protection and this one is not about protection at all,
// which is why every assertion here is about CURRENCY -- whether the folder
// matches the book -- and never about whether the book is safe.

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { beforeEach, describe as suite, expect, test } from "bun:test";
import {
  createMirrorIndicator,
  describe,
  type MirrorReport,
} from "../src/mirror-indicator";
import { EN } from "../src/i18n/en";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

const NOW = 1_787_174_042_000;
const HOUR = 3_600_000;

const report = (over: Partial<MirrorReport> = {}): MirrorReport => ({
  enabled: true,
  dir: "/w/manuscripts/my-book",
  files: 12,
  generated_at: NOW - 2000,
  last_ok: true,
  last_error: null,
  last_run_ms: NOW - 2000,
  paused: 0,
  updating: false,
  finding: null,
  identity_check: "clear",
  ...over,
});

let container: HTMLElement;
beforeEach(() => {
  document.body.replaceChildren();
  container = document.createElement("span");
  document.body.append(container);
});

suite("the five states", () => {
  test("a folder that matches the book is current", () => {
    const view = describe(report(), NOW);
    expect(view.state).toBe("current");
    expect(view.text).toBe(EN["mirror.text.current"]);
  });

  test("a pass that is owed reads updating and not current", () => {
    // The bound is ten seconds. Without this state the line would say
    // `current` for the whole of the gap between a writer typing a sentence
    // and the pass that catches the folder up -- which is the one falsehood
    // this indicator exists to prevent.
    expect(describe(report({ updating: true }), NOW).state).toBe("updating");
  });

  test("a project the writer never turned the mirror on for is off", () => {
    // OFF IS NOT A FAILURE. It is the default for every project, and a line
    // that read as a problem would push writers into turning on a folder they
    // did not ask for.
    const view = describe(report({ enabled: false, files: 0, generated_at: null }), NOW);
    expect(view.state).toBe("off");
    expect(view.text).toBe(EN["mirror.text.off"]);
  });

  test("a mirror switched off after it wrote files is dated, not blank", () => {
    // Disabling LEAVES THE FILES, and they are as old as the moment it was
    // switched off. A plain "No folder" would describe a directory of the
    // writer's prose that is still sitting there.
    const view = describe(
      report({ enabled: false, files: 12, generated_at: NOW - 3 * HOUR }),
      NOW,
    );
    expect(view.state).toBe("stale");
    expect(view.text).toContain("3 hours ago");
  });

  test("a failed pass names the cause", () => {
    // The design requires this state to name WHICH failure. "The mirror is
    // failing" with no cause is a sentence a writer can do nothing with.
    const view = describe(
      report({ last_ok: false, last_error: "Permission denied (os error 13)" }),
      NOW,
    );
    expect(view.state).toBe("failing");
    expect(view.label).toContain("Permission denied (os error 13)");
  });

  test("an external edit pauses, and the line says how many and that we are leaving it alone", () => {
    const view = describe(report({ paused: 1, generated_at: NOW - 3 * HOUR }), NOW);
    expect(view.state).toBe("paused");
    expect(view.text).toContain("3 hours ago");
    expect(view.label).toContain("1 file");
    expect(view.label).toContain("not writing over it");
  });

  test("more than one paused file is counted, not summarised", () => {
    expect(describe(report({ paused: 4 }), NOW).label).toContain("4 files");
  });

  test("a finding is reported ON a current folder and never as a pause", () => {
    // THE MUTATION THIS FILE EXISTS FOR. The design spends a paragraph
    // forbidding exactly this confusion: a finding does not pause the mirror,
    // does not skip the entry and does not fail the pass. Rendering it as
    // `paused` would claim the folder is out of date at the moment it is
    // exactly current -- and it is invisible to any test that only counts how
    // many states there are.
    const view = describe(report({ finding: "0002-Winter-Cafe/0001-Letter-Storm.md" }), NOW);
    expect(view.state).toBe("finding");
    expect(view.label).toContain("0002-Winter-Cafe/0001-Letter-Storm.md");
    expect(view.text.toLowerCase()).toContain("current");
    expect(view.text.toLowerCase()).not.toContain("paused");
  });

  test("a finding never outranks a real reason the folder is behind", () => {
    // `finding` means "current, with a finding". A folder that is failing or
    // paused is NOT current, so the finding cannot be the headline: the writer
    // would be told about a name to check while the folder quietly stopped
    // being written.
    expect(describe(report({ finding: "somewhere.md", paused: 2 }), NOW).state).toBe("paused");
    expect(
      describe(report({ finding: "somewhere.md", last_ok: false, last_error: "no" }), NOW).state,
    ).toBe("failing");
  });

  test("an older folder without a disclosure record is not reported as clean", () => {
    const view = describe(report({ identity_check: "unavailable" }), NOW);
    expect(view.state).toBe("unavailable");
    expect(view.text).toContain("unavailable");
    expect(view.label).toContain("Inspect the folder");
  });

  test("no configured comparison names has a neutral, truthful state", () => {
    const view = describe(report({ identity_check: "not_applicable" }), NOW);
    expect(view.state).toBe("not_applicable");
    expect(view.text).toContain("no comparison names");
    expect(view.label).toContain("was not checked");
  });

  test("a pause outranks a pass that is merely owed", () => {
    // Both are true at once whenever a writer keeps typing after an external
    // edit. `updating` would hide the pause until the next pass landed and
    // then flip to `paused`; the pause is the stable fact and the one the
    // writer has to act on.
    expect(describe(report({ paused: 1, updating: true }), NOW).state).toBe("paused");
  });

  test("a mirror turned on that has never written anything is updating", () => {
    // Not `current`: there is no folder yet to be current. The enable act
    // passes immediately, so this is the moment between the two.
    const view = describe(report({ files: 0, generated_at: null }), NOW);
    expect(view.state).toBe("updating");
  });
});

suite("the element", () => {
  test("it is a group and carries its state for the stylesheet and the rigs", () => {
    // role="group", NOT role="status", for `save-indicator.ts`'s recorded
    // finding: a folder that caught up while the writer was mid-sentence is
    // exactly the announcement the design forbids.
    const indicator = createMirrorIndicator({
      container,
      status: async () => report(),
    });
    const element = container.querySelector("#mirror-indicator");
    expect(element).not.toBeNull();
    expect(element?.getAttribute("role")).toBe("group");
    indicator.set(describe(report({ paused: 2 }), NOW));
    expect((element as HTMLElement).dataset.state).toBe("paused");
    indicator.destroy();
  });

  test("it opens on `off` rather than claiming a folder nobody has looked at", () => {
    // The first answer is one await away. A bar that said `current` before
    // anything had been read would be the lie this surface exists to prevent,
    // for the reason the two indicators beside it open on their negatives.
    createMirrorIndicator({ container, status: async () => report() });
    const element = container.querySelector("#mirror-indicator") as HTMLElement;
    expect(element.dataset.state).toBe("off");
  });

  test("every state change is reported to onState, the first one before the first await", async () => {
    const seen: string[] = [];
    const indicator = createMirrorIndicator({
      container,
      status: async () => report(),
      now: () => NOW,
      onState: (state) => seen.push(state),
    });
    expect(seen).toEqual(["off"]);
    await indicator.refresh();
    expect(seen).toEqual(["off", "current"]);
    indicator.destroy();
  });

  test("a bridge that stopped answering leaves the last thing said standing", () => {
    // A failed call says nothing about the folder on disk. Repainting the
    // negative here would report a missing mirror because an invoke failed.
    const indicator = createMirrorIndicator({
      container,
      status: async () => {
        throw new Error("bridge gone");
      },
    });
    const element = container.querySelector("#mirror-indicator") as HTMLElement;
    indicator.set(describe(report(), NOW));
    return indicator.refresh().then(() => {
      expect(element.dataset.state).toBe("current");
      indicator.destroy();
    });
  });

  test("destroy releases the subscription and empties the container", () => {
    let released = 0;
    const indicator = createMirrorIndicator({
      container,
      status: async () => report(),
      subscribe: async () => (): void => {
        released += 1;
      },
    });
    return Promise.resolve().then(() => {
      indicator.destroy();
      expect(container.childElementCount).toBe(0);
      expect(released).toBe(1);
    });
  });
});
