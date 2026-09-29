import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { describe, expect, test } from "bun:test";

if (typeof globalThis.document === "undefined") GlobalRegistrator.register();

import { gutterVerdict, parseDocumentBody, scaleFor, scopeStylesheet, shrinkFor } from "../src/preview";

describe("scopeStylesheet", () => {
  test("puts every selector under the scope", () => {
    expect(scopeStylesheet("p { margin: 0; }\n.u { text-decoration: underline; }", "#s")).toBe(
      "#s p { margin: 0; }\n#s .u { text-decoration: underline; }",
    );
  });

  test("scopes each selector of a list, not only the first", () => {
    // The recorded shape of a rule that looks scoped and is not: `h1, h2 {}`
    // prefixed once leaves `h2` matching the whole application.
    expect(scopeStylesheet("h1, h2 { text-align: center; }", "#s")).toBe(
      "#s h1, #s h2 { text-align: center; }",
    );
  });

  test("html and body become the scope itself rather than a descendant of it", () => {
    expect(scopeStylesheet("body { margin: 0 5%; }", "#s")).toBe("#s { margin: 0 5%; }");
    expect(scopeStylesheet("body p { text-indent: 0; }", "#s")).toBe("#s p { text-indent: 0; }");
  });

  test("keeps a pseudo-element attached to its own selector", () => {
    expect(scopeStylesheet(".opening::first-letter { float: left; }", "#s")).toBe(
      "#s .opening::first-letter { float: left; }",
    );
  });

  test("refuses an at-rule rather than mangling it", () => {
    // A blind prefix turns `@media print { p { … } }` into nonsense, and a
    // preview showing half a stylesheet is a preview of a book nobody gets.
    expect(scopeStylesheet("@media print { p { margin: 0; } }", "#s")).toBeNull();
    expect(scopeStylesheet("@import url(other.css);", "#s")).toBeNull();
  });

  test("refuses a stylesheet it has not understood rather than dropping the remainder", () => {
    expect(scopeStylesheet("p { margin: 0; } this is not a rule", "#s")).toBeNull();
    expect(scopeStylesheet("{ margin: 0; }", "#s")).toBeNull();
  });

  test("an empty stylesheet scopes to nothing at all", () => {
    expect(scopeStylesheet("", "#s")).toBe("");
  });
});

describe("parseDocumentBody", () => {
  const wrap = (body: string): string =>
    `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body>${body}</body></html>`;

  test("answers with the body of a well-formed document", () => {
    const body = parseDocumentBody(wrap("<p>hello</p>"));
    expect(body?.textContent).toBe("hello");
  });

  test("answers null for markup that is not well-formed XML", () => {
    // The whole reason the preview parses at all: an unclosed tag is a file no
    // reading system will open, and an HTML parser would repair it into a
    // preview that looked perfect.
    expect(
      parseDocumentBody(
        '<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><body><p>hi</body></html>',
      ),
    ).toBeNull();
  });

  test("answers null for a document with no body", () => {
    expect(parseDocumentBody('<?xml version="1.0"?>\n<other/>')).toBeNull();
  });
});

describe("scaleFor", () => {
  test("a leaf wider than the rail is shrunk to fit it exactly", () => {
    expect(scaleFor(380, 760)).toBe(0.5);
    expect(scaleFor(190, 760)).toBe(0.25);
  });

  test("a leaf narrower than the rail is NOT blown up", () => {
    // A proof leaf is a physical page. Enlarging it past its own size would
    // show a writer type larger than the book will set it, which is the one
    // thing this surface exists to be honest about.
    expect(scaleFor(760, 380)).toBe(1);
    expect(scaleFor(380, 380)).toBe(1);
  });

  test("a measurement taken before there is any layout is not a scale", () => {
    // happy-dom does no layout and a rail that has never been painted has no
    // width, so both readings are zero. A `0 / 0` there is NaN, which as a CSS
    // scale makes every leaf vanish -- with nothing on screen and no error
    // anywhere, which is exactly the failure a capture would be needed to find.
    expect(scaleFor(0, 0)).toBe(1);
    expect(scaleFor(380, 0)).toBe(1);
    expect(scaleFor(0, 760)).toBe(1);
    expect(scaleFor(Number.NaN, 760)).toBe(1);
    expect(scaleFor(-10, 760)).toBe(1);
  });
});

describe("gutterVerdict", () => {
  test("a book outside the range a printer publishes gets no verdict", () => {
    // Silence is the only honest answer where there is no published minimum:
    // inventing one would be this application making up a printer's rule.
    expect(gutterVerdict(null, 19050)).toBe("unknown");
  });

  test("it speaks when the margin clears and when it does not", () => {
    // BOTH, never only the unhappy one. 042's rule: a surface that speaks only
    // when it disapproves leaves a writer unable to tell "checked and fine"
    // from "not checked", and the moment they need to tell those apart is the
    // moment before they send the book to a printer.
    expect(gutterVerdict(15875, 19050)).toBe("clears");
    expect(gutterVerdict(15875, 12700)).toBe("below");
  });

  test("exactly the minimum clears it", () => {
    // The boundary, on both sides, because a threshold test far from its
    // boundary tests the arithmetic and not the comparison.
    expect(gutterVerdict(15875, 15875)).toBe("clears");
    expect(gutterVerdict(15875, 15874)).toBe("below");
  });
});

describe("shrinkFor", () => {
  test("a shrunken leaf gives back the height it no longer uses", () => {
    // A TRANSFORM DOES NOT CHANGE LAYOUT: a leaf painted at two fifths of its
    // size still reserves every millimetre it had, so without this the rail
    // scrolls a page-sized column of blank paper after every page.
    expect(shrinkFor(1000, 0.4)).toBe(600);
    expect(shrinkFor(1000, 1)).toBe(0);
  });

  test("nothing to shrink and nothing measured both give back nothing", () => {
    // A negative margin from a bad reading would pull the next leaf up over the
    // one before it, which is a defect only a capture would find.
    expect(shrinkFor(0, 0.5)).toBe(0);
    expect(shrinkFor(1000, 0)).toBe(0);
    expect(shrinkFor(Number.NaN, 0.5)).toBe(0);
    expect(shrinkFor(1000, 1.5)).toBe(0);
  });
});
