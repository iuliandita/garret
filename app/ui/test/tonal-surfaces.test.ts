import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// ONE TONE FOR THE FRAME, ANOTHER FOR THE PROSE, AND NO LINE BETWEEN PANES.
// The look design (2026-09-02). The tokens already exist in every
// palette; what this file pins is which surface carries which, and that the
// hairlines every pane used to draw against its neighbour are gone.
const css = await Bun.file(join(import.meta.dir, "..", "style.css")).text();
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");

function block(selector: string): string {
  const at = stripped.indexOf(`\n\n${selector} {`);
  if (at < 0) throw new Error(`no block for ${selector}`);
  const open = stripped.indexOf("{", at);
  const close = stripped.indexOf("}", open);
  return stripped.slice(open + 1, close);
}

const BORDER = /(?:^|;)\s*border(?:-(?:top|right|bottom|left))?\s*:/;

describe("the frame is one tone", () => {
  const surfaces = ["#project-bar", "#footer", "#nav-header", "#nav", "#preview-rail"];
  for (const pane of surfaces) {
    test(`${pane} carries --nav-bg and draws no border`, () => {
      expect(block(pane)).toMatch(/background:\s*var\(--nav-bg\)/);
      expect(block(pane)).not.toMatch(BORDER);
    });
  }

  // #nav-column and #preview-controls are grid-item WRAPPERS, not surfaces -
  // #nav-column lays out #nav-header and #nav, #preview-controls is
  // `display: contents` so it paints nothing of its own. Neither is asked to
  // carry --nav-bg; both are asked to draw no seam of their own against the
  // panes flanking them.
  const wrappers = ["#nav-column", "#preview-controls"];
  for (const wrapper of wrappers) {
    test(`${wrapper} draws no border`, () => {
      expect(block(wrapper)).not.toMatch(BORDER);
    });
  }
});

describe("the prose surface is the page", () => {
  test("#editor carries --bg and the ProseMirror draws no border", () => {
    expect(block("#editor")).toMatch(/background:\s*var\(--bg\)/);
    expect(block("#editor .ProseMirror")).not.toMatch(BORDER);
  });
});

describe("the navigator's rows", () => {
  const row = block('#nav [role="treeitem"]');

  test("14px text on the unchanged 24px line", () => {
    expect(row).toMatch(/font-size:\s*14px/);
    expect(row).toMatch(/line-height:\s*24px/);
  });

  test("the count is smaller and readable", () => {
    const count = block("#nav .nav-count");
    expect(count).toMatch(/font-size:\s*12px/);
    expect(count).toMatch(/color:\s*var\(--muted\)/);
  });

  test("the selected row is a pill painted inside its own box", () => {
    // A pseudo-element with negative z-index paints behind #nav unless the
    // row is its own stacking context; isolation is what keeps the pill
    // above the part band and below the title.
    expect(row).toMatch(/isolation:\s*isolate/);
    const pill = block('#nav [role="treeitem"][aria-selected="true"]::before');
    expect(pill).toMatch(/border-radius/);
    expect(pill).toMatch(/inset:\s*0\s+6px/);
    expect(pill).toMatch(/z-index:\s*-1/);
    expect(pill).toMatch(/background:\s*var\(--accent-soft\)/);
    expect(block('#nav [role="treeitem"][aria-selected="true"]')).not.toMatch(/box-shadow/);
  });

  test("containers carry a chevron that turns with aria-expanded", () => {
    const reserved = block("#nav .nav-title::before");
    expect(reserved).toMatch(/content:\s*""/);
    expect(reserved).toMatch(/opacity:\s*0\s*;/);
    const shown = block('#nav [role="treeitem"][aria-expanded] .nav-title::before');
    expect(shown).toMatch(/opacity:\s*0?\.\d+/);
    const open = block('#nav [role="treeitem"][aria-expanded="true"] .nav-title::before');
    expect(open).toMatch(/rotate\(45deg\)/);
    expect(reserved).toMatch(/rotate\(-45deg\)/);
  });
});

describe("the scene heading", () => {
  test("shares the page's column and hides when empty", () => {
    const heading = block("#scene-heading");
    expect(heading).toMatch(/max-width:\s*var\(--prose-measure/);
    expect(heading).toMatch(/font-family:\s*var\(--prose-family/);
    expect(heading).toMatch(/unicode-bidi:\s*plaintext/);
    expect(block("#scene-heading:empty")).toMatch(/display:\s*none/);
  });

  test("the pane is a column and the page fills what the heading leaves", () => {
    expect(block("#editor")).toMatch(/flex-direction:\s*column/);
    const page = block("#editor .ProseMirror");
    expect(page).toMatch(/flex:\s*1 0 auto/);
    expect(page).toMatch(/width:\s*100%/);
    expect(page).not.toMatch(/min-height/);
  });
});
