// app/ui/test/empty-project.test.ts
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { mountEmpty } from "../src/empty-project";
import { t } from "../src/i18n";
import { createProjectSwitcher } from "../src/project-switch";
import type { MountedProject } from "../src/project";

/** Checked against the stylesheet SOURCE, not with getComputedStyle: happy-dom
 *  does no layout and loads no stylesheet, so `el.hidden === true` is true
 *  regardless of which rule the stylesheet actually applies, and proves
 *  nothing about whether the element is actually hidden. Same trap
 *  control-weight.test.ts and underline-and-anchor.test.ts are written
 *  against, and the same reason this file needs its own copy of their
 *  comment-stripped, exact-selector parse rather than a DOM assertion. */
const css = readFileSync(join(import.meta.dir, "..", "style.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

function exact(selector: string): string | null {
  const re = new RegExp(`(?:^|\\})\\s*${selector.replace(/[.[\]*+?^$(){}|\\]/g, "\\$&")}\\s*\\{([^{}]*)\\}`);
  const match = re.exec(css);
  return match === null ? null : (match[1] ?? "");
}

const SHELL_IDS = ["nav-header", "editor", "scene-name", "word-count", "goal-bar", "status-controls", "save-controls"] as const;

function shell(): void {
  for (const id of SHELL_IDS) {
    const el = document.createElement("div");
    el.id = id;
    if (id === "editor") {
      const heading = document.createElement("h1");
      heading.id = "scene-heading";
      el.appendChild(heading);
    }
    document.body.appendChild(el);
  }
}

function tearDownShell(): void {
  for (const id of SHELL_IDS) document.getElementById(id)?.remove();
  document.querySelectorAll(".app-banner").forEach((el) => el.remove());
}

/** A banner's message, without the dismiss button's glyph -- project.test.ts's
 *  own helper, copied rather than imported: that file's is not exported, and a
 *  second small function here costs less than threading an export through a
 *  module that owns a mounted project's own banner surface. */
const labelOf = (id: string): string | undefined =>
  document.getElementById(id)?.querySelector(".app-banner-text")?.textContent ?? undefined;

const bannerIds = (): string[] =>
  [...document.querySelectorAll<HTMLElement>(".app-banner")].map((el) => el.id);

afterEach(() => {
  tearDownShell();
});

describe("the empty workspace", () => {
  test("paints the nav-header sentence and the editor prompt", () => {
    shell();
    const mounted = mountEmpty({ openLibrary: () => undefined });
    expect(document.getElementById("nav-header")?.textContent).toBe(t("library.no-book"));
    expect(document.getElementById("nav-header")?.dataset.empty).toBe("");
    const workspace = document.getElementById("empty-workspace");
    expect(workspace).not.toBeNull();
    expect(workspace?.textContent).toContain(t("library.open-prompt"));
    const button = document.getElementById("empty-open-library");
    expect(button?.textContent).toBe(t("library.open"));
    mounted.destroy();
  });

  test("the open-library button calls the dependency", () => {
    shell();
    let opened = 0;
    const mounted = mountEmpty({ openLibrary: () => (opened += 1) });
    document.getElementById("empty-open-library")?.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    expect(opened).toBe(1);
    mounted.destroy();
  });

  test("hides the four footer elements and restores them on destroy", () => {
    shell();
    const mounted = mountEmpty({ openLibrary: () => undefined });
    for (const id of ["word-count", "goal-bar", "status-controls", "save-controls"]) {
      expect(document.getElementById(id)?.hidden).toBe(true);
    }
    mounted.destroy();
    for (const id of ["word-count", "goal-bar", "status-controls", "save-controls"]) {
      expect(document.getElementById(id)?.hidden).toBe(false);
    }
  });

  test("destroy empties #editor and clears the nav-header sentence", () => {
    shell();
    const mounted = mountEmpty({ openLibrary: () => undefined });
    mounted.destroy();
    expect(document.getElementById("empty-workspace")).toBeNull();
    expect(document.getElementById("nav-header")?.textContent).toBe("");
    expect(document.getElementById("nav-header")?.dataset.empty).toBeUndefined();
  });

  test("every menu action raises exactly one notice, and there are at least 30 of them", () => {
    shell();
    const mounted = mountEmpty({ openLibrary: () => undefined });
    const keys = Object.keys(mounted.menuActions) as (keyof typeof mounted.menuActions)[];
    // VACUITY GUARD: MenuProjectActions has grown past 30 arms and stayed
    // there since before this slice; an empty or truncated list here would
    // pass every assertion below while proving nothing.
    expect(keys.length).toBeGreaterThanOrEqual(30);

    const boolAnswering = new Set(["canNavBack", "canNavForward", "selectedTrashed"]);
    const labelAnswering = new Set(["outlineUndoLabel", "outlineRedoLabel"]);
    const viewAnswering = new Set(["outlineViewMode"]);
    for (const key of keys) {
      if (boolAnswering.has(key)) {
        const answer = (mounted.menuActions[key] as () => boolean)();
        expect(answer).toBe(false);
        continue;
      }
      if (labelAnswering.has(key)) {
        const label = (mounted.menuActions[key] as () => string | null)();
        expect(label).toBeNull();
        continue;
      }
      if (viewAnswering.has(key)) {
        expect((mounted.menuActions[key] as () => string)()).toBe("manuscript");
        continue;
      }
      document.querySelectorAll(".app-banner").forEach((el) => el.remove());
      const action = mounted.menuActions[key] as (...args: never[]) => void;
      // Called with no argument: every arm ignores what it is given (a
      // parameterless refusal), so this is enough to exercise all 30+.
      action();
      const ids = bannerIds();
      expect({ key, ids }).toEqual({ key, ids: ["open-error"] });
      expect(labelOf("open-error")).toBe(t("library.nothing-open"));
    }
    mounted.destroy();
  });

  test("persistError is always null", () => {
    shell();
    const mounted = mountEmpty({ openLibrary: () => undefined });
    expect(mounted.persistError()).toBeNull();
    mounted.destroy();
  });

  test("raiseFailure, raiseNotice and announce all raise into the page", () => {
    shell();
    const mounted = mountEmpty({ openLibrary: () => undefined });
    mounted.raiseNotice("a notice");
    expect(labelOf("open-error")).toBe("a notice");
    mounted.announce("good news");
    expect(labelOf("open-error")).toBe("good news");
    mounted.raiseFailure("a failure");
    expect(labelOf("persist-error")).toBe("a failure");
    mounted.destroy();
    expect(document.getElementById("open-error")).toBeNull();
    expect(document.getElementById("persist-error")).toBeNull();
  });

  test("#status-controls[hidden] actually hides -- its own display rule would otherwise win", () => {
    // #status-controls carries `display: inline-flex` in style.css, which
    // out-specifies the user-agent `[hidden]` rule on its own: a footer
    // hidden here with no restatement would stay visibly on screen at the
    // empty boot, exactly the collision page-ui.md records and the one this
    // stylesheet already pays for beside #goal-bar.
    expect(exact("#status-controls") ?? "").toMatch(/(?:^|;)\s*display\s*:\s*inline-flex/);
    expect(exact("#status-controls[hidden]") ?? "").toMatch(/display\s*:\s*none/);
  });
});

describe("a failed switch out of the empty workspace (review fixup)", () => {
  // project-switch.ts destroys the outgoing mount BEFORE opening the next
  // book; when the open or the mount then fails, `setCurrent` is never
  // called and `current` is left pointing at the just-destroyed empty mount.
  // main.ts's own `onFailure` is written the same way this test's is: check
  // whether the switch started from the empty boot (`currentPath === ""`,
  // unchanged since `onSwitched` never ran) and remount if so, rather than
  // leaving an unhidden footer over a bare #editor with no way back short of
  // the menu.
  test("remounts the empty workspace rather than leaving a bare shell", async () => {
    shell();
    let current: MountedProject = mountEmpty({ openLibrary: () => undefined });
    const currentPath = "";
    const switchProject = createProjectSwitcher<MountedProject>({
      current: () => current,
      setCurrent: (next) => {
        current = next;
      },
      currentPath: () => currentPath,
      openProject: async () => {
        throw new Error("the host refused to open it");
      },
      mount: async () => {
        throw new Error("unreachable: openProject always throws first");
      },
      onFailure: (message) => {
        if (currentPath === "") {
          current = mountEmpty({ openLibrary: () => undefined });
        }
        current.raiseNotice(message);
      },
    });

    const outcome = await switchProject("/library/book.db");

    expect(outcome).toBe("failed");
    // The empty workspace is back: its prompt, its button, and the notice
    // banner explaining what went wrong.
    expect(document.getElementById("empty-workspace")).not.toBeNull();
    expect(document.getElementById("empty-open-library")).not.toBeNull();
    expect(document.getElementById("nav-header")?.textContent).toBe(t("library.no-book"));
    expect(document.getElementById("open-error")).not.toBeNull();
    current.destroy();
  });
});
