// The three control weights, checked against the stylesheet SOURCE and against
// the units that write the attribute.
//
// Not with getComputedStyle: happy-dom does no layout and loads no stylesheet,
// so it reports initial values and an assertion on it passes for every
// implementation including none. Same side of that trap as nav-row-type.test.ts
// and theme.test.ts, both of which read this file as text.
//
// WHAT THIS GUARDS is the claim the slice rests on: a weight changes what a
// control looks like and NOTHING about how big it is. #project-bar is 39px, a
// click-geometry constant restated in outline-cli.ts and switch-cli.ts, which
// press at `BAR_HEIGHT + index * ROW_HEIGHT + ROW_HEIGHT / 2`. A weight rule
// that grew a button by one pixel would grow the bar, and both rigs would go on
// clicking the row they computed rather than the row a writer sees - silently,
// as a plausible-looking result. So "no geometry moved" is a parsed fact here,
// not an intention stated in a comment.
//
// #outline-bar was the second bar this file guarded, at 34px. It is retired: the
// three creates, Rename and Delete are all reachable from the Outline menu and
// from the navigator's context menu, so the strip was a third route to each.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

/** Comments stripped FIRST, for the reason theme.test.ts records: the prose in
 *  this stylesheet names properties and selectors constantly, and a guard that
 *  searched the raw text would find `padding` in the sentence explaining why
 *  there is no padding. That is the recorded trap where a guard parses a
 *  sentence instead of a rule. */
const css = readFileSync(join(import.meta.dir, "..", "style.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");
const html = readFileSync(join(import.meta.dir, "..", "index.html"), "utf8");
const TIERS = ["quiet", "primary", "danger"] as const;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });
}

function property(node: ts.Node): { owner: ts.Expression; name: string } | undefined {
  if (ts.isPropertyAccessExpression(node)) return { owner: node.expression, name: node.name.text };
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return { owner: node.expression, name: node.argumentExpression.text };
  }
  return undefined;
}

