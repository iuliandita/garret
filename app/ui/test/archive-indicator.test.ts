// app/ui/test/archive-indicator.test.ts
// The bar's second statement: is there a copy that could leave this computer.

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { beforeEach, describe as suite, expect, test } from "bun:test";
import {
  createArchiveIndicator,
  describe,
  type ArchiveReport,
} from "../src/archive-indicator";
import { EN } from "../src/i18n/en";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

const NOW = 1_787_174_042_000;
const HOUR = 3_600_000;

const report = (over: Partial<ArchiveReport> = {}): ArchiveReport => ({
  slug: "my-book",
  dir: "/home/w/.local/share/cc.local.app/recovery/my-book/archives",
  newest_verified_ms: null,
  archives: 0,
  ...over,
});

let container: HTMLElement;
beforeEach(() => {
  document.body.replaceChildren();
  container = document.createElement("span");
  document.body.append(container);
});

suite("what the report is saying", () => {
  test("no project and no archive are the same plain negative", () => {
    // A writer can act on neither, and the alternative -- a sentence about an
    // archive that exists but did not read back -- is a promise the
    // application cannot keep.
    expect(describe(report({ slug: null }), NOW).state).toBe("none");
    expect(describe(report(), NOW).state).toBe("none");
    expect(describe(report(), NOW).text).toBe(EN["archive.text.none"]);
    expect(describe(report(), NOW).label).toContain("Encrypted archive files are separate");
  });

  test("an archive that exists is dated, and never called safe", () => {
    // Three hours, not one: `formatWhen` reports minutes up to 90 of them, so
    // an hour-old fixture reads "60 minutes ago" and a test written against
    // "1 hour ago" would be asserting a property of the fixture.
    const view = describe(report({ newest_verified_ms: NOW - 3 * HOUR, archives: 1 }), NOW);
    expect(view.state).toBe("taken");
    expect(view.text).toContain("3 hours ago");
    expect(view.text).toContain("Ordinary local archive");
    // IT IS STILL ON THIS COMPUTER UNTIL THE WRITER MOVES IT. The accessible
    // name is the only channel with room to say so, and saying so is the
    // design's whole point: the application has no way to know the file left.
    expect(view.label).toContain("Move a complete folder off this computer yourself");
    expect(view.label).toContain("older .db archives omit pictures");
  });

  test("an archives directory with only unverified files reads as none", () => {
    // `archives` counts every file on disk; `newest_verified_ms` counts only
    // the ones the application could vouch for. A surface reading the former
    // would tell a writer they have protection they do not have.
    const view = describe(report({ newest_verified_ms: null, archives: 3 }), NOW);
    expect(view.state).toBe("none");
  });
});

