import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// THE TWO STRIPS ARE CLICK-GEOMETRY CONSTANTS, and from 067 they are WRITTEN
// DOWN rather than summed from a line box. switch-cli, outline-cli and
// bible-cli restate 39 + 39 for the navigator's first row; the same three
// subtract the footer from the window before deciding the rows fit.
const css = await Bun.file(join(import.meta.dir, "..", "style.css")).text();
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");

// A block that starts its own selector list: `html,\nbody {` shares a line box
// with html and is not the grid, and a bare `\nbody {` would find it first.
function block(selector: string): string | null {
  const at = stripped.indexOf(`\n\n${selector} {`);
  if (at < 0) return null;
  const open = stripped.indexOf("{", at);
  const close = stripped.indexOf("}", open);
  return stripped.slice(open + 1, close);
}

describe("the strips are exact", () => {
  test("#project-bar declares 39px, #nav-header 39px, #footer 34px", () => {
    expect(block("#project-bar")).toMatch(/(?:^|;)\s*height\s*:\s*39px/);
    expect(block("#nav-header")).toMatch(/(?:^|;)\s*height\s*:\s*39px/);
    expect(block("#footer")).toMatch(/(?:^|;)\s*height\s*:\s*34px/);
  });

  test("the page is three rows and the middle one cannot grow", () => {
    expect(block("body")).toMatch(/grid-template-rows\s*:\s*auto\s+minmax\(0,\s*1fr\)\s+auto/);
  });

  test("every palette carries --amber and it is never --danger", () => {
    // Per BLOCK, not by global index: a palette that declared --danger and
    // forgot --amber would, paired by index, borrow the next palette's amber
    // and pass. A palette block holds declarations only, so it is an innermost
    // `{...}` with no brace inside it.
    const palettes = [...stripped.matchAll(/\{([^{}]*)\}/g)]
      .map((m) => m[1] ?? "")
      .filter((body) => /--danger\s*:/.test(body));
    expect(palettes.length).toBeGreaterThan(0);
    for (const body of palettes) {
      const danger = /--danger\s*:\s*([^;]+);/.exec(body)?.[1]?.trim();
      const amber = /--amber\s*:\s*([^;]+);/.exec(body)?.[1]?.trim();
      expect(amber).toBeDefined();
      expect(amber).not.toBe(danger);
    }
  });

  // 103 carry-in from 102's review: --track-3 equalled --danger in the light
  // theme, colliding with the event card's armed-Delete red.
  test("--track-3 is never --danger, in any block", () => {
    const palettes = [...stripped.matchAll(/\{([^{}]*)\}/g)]
      .map((m) => m[1] ?? "")
      .filter((body) => /--track-3\s*:/.test(body));
    expect(palettes.length).toBeGreaterThan(0);
    for (const body of palettes) {
      const dangerMatch = /--danger\s*:\s*([^;]+);/.exec(body);
      const trackMatch = /--track-3\s*:\s*([^;]+);/.exec(body);
      const danger = dangerMatch?.[1]?.trim();
      const track3 = trackMatch?.[1]?.trim();
      expect(track3).toBeDefined();
      expect(track3).not.toBe(danger);
      expect(track3).not.toBe("var(--danger)");
    }
  });

  // Coordinator follow-up, item 8: a real capture showed a horizontal
  // scrollbar under #editor with a branch group on screen. The branch
  // header's own span was the source (flex-shrink: 0 with no min-width
  // override never let it shrink below its full sentence). A genuine
  // layout assertion needs a real renderer happy-dom does not have (this
  // file's own header note); this pins the CSS rule instead, so removing
  // the fix fails the test rather than only a future capture.
  test("the branch header's sentence can shrink and truncate, not force the row wide", () => {
    const at = stripped.indexOf(".timeline-branch-header span {");
    expect(at).toBeGreaterThan(-1);
    const open = stripped.indexOf("{", at);
    const close = stripped.indexOf("}", open);
    const body = stripped.slice(open + 1, close);
    expect(body).toContain("min-width: 0");
    expect(body).not.toContain("flex-shrink: 0");
    expect(body).not.toMatch(/flex\s*:\s*1\s+0\s+auto/);
  });
});