function weightWrites(source: string): string[] {
  const writes: string[] = [];
  const tree = ts.createSourceFile("weights.ts", source, ts.ScriptTarget.Latest, true);
  function record(value: ts.Node | undefined): void {
    if (value === undefined || !ts.isStringLiteralLike(value)) {
      throw new Error("control weights must use literal tiers");
    }
    writes.push(value.text);
  }
  function visit(node: ts.Node): void {
    if (ts.isBinaryExpression(node)) {
      const target = property(node.left);
      if (target?.name === "weight" && property(target.owner)?.name === "dataset") {
        if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
          throw new Error("control weights must use direct assignments");
        }
        record(node.right);
      }
    }
    if (ts.isCallExpression(node) && property(node.expression)?.name === "setAttribute") {
      const name = node.arguments[0];
      if (name && ts.isStringLiteralLike(name) && name.text === "data-weight") record(node.arguments[1]);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return writes;
}

function markupWeights(markup: string): string[] {
  const document = new DOMParser().parseFromString(markup, "text/html");
  return Array.from(document.querySelectorAll("[data-weight]"), (node) => node.getAttribute("data-weight")!);
}

interface Rule {
  selector: string;
  declarations: string;
}

/** Every rule whose selector text mentions `data-weight`, with its declaration
 *  block. Deliberately not keyed by an exact selector: the point is to catch a
 *  rule nobody thought to look for, including one added later. */
function weightRules(): Rule[] {
  const out: Rule[] = [];
  const re = /([^{}]*\[data-weight[^{}]*)\{([^{}]*)\}/g;
  for (const match of css.matchAll(re)) {
    out.push({
      selector: match[1]?.trim() ?? "",
      declarations: match[2] ?? "",
    });
  }
  return out;
}

/** The properties a weight is forbidden to touch, anchored to a property
 *  boundary.
 *
 *  A bare `declarations.includes("height:")` is worse than no check, because it
 *  MATCHES `line-height:` and would also fail against a rule that is correct.
 *  That is a recorded defect in this repo, from the other direction: a negated
 *  `toContain("height:")` could never be satisfied. So each name is matched
 *  where a declaration actually starts - at the opening brace, after a
 *  semicolon, or at a newline - and `min-`/`max-` prefixes are covered
 *  explicitly rather than by a loose substring. */
const FORBIDDEN = [
  { name: "border-width", re: /(?:^|;)\s*border(?:-(?:top|right|bottom|left))?-width\s*:/ },
  { name: "border shorthand", re: /(?:^|;)\s*border(?:-(?:top|right|bottom|left))?\s*:/ },
  { name: "padding", re: /(?:^|;)\s*padding(?:-(?:top|right|bottom|left))?\s*:/ },
  { name: "height", re: /(?:^|;)\s*(?:min-|max-)?height\s*:/ },
  { name: "line-height", re: /(?:^|;)\s*line-height\s*:/ },
  // Not in the slice's stated list, and it belongs there for the same reason:
  // 13px in an 18px line box is what makes the box 24px, and a weight that
  // changed the size would change the box without naming a length.
  { name: "font-size", re: /(?:^|;)\s*font-size\s*:/ },
] as const;

describe("a control weight changes no geometry", () => {
  const rules = weightRules();

  test("the stylesheet actually has weight rules to check", () => {
    // VACUITY GUARD. Every assertion below is a `for` over this list, so an
    // empty list passes the whole file while proving nothing - which is exactly
    // what would happen if the attribute were renamed, or if the comment
    // stripper above ate the rules along with the prose.
    //
    // Six: three rest tiers, a primary :hover, a primary :active, and the
    // danger state rule that covers both of its pseudo-classes at once.
    expect(rules.length).toBeGreaterThanOrEqual(6);
  });

  test("all three tiers are stated", () => {
    const text = rules.map((r) => r.selector).join(" ");
    for (const tier of TIERS) {
      expect(text).toContain(`[data-weight="${tier}"]`);
    }
  });

  for (const { name, re } of FORBIDDEN) {
    test(`no weight rule sets ${name}`, () => {
      for (const rule of rules) {
        expect({ selector: rule.selector, sets: re.test(rule.declarations) })
          .toEqual({ selector: rule.selector, sets: false });
      }
    });
  }

  test("quiet loses the border's COLOUR and keeps the border", () => {
    // `border: none` looks identical at rest and silently shortens the tallest
    // control in a bar whose height two rigs restate. The 1px has to stay.
    const quiet = rules.find((r) => r.selector.includes('[data-weight="quiet"]'));
    expect(quiet).toBeDefined();
    expect(quiet?.declarations).toContain("border-color: transparent");
  });

  test("a pressed primary is a DIFFERENT shade from a resting one", () => {
    // The whole reason --accent-strong exists. A primary is --accent at rest and
    // the shared :active rule paints --accent, so without this a pressed primary
    // gives no feedback at all.
    const active = rules.find(
      (r) => r.selector.includes('[data-weight="primary"]') && r.selector.includes(":active"),
    );
    expect(active).toBeDefined();
    expect(active?.declarations).toContain("var(--accent-strong)");
  });

  test("primary and danger answer :hover themselves", () => {
    // The shared :hover repaints the background to a tone and changes no
    // colour, which over the filled primary leaves --bg text on a pale tint.
    // Danger is TEXT on the default surface since 237 (calm-panels record),
    // never a filled slab, and its hover keeps that ink so an armed control
    // does not light up. The quiet tier deliberately carries no hover, because
    // being revealed by the shared hover is the point of it.
    const hover = (tier: string) => rules.find(
      (r) => r.selector.includes(`[data-weight="${tier}"]`) && r.selector.includes(":hover"),
    );
    expect(hover("primary")?.declarations).toContain("color: var(--bg)");
    expect(hover("danger")?.declarations).toContain("color: var(--danger)");
    expect(hover("danger")?.declarations).not.toContain("background: var(--danger)");
  });

  test("danger at rest is ink, not a fill", () => {
    const rest = rules.find((r) => r.selector === '#app button[data-weight="danger"]');
    expect(rest?.declarations).toContain("color: var(--danger)");
    expect(rest?.declarations).not.toContain("background: var(--danger)");
  });

  test("the retired outline bar has no rules left in the file", () => {
    // The bar is gone from index.html and from project.ts. A rule surviving here
    // would match nothing and read, to anyone skimming, as a surface that still
    // exists - and its selectors were half of every tier below.
    expect(css).not.toContain("#outline-bar");
  });

  test("the retired format group has no rules left", () => {
    // format-bar.ts and #format-group are gone since 069: Bold, Italic and
    // Underline are three of the bubble's five buttons now (#format-bubble),
    // which is a different selector entirely.
    expect(css).not.toContain("#format-group");
  });

  test("the rest tiers come BEFORE the shared :hover block", () => {
    // ORDER, not specificity: a rest tier and the shared hover are both (1,1,1),
    // so the later one wins where they disagree. Behind the hover block, a quiet
    // control would keep its transparent background under the pointer and stop
    // revealing itself - which is the whole of what makes a quiet control
    // discoverable.
    const hoverBlock = css.indexOf("#project-bar button:hover");
    expect(hoverBlock).toBeGreaterThan(-1);
    for (const tier of TIERS) {
      // The SPACE before the brace is load-bearing: it is what makes this the
      // REST rule rather than the pseudo-class rules below, whose selector
      // continues with ":". It was a comma until the outline bar was retired and
      // each tier went from two selectors to one.
      const at = css.indexOf(`#app button[data-weight="${tier}"] {`);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(hoverBlock);
    }
  });

  test("every literal weight writer uses a supported tier", () => {
    const writes = [
      ...sourceFiles(join(import.meta.dir, "..", "src"))
        .flatMap((file) => weightWrites(readFileSync(file, "utf8"))),
      ...markupWeights(html),
    ];
    expect(writes.length).toBeGreaterThan(0);
    for (const tier of writes) expect(TIERS).toContain(tier as typeof TIERS[number]);
  });

  test("the writer census reads executable dot and computed writes, not comments", () => {
    expect(weightWrites(`
      // ignored.dataset.weight = "unknown";
      button.dataset.weight = "quiet";
      button.dataset["weight"] = "primary";
      button["dataset"].weight = "danger";
      button.setAttribute ("data-weight", "primary");
      button["setAttribute"]("data-weight", "quiet");
    `)).toEqual(["quiet", "primary", "danger", "primary", "quiet"]);
    expect(weightWrites('button.dataset["weight"] = "unknown";')).toEqual(["unknown"]);
    expect(() => weightWrites('button.dataset.weight = choice;')).toThrow(/literal/);
    expect(() => weightWrites('button.setAttribute("data-weight", choice);')).toThrow(/literal/);
    expect(() => weightWrites('button.dataset.weight += "quiet";')).toThrow(/direct/);
  });

  test("static markup contributes its weights without reading comments", () => {
    expect(markupWeights('<!-- <button data-weight="ignored"> --><button data-weight="unknown">'))
      .toEqual(["unknown"]);
  });

  test("the shipped body root reaches each rest tier", () => {
    const body = new DOMParser().parseFromString(html, "text/html").body;
    expect(body.id).toBe("app");

    for (const tier of TIERS) {
      const root = document.createElement("body");
      root.id = body.id;
      const button = document.createElement("button");
      button.dataset.weight = tier;
      root.append(button);
      const rest = rules.filter((rule) =>
        rule.selector.includes(`[data-weight="${tier}"]`) && !rule.selector.includes(":"));
      expect(rest).toHaveLength(1);
      expect(button.matches(rest[0]!.selector)).toBe(true);
    }
  });
});

describe("a bar anchor costs the strip nothing", () => {
  // #project-bar is a flex row with `gap: 12px`, so even a bare EMPTY span is a
  // flex item and still takes 12px of the strip - for an element that renders
  // nothing. `display: contents` takes it out of the box tree entirely. The
  // recorded 034 defect is a bar control that got NARROWER and made the strip
  // wrap at switch-cli's 900px window, moving every navigator row; a stray 12px
  // is the same failure with a different cause, and no unit test of the page
  // can see either.
  //
  // NOT every anchor: the ones whose panels are located through AT-SPI keep
  // their box, and the stylesheet says why beside them. This names the ones
  // that must not.
  const CONTENTS = ["#find-controls", "#prefs-controls", "#quick-open-controls",
                    "#rename-controls", "#stats-controls", "#synopsis-controls",
                    "#cast-controls", "#appears-controls",
                    "#appears-map-controls", "#design-controls",
                    "#covers-controls", "#identity-controls",
                    "#preflight-controls", "#picture-viewer-controls"] as const;

  test("every anchor that can afford to costs zero", () => {
    const rules = [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
      .filter((m) => /(?:^|;)\s*display\s*:\s*contents/.test(m[2] ?? ""))
      .map((m) => (m[1] ?? "").trim());
    // Vacuity guard: an empty list would pass the loop below while proving
    // nothing, which is what a renamed property or a bad comment strip does.
    expect(rules.length).toBeGreaterThan(0);
    const selectors = rules.join(" ");
    for (const anchor of CONTENTS) {
      expect({ anchor, contents: selectors.includes(anchor) })
        .toEqual({ anchor, contents: true });
    }
  });
});

describe("the state rules that a weight would otherwise beat", () => {
  // A quiet rule is (1,1,1). Both of these mark a control that is ALSO quiet,
  // and at their original specificity they lost to it - the rule stays in the
  // file, keeps matching, and paints nothing. A live
  // hazard under #nav; it is a live hazard here for the same reason.
  test("an expanded Compare is qualified by its panel", () => {
    expect(css).toContain('#history-panel .history-compare[aria-expanded="true"]');
  });

  test("a pressed Show resolved is qualified by its panel", () => {
    expect(css).toContain('#comments-panel #comments-show-resolved[aria-pressed="true"]');
  });

  // EVERY PANEL THAT PAINTS A CHOSEN VALUE NEEDS ONE, and #design-panel shipped
  // its first capture without: the state was on the element and announced to a
  // screen reader, and no button looked chosen to anybody else. Found by
  // looking, which is the only thing that could have found it.
  //
  // `button[aria-pressed]` rather than a bare attribute selector for the reason
  // the stylesheet states beside the rule: both panels are INSIDE #project-bar
  // and a bare `#<panel> [aria-pressed="true"]` loses to `#project-bar
  // button:hover`.
  //
  // #covers-panel, #picture-viewer AND #timeline-card ARE DELIBERATELY NOT IN
  // THIS LIST, which is the one list of the six a new panel does NOT
  // automatically join. None of the three holds a control with a pressed
  // state -- every button on them acts and none of them selects -- so a rule
  // here would match nothing, and a selector that matches nothing is the
  // `import_name_ok` shape in a stylesheet: a later reader credits it for a
  // treatment it does not give. If any of them ever gains a toggle, this is
  // the list to join.
  //
  // #preview-rail IS in it, and it is the first surface here that is not a
  // descendant of #project-bar -- so the specificity note above describes a
  // fight this one is not in. It joins with the same selector shape anyway: a
  // reader comparing the six lists must not have to work out which of them each
  // id is in for a different reason.
  const PRESSED_PANELS = ["prefs-panel", "design-panel", "preview-rail", "timeline-scale-panel"] as const;

  test("every panel that paints a chosen value has a rule for it", () => {
    for (const panel of PRESSED_PANELS) {
      const rule = `#${panel} button[aria-pressed="true"]`;
      expect({ panel, styled: css.includes(rule) }).toEqual({ panel, styled: true });
    }
  });
});

describe("the units set the weight the design assigns", () => {
  async function source(file: string): Promise<string> {
    return await Bun.file(join(import.meta.dir, "..", "src", file)).text();
  }

  // The panels whose ring the stylesheet removes, and the file each is built
  // in. Suppressing a focus ring is only safe on a container a keyboard cannot
  // reach; on a reachable control it would take away a keyboard user's only
  // clue where they are.
  // The third member is the variable the element is built under. `panel`
  // everywhere but the EPUB rail, which is not a panel and does not call itself
  // one -- and asserting on the real name is what keeps this a check on the
  // element that actually carries the id.
  const SELF_FOCUSING: ReadonlyArray<readonly [string, string, string]> = [
    ["comments-panel", "comments-panel.ts", "panel"],
    ["help-panel", "help.ts", "panel"],
    ["stats-panel", "statistics-panel.ts", "panel"],
    ["state-panel", "revision-panel.ts", "panel"],
    ["mirror-changes", "mirror-changes.ts", "panel"],
    ["synopsis-panel", "synopsis-panel.ts", "panel"],
    ["cast-panel", "cast-panel.ts", "panel"],
    ["appears-panel", "appearances-panel.ts", "panel"],
    ["appears-map-panel", "appearances-map.ts", "panel"],
    ["prefs-panel", "preferences.ts", "panel"],
    ["design-panel", "design-panel.ts", "panel"],
    ["covers-panel", "covers-panel.ts", "panel"],
    ["identity-panel", "identity-panel.ts", "panel"],
    ["preflight-panel", "preflight-panel.ts", "panel"],
    ["picture-viewer", "picture-viewer.ts", "panel"],
    ["preview-rail", "preview-rail.ts", "rail"],
    ["timeline-card", "timeline-card.ts", "panel"],
    ["review-panel", "review-panel.ts", "panel"],
    ["craft-panel", "craft-panel.ts", "panel"],
  ];

  test("every panel whose ring is suppressed is not a tab stop", async () => {
    const suppressed = css.match(/#[a-z-]+:focus(?=[,\s{])/g) ?? [];
    expect(suppressed.length).toBe(SELF_FOCUSING.length);

    for (const [id, file, element] of SELF_FOCUSING) {
      expect(suppressed).toContain(`#${id}:focus`);
      const src = await source(file);
      expect(src).toContain(`${element}.id = "${id}"`);
      expect(src).toContain(`${element}.tabIndex = -1`);
    }
  });

  test("each panel's reason for existing is primary", async () => {
    for (const [file, id] of [
      ["comments-panel.ts", "comments-add"],
      ["history.ts", "snapshot-take"],
      ["switcher.ts", "project-create"],
      ["find-bar.ts", "find-run"],
      ["rename-panel.ts", "rename-commit"],
    ] as const) {
      const src = await source(file);
      const at = src.indexOf(`id = "${id}"`);
      expect(at).toBeGreaterThan(-1);
      expect(src.slice(at, at + 400)).toContain('dataset.weight = "primary"');
    }
  });

  test("the whole-book replace is danger ONLY while armed", async () => {
    // Both halves. A danger tint that never arrives says nothing; one that
    // outlives the confirmation it belonged to is a warning about nothing, on a
    // control a writer will press again for an ordinary in-scene replace.
    const src = await source("find-bar.ts");
    // At rest it is quiet, like the two replace buttons beside it: the default
    // tier's box made the one irreversible option the most prominent of the
    // three, which a reader takes as a recommendation.
    expect(src).toContain('replaceBook.dataset.weight = "quiet";\n  replaceBook.hidden');
    const arm = src.indexOf('replaceBook.setAttribute("data-armed", "true")');
    expect(arm).toBeGreaterThan(-1);
    expect(src.slice(arm, arm + 500)).toContain('replaceBook.dataset.weight = "danger"');

    const disarm = src.indexOf('replaceBook.removeAttribute("data-armed")');
    expect(disarm).toBeGreaterThan(-1);
    expect(src.slice(disarm, disarm + 500)).toContain('replaceBook.dataset.weight = "quiet"');
  });
});