suite("the span in the bar", () => {
  test("it is a group, never a status, and carries its state as data", async () => {
    // role="group", NOT role="status": an archive state that changed while the
    // writer was mid-sentence is exactly the announcement the design forbids.
    const indicator = createArchiveIndicator({
      container,
      status: async () => report(),
      now: () => NOW,
    });
    await indicator.refresh();

    const element = container.querySelector("#archive-indicator") as HTMLElement;
    expect(element).not.toBeNull();
    expect(element.getAttribute("role")).toBe("group");
    expect(element.getAttribute("role")).not.toBe("status");
    expect(element.dataset.state).toBe("none");
    indicator.destroy();
  });

  test("it opens on the negative", () => {
    // The first answer is one await away, and a bar that claimed an archive
    // before anyone had looked would be the lie this surface exists to
    // prevent.
    createArchiveIndicator({ container, status: async () => report(), now: () => NOW });
    const element = container.querySelector("#archive-indicator") as HTMLElement;
    expect(element.textContent).toBe(EN["archive.text.none"]);
  });

  test("every state change is reported to onState, the first one before the first await", async () => {
    const seen: string[] = [];
    const indicator = createArchiveIndicator({
      container,
      status: async () => report({ newest_verified_ms: NOW - HOUR, archives: 1 }),
      now: () => NOW,
      onState: (state) => seen.push(state),
    });
    expect(seen).toEqual(["none"]);
    await indicator.refresh();
    expect(seen).toEqual(["none", "taken"]);
    indicator.destroy();
  });

  test("a bridge that stops answering leaves the last thing said standing", async () => {
    const answers: Array<() => Promise<ArchiveReport>> = [
      async () => report({ newest_verified_ms: NOW - HOUR, archives: 1 }),
      async () => {
        throw new Error("no bridge");
      },
    ];
    const indicator = createArchiveIndicator({
      container,
      status: () => (answers.shift() ?? (async () => report()))(),
      now: () => NOW,
    });
    await indicator.refresh();
    const element = container.querySelector("#archive-indicator") as HTMLElement;
    const said = element.textContent;
    expect(element.dataset.state).toBe("taken");

    await indicator.refresh();

    expect(element.textContent).toBe(said);
    expect(element.dataset.state).toBe("taken");
    indicator.destroy();
  });

  test("destroy releases the host subscription", async () => {
    // A project switch that left one attached would stack one live closure per
    // switch -- the recorded shape of the menu bar's leaked document handler,
    // which no behavioural test could see. Counted, not observed.
    let released = 0;
    const indicator = createArchiveIndicator({
      container,
      status: async () => report(),
      subscribe: async () => (): void => {
        released += 1;
      },
      now: () => NOW,
    });
    await Promise.resolve();
    await Promise.resolve();

    indicator.destroy();
    indicator.destroy();

    expect(released).toBe(1);
    expect(container.childNodes.length).toBe(0);
  });

  test("destroy empties its own container and touches no other", () => {
    // Its OWN span in the strip, because both neighbours call
    // replaceChildren() on mount and destroy. A unit sharing a container with
    // one of them is wiped by the next project mount.
    const neighbour = document.createElement("span");
    neighbour.id = "save-controls";
    neighbour.textContent = "Saved";
    document.body.append(neighbour);

    const indicator = createArchiveIndicator({
      container,
      status: async () => report(),
      now: () => NOW,
    });
    indicator.destroy();

    expect(container.childNodes.length).toBe(0);
    expect(neighbour.textContent).toBe("Saved");
  });
});

suite("a failed archive is not a failed save", () => {
  test("the failure goes to the notice channel and says why", async () => {
    // A save failure means the manuscript is not durably written and must
    // interrupt. A backup failure means the manuscript is completely
    // unaffected. Painting them the same makes the one that must stop a writer
    // indistinguishable from the one that must not.
    const seen: string[] = [];
    const done: string[] = [];
    const indicator = createArchiveIndicator({
      container,
      status: async () => report(),
      archive: async () => {
        throw new Error("disk full");
      },
      onNotice: (m) => seen.push(m),
      onDone: (m) => done.push(m),
      now: () => NOW,
    });

    await indicator.archiveNow();

    expect(seen.length).toBe(1);
    expect(seen[0]).toContain("disk full");
    expect(done.length).toBe(0);
    // Nothing in this unit may announce. No live region, no alert.
    const element = container.querySelector("#archive-indicator") as HTMLElement;
    expect(element.getAttribute("role")).toBe("group");
    expect(element.getAttribute("aria-live")).toBeNull();
    indicator.destroy();
  });

  test("a written archive is reported by NAME, because the writer has to find it", async () => {
    const done: string[] = [];
    const indicator = createArchiveIndicator({
      container,
      status: async () => report({ newest_verified_ms: NOW, archives: 1 }),
      archive: async () => ({
        id: `my-book-2026-08-19T21-14-02Z`,
        file: "my-book-2026-08-19T21-14-02Z.db",
        manifest: "manifest.json",
        bytes: 4096,
        at_ms: NOW,
        verified: true,
        verified_at: NOW,
      }),
      onDone: (m) => done.push(m),
      now: () => NOW,
    });

    await indicator.archiveNow();

    expect(done.length).toBe(1);
    expect(done[0]).toContain("my-book-2026-08-19T21-14-02Z.db");
    // And the bar repainted: the archive that was just written is the one it
    // now describes.
    const element = container.querySelector("#archive-indicator") as HTMLElement;
    expect(element.dataset.state).toBe("taken");
    indicator.destroy();
  });
});
