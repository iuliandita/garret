import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, describe, expect, test } from "bun:test";

// The suite's preload registers happy-dom for files under app/ui, but a file
// run on its own from the repo root gets none - and every assertion here is
// about the DOM.
if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { LOADING_ID, showProjectLoading } from "../src/loading";

const present = (): boolean => document.getElementById(LOADING_ID) !== null;

afterEach(() => {
  // Appended to <body>, outside anything a project owns, so it leaks into every
  // other file in the suite if a test leaves it up.
  document.getElementById(LOADING_ID)?.remove();
});

describe("the loading surface", () => {
  test("shows and hides", () => {
    expect(present()).toBe(false);
    showProjectLoading(true);
    expect(present()).toBe(true);
    showProjectLoading(false);
    expect(present()).toBe(false);
  });

  test("says what is happening, politely", () => {
    // role=status, not alert: news about what the application is doing, not an
    // emergency, and replaced by the project itself in a moment.
    showProjectLoading(true);
    const el = document.getElementById(LOADING_ID);
    expect(el?.getAttribute("role")).toBe("status");
    expect(el?.textContent ?? "").toMatch(/Opening the book/);
  });

  test("showing twice leaves ONE element", () => {
    // A second switch beginning before the first paints fires onBusy(true)
    // twice, and two elements sharing an id is invalid DOM - the shape the
    // banner's replace-never-stack rule exists for.
    showProjectLoading(true);
    showProjectLoading(true);
    expect(document.querySelectorAll(`#${LOADING_ID}`).length).toBe(1);
  });

  test("hiding when nothing is shown does not throw", () => {
    // A boot that never showed one still runs the `finally`.
    expect(() => showProjectLoading(false)).not.toThrow();
    expect(present()).toBe(false);
  });
});

describe("both callers use it", () => {
  // A SOURCE PARSE. `main.ts` ends in `void main()` at module scope, so
  // importing it boots the page and nothing in it can be tested - which is
  // exactly why this function was extracted: a mutation deleting the
  // first-mount call SURVIVED the whole suite while it lived there.
  test("main.ts shows it before the first mount and hides it in a finally", async () => {
    const src = await Bun.file("app/ui/src/main.ts").text();
    const shown = src.indexOf("showProjectLoading(true);");
    const mount = src.indexOf("await mountAt(window.__appGeneration");
    expect(shown).toBeGreaterThan(-1);
    expect(mount).toBeGreaterThan(shown);

    // In a `finally`, because a mount that throws is caught by main()'s handler
    // and must not leave a loading state under the failure it renders.
    const after = src.slice(mount, mount + 260);
    expect(after).toContain("finally");
    expect(after).toContain("showProjectLoading(false);");
  });

  test("the project switch hands it its busy signal", async () => {
    const src = await Bun.file("app/ui/src/main.ts").text();
    expect(src).toContain("onBusy: showProjectLoading");
  });

  test("the switch fires it AFTER the teardown and in a finally", async () => {
    // Before the teardown there is still a project on screen, and covering it
    // would hide work the writer can still see while the drain decides whether
    // the switch may happen at all. In a finally, so a rejection between the
    // teardown and the mount cannot leave the loading state up forever under a
    // failure message.
    const src = await Bun.file("app/ui/src/project-switch.ts").text();
    const destroy = src.indexOf("deps.current().destroy();");
    const busy = src.indexOf("deps.onBusy?.(true);");
    expect(destroy).toBeGreaterThan(-1);
    expect(busy).toBeGreaterThan(destroy);
    const tail = src.slice(src.indexOf("} finally {"));
    expect(tail).toContain("deps.onBusy?.(false);");
  });
});
