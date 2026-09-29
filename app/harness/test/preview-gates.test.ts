// app/harness/test/preview-gates.test.ts
// The seven preview gates (109), and the failing direction of each named in
// the plan's mutation targets. The numeric gates are exercised at a real
// threshold passed in explicitly, so the tests are about the comparison and
// not about the shipped zeros reading FAIL by design.
import { describe, expect, test } from "bun:test";
import { evaluatePreviewGates, PREVIEW_THRESHOLDS, type PreviewMetrics } from "../src/gates";

const FILLED = {
  epub_save_ms: { tiny: 5000 },
  proof_save_ms: { tiny: 60000 },
  rss_mb: { tiny: 900 },
};

/** A run where every act behaved exactly as designed. Every test below moves
 *  ONE field. */
const GREEN: PreviewMetrics = {
  fixture: "tiny",
  epub_rail_name: "EPUB preview",
  epub_rail_expected_name: "EPUB preview",
  epub_summary_text: "24 sections, 8192 words.",
  epub_summary_items: 24,
  epub_summary_words: 8192,
  store_items: 24,
  store_words: 8192,
  toggle_pressed: true,
  // THE STORE'S OWN SPELLING, hyphenated, as `design::CAPS_TITLE` writes it
  // beside `new-page`. The page spells the same option `caps_title` in its DOM
  // id, and a fixture written in the DOM's spelling would pass every test here
  // while every real run went red -- the one thing these tests exist to tell
  // apart.
  toggle_meta_tokens: ["caps-title", "new-page"],
  toggle_expected_token: "caps-title",
  epub_save_ms: 4000,
  epub_bytes: 45000,
  epubcheck_exit: 0,
  epubcheck_fatals: 0,
  epubcheck_errors: 0,
  epubcheck_warnings: 0,
  proof_attempted: true,
  proof_rail_name: "PDF proof",
  proof_rail_expected_name: "PDF proof",
  proof_summary_items: 24,
  proof_summary_words: 8192,
  proof_leaves: 40,
  pdfinfo_pages: 40,
  proof_refusal_exit: 0,
  proof_refusal_message: "",
  proof_refusal_ms: 0,
  proof_refusal_timed_out: false,
  proof_refusal_left_a_file: false,
  proof_save_ms: 30000,
  proof_bytes: 900000,
  proof_rail_walks: 12,
  proof_rail_wall_ms: 6000,
  preview_rss_mb: 500,
};

function verdictOf(
  gate: string,
  patch: Partial<PreviewMetrics>,
  thresholds: typeof PREVIEW_THRESHOLDS = FILLED,
): string {
  const found = evaluatePreviewGates({ ...GREEN, ...patch }, thresholds).find((v) => v.gate === gate);
  if (found === undefined) throw new Error(`no gate named ${gate}`);
  return found.verdict;
}

test("a run where every act behaved as designed is green on every gate at a real threshold", () => {
  const verdicts = evaluatePreviewGates(GREEN, FILLED);
  expect(verdicts).toHaveLength(7);
  expect(verdicts.filter((v) => v.verdict !== "PASS")).toEqual([]);
});

test("every gate states a threshold and a value", () => {
  for (const v of evaluatePreviewGates(GREEN, FILLED)) {
    expect(v.threshold.length).toBeGreaterThan(10);
    expect(String(v.value).length).toBeGreaterThan(0);
  }
});

test("the shipped PREVIEW_THRESHOLDS are FILLED, from real runs, at both fixtures", () => {
  // They were 0 while the rig was being written, which FAILS by design. This
  // pins that they have since been set: a line that silently went back to 0
  // would turn its gate red on every run and read as a regression in the
  // application rather than as an unfilled threshold.
  for (const fixture of ["tiny", "stress"]) {
    expect(PREVIEW_THRESHOLDS.epub_save_ms[fixture]).toBeGreaterThan(0);
    expect(PREVIEW_THRESHOLDS.rss_mb[fixture]).toBeGreaterThan(0);
  }
  expect(PREVIEW_THRESHOLDS.proof_save_ms.tiny).toBeGreaterThan(0);
  // And the one deliberate absence, which is a statement rather than an
  // oversight: a `stress` book has no proof to time.
  expect(PREVIEW_THRESHOLDS.proof_save_ms.stress).toBeUndefined();
});

test("the shipped lines pass a green tiny run and fail a run over them", () => {
  const tiny: PreviewMetrics = { ...GREEN, epub_save_ms: 619, proof_save_ms: 920, preview_rss_mb: 618 };
  for (const v of evaluatePreviewGates(tiny)) expect(v.verdict).toBe("PASS");
  expect(
    verdictOf("preview_rss_mb", { preview_rss_mb: 751 }, PREVIEW_THRESHOLDS),
  ).toBe("FAIL");
  expect(
    verdictOf("epub_save_ms", { epub_save_ms: 3001 }, PREVIEW_THRESHOLDS),
  ).toBe("FAIL");
});

test("an unfilled line still FAILS, whatever was measured", () => {
  // The property the shipped zeros used to demonstrate, kept as its own test
  // now that they are filled.
  expect(
    verdictOf("epub_save_ms", {}, { epub_save_ms: { tiny: 0 }, proof_save_ms: {}, rss_mb: {} }),
  ).toBe("FAIL");
});

describe("epub_summary_agrees_with_store", () => {
  test("fails on the wrong rail name", () => {
    expect(verdictOf("epub_summary_agrees_with_store", { epub_rail_name: "Something else" })).toBe("FAIL");
  });
  test("fails when the summary's items are off by one from the store", () => {
    expect(verdictOf("epub_summary_agrees_with_store", { epub_summary_items: 25 })).toBe("FAIL");
  });
  test("fails when the summary's words are off by one from the store", () => {
    expect(verdictOf("epub_summary_agrees_with_store", { epub_summary_words: 8193 })).toBe("FAIL");
  });
  test("fails the vacuity guard when both the store and the summary read zero items", () => {
    expect(
      verdictOf("epub_summary_agrees_with_store", { store_items: 0, epub_summary_items: 0 }),
    ).toBe("FAIL");
  });
  test("fails the vacuity guard when both the store and the summary read zero words", () => {
    expect(
      verdictOf("epub_summary_agrees_with_store", { store_words: 0, epub_summary_words: 0 }),
    ).toBe("FAIL");
  });
  test("fails when the summary line did not parse (-1)", () => {
    expect(verdictOf("epub_summary_agrees_with_store", { epub_summary_items: -1 })).toBe("FAIL");
  });
});

describe("option_toggle_lands", () => {
  test("fails when the toggle's pressed state never landed", () => {
    expect(verdictOf("option_toggle_lands", { toggle_pressed: false })).toBe("FAIL");
  });
  test("fails when the expected token is absent from the store's meta tokens", () => {
    expect(verdictOf("option_toggle_lands", { toggle_meta_tokens: ["small_caps"] })).toBe("FAIL");
  });
});

describe("epub_file_valid", () => {
  test("fails when epubcheck's own exit code is non-zero", () => {
    expect(verdictOf("epub_file_valid", { epubcheck_exit: 1 })).toBe("FAIL");
  });
  test("fails when epubcheck reports an error even with exit 0", () => {
    expect(verdictOf("epub_file_valid", { epubcheck_errors: 1 })).toBe("FAIL");
  });
  test("fails when epubcheck reports a fatal", () => {
    expect(verdictOf("epub_file_valid", { epubcheck_fatals: 1 })).toBe("FAIL");
  });
  test("fails when no bytes were saved at all", () => {
    expect(verdictOf("epub_file_valid", { epub_bytes: 0 })).toBe("FAIL");
  });
  test("passes with warnings present, and the value string mentions them", () => {
    const verdicts = evaluatePreviewGates({ ...GREEN, epubcheck_warnings: 12 }, FILLED);
    const gate = verdicts.find((v) => v.gate === "epub_file_valid")!;
    expect(gate.verdict).toBe("PASS");
    expect(String(gate.value)).toContain("12 warning");
  });
});

describe("proof_rail_agrees_with_the_file_it_saved", () => {
  test("fails when the rail's leaves are one off from pdfinfo's pages", () => {
    expect(verdictOf("proof_rail_agrees_with_the_file_it_saved", { proof_leaves: 41 })).toBe("FAIL");
  });
  test("fails the vacuity guard when both read zero", () => {
    expect(
      verdictOf("proof_rail_agrees_with_the_file_it_saved", { proof_leaves: 0, pdfinfo_pages: 0 }),
    ).toBe("FAIL");
  });
  test("fails when pdfinfo alone reads zero", () => {
    expect(verdictOf("proof_rail_agrees_with_the_file_it_saved", { pdfinfo_pages: 0 })).toBe("FAIL");
  });
});

describe("epub_save_ms", () => {
  test("passes exactly at the line and fails one over it", () => {
    expect(verdictOf("epub_save_ms", { epub_save_ms: 5000 })).toBe("PASS");
    expect(verdictOf("epub_save_ms", { epub_save_ms: 5001 })).toBe("FAIL");
  });
  test("fails on a zero measurement even under a real limit", () => {
    expect(verdictOf("epub_save_ms", { epub_save_ms: 0 })).toBe("FAIL");
  });
  test("fails on a zero (unfilled) threshold line even with a good measurement", () => {
    expect(
      verdictOf("epub_save_ms", { epub_save_ms: 4000 }, { epub_save_ms: { tiny: 0 }, proof_save_ms: {}, rss_mb: {} }),
    ).toBe("FAIL");
  });
  test("reports UNKNOWN for a fixture with no threshold line at all", () => {
    expect(verdictOf("epub_save_ms", { fixture: "stress" }, FILLED)).toBe("UNKNOWN");
  });
});

describe("proof_save_ms", () => {
  test("passes exactly at the line and fails one over it", () => {
    expect(verdictOf("proof_save_ms", { proof_save_ms: 60000 })).toBe("PASS");
    expect(verdictOf("proof_save_ms", { proof_save_ms: 60001 })).toBe("FAIL");
  });
  test("fails on a zero measurement even under a real limit", () => {
    expect(verdictOf("proof_save_ms", { proof_save_ms: 0 })).toBe("FAIL");
  });
  test("fails on a zero (unfilled) threshold line even with a good measurement", () => {
    expect(
      verdictOf(
        "proof_save_ms",
        { proof_save_ms: 30000 },
        { epub_save_ms: {}, proof_save_ms: { tiny: 0 }, rss_mb: {} },
      ),
    ).toBe("FAIL");
  });
  test("reports UNKNOWN for a fixture with no threshold line at all", () => {
    expect(verdictOf("proof_save_ms", { fixture: "stress" }, FILLED)).toBe("UNKNOWN");
  });
});

describe("preview_rss_mb", () => {
  test("passes exactly at the line and fails one over it", () => {
    expect(verdictOf("preview_rss_mb", { preview_rss_mb: 900 })).toBe("PASS");
    expect(verdictOf("preview_rss_mb", { preview_rss_mb: 901 })).toBe("FAIL");
  });
  test("fails on a zero measurement even under a real limit", () => {
    expect(verdictOf("preview_rss_mb", { preview_rss_mb: 0 })).toBe("FAIL");
  });
  test("fails on a zero (unfilled) threshold line even with a good measurement", () => {
    expect(
      verdictOf(
        "preview_rss_mb",
        { preview_rss_mb: 500 },
        { epub_save_ms: {}, proof_save_ms: {}, rss_mb: { tiny: 0 } },
      ),
    ).toBe("FAIL");
  });
  test("reports UNKNOWN for a fixture with no threshold line at all", () => {
    expect(verdictOf("preview_rss_mb", { fixture: "stress" }, FILLED)).toBe("UNKNOWN");
  });
});

describe("an attempted proof that produced nothing", () => {
  // The escape hatch is by FIXTURE, never by outcome: where the rig DID open
  // the proof rail, a proof that never arrived is a red gate. The rig backs
  // this up by recording its acts rather than aborting on them, so the red
  // gate reaches the evidence.
  test("is a FAIL, and never the refusal gate", () => {
    const verdicts = evaluatePreviewGates(
      { ...GREEN, proof_attempted: true, proof_leaves: 0, pdfinfo_pages: 0, proof_save_ms: 0 },
      FILLED,
    );
    expect(verdicts.find((v) => v.gate === "proof_rail_agrees_with_the_file_it_saved")?.verdict).toBe("FAIL");
    expect(verdicts.map((v) => v.gate)).not.toContain("proof_refused_at_the_render_bound");
    expect(verdicts.find((v) => v.gate === "proof_save_ms")?.verdict).toBe("FAIL");
  });
});

describe("the store's spelling of the option is not the page's", () => {
  // `design::CAPS_TITLE` is "caps-title"; `STYLE_FLAGS` spells the same option
  // "caps_title" and the DOM id carries that. The gate must not accept the
  // wrong one, because a rig that restated the DOM's spelling for the store's
  // would report a correct application as broken and this is where that gets
  // caught.
  test("the DOM spelling does not satisfy a store that wrote the hyphenated token", () => {
    expect(
      verdictOf("option_toggle_lands", {
        toggle_meta_tokens: ["caps-title"],
        toggle_expected_token: "caps_title",
      }),
    ).toBe("FAIL");
  });
  test("a token that merely CONTAINS the expected one is not the expected one", () => {
    expect(
      verdictOf("option_toggle_lands", { toggle_meta_tokens: ["caps-title-x"] }),
    ).toBe("FAIL");
  });
});

describe("proof_rail_agrees_with_the_file_it_saved, the rail's own label and figures", () => {
  test("fails when the proof rail is still labelled the archive's preview", () => {
    expect(
      verdictOf("proof_rail_agrees_with_the_file_it_saved", { proof_rail_name: "EPUB preview" }),
    ).toBe("FAIL");
  });
  test("fails when the proof's own sentence disagrees with the store", () => {
    expect(
      verdictOf("proof_rail_agrees_with_the_file_it_saved", { proof_summary_words: 8193 }),
    ).toBe("FAIL");
    expect(
      verdictOf("proof_rail_agrees_with_the_file_it_saved", { proof_summary_items: 25 }),
    ).toBe("FAIL");
  });
  test("fails when the proof's sentence did not parse at all", () => {
    expect(
      verdictOf("proof_rail_agrees_with_the_file_it_saved", {
        proof_summary_items: -1,
        proof_summary_words: -1,
      }),
    ).toBe("FAIL");
  });
});

describe("proof_refused_at_the_render_bound", () => {
  const REFUSED: Partial<PreviewMetrics> = {
    fixture: "stress",
    proof_attempted: false,
    proof_leaves: 0,
    pdfinfo_pages: 0,
    proof_save_ms: 0,
    proof_refusal_exit: 2,
    proof_refusal_message: "the proof did not finish within 180 seconds",
    proof_refusal_ms: 180_000,
    proof_refusal_timed_out: false,
    proof_refusal_left_a_file: false,
  };
  const THRESHOLDS = { epub_save_ms: { stress: 5000 }, proof_save_ms: {}, rss_mb: { stress: 900 } };
  const verdictAt = (patch: Partial<PreviewMetrics>): string => {
    const found = evaluatePreviewGates({ ...GREEN, ...REFUSED, ...patch }, THRESHOLDS).find(
      (v) => v.gate === "proof_refused_at_the_render_bound",
    );
    if (found === undefined) throw new Error("the refusal gate was not emitted");
    return found.verdict;
  };

  test("passes when the application refuses in its own words", () => {
    expect(verdictAt({})).toBe("PASS");
  });
  test("requires CLI exit 2, rather than merely a non-zero exit", () => {
    // Exit 2 identifies the renderer's timeout path. Each other status below
    // is an independent failure mode, even when the message still looks right.
    for (const proof_refusal_exit of [0, 1, -1]) {
      expect(verdictAt({ proof_refusal_exit })).toBe("FAIL");
    }
  });
  test("requires the host's complete timeout text", () => {
    expect(
      verdictAt({ proof_refusal_message: "the proof did not finish within 180 seconds, but kept rendering" }),
    ).toBe("FAIL");
  });
  test("fails when nothing was measured", () => {
    expect(verdictAt({ proof_refusal_ms: 0 })).toBe("FAIL");
  });
  test("allows the host's lower elapsed boundary and refuses one millisecond below it", () => {
    expect(verdictAt({ proof_refusal_ms: 180_000 })).toBe("PASS");
    expect(verdictAt({ proof_refusal_ms: 179_999 })).toBe("FAIL");
  });
  test("fails when a proof it could not finish left a file behind", () => {
    expect(verdictAt({ proof_refusal_left_a_file: true })).toBe("FAIL");
  });
  test("allows the bounded-cleanup ceiling and refuses one millisecond above it", () => {
    expect(verdictAt({ proof_refusal_ms: 210_000 })).toBe("PASS");
    expect(verdictAt({ proof_refusal_ms: 210_001 })).toBe("FAIL");
  });
  test("fails when the rig's 300-second safety net had to kill the CLI", () => {
    expect(verdictAt({ proof_refusal_timed_out: true })).toBe("FAIL");
  });
  test("a fixture with no proof emits six gates, none of them UNKNOWN", () => {
    const verdicts = evaluatePreviewGates({ ...GREEN, ...REFUSED }, THRESHOLDS);
    expect(verdicts).toHaveLength(6);
    expect(verdicts.map((v) => v.gate)).not.toContain("proof_save_ms");
    expect(verdicts.filter((v) => v.verdict === "UNKNOWN")).toEqual([]);
  });
  test("the EPUB half is graded exactly as it is anywhere else", () => {
    const verdicts = evaluatePreviewGates({ ...GREEN, ...REFUSED }, THRESHOLDS);
    for (const gate of ["epub_summary_agrees_with_store", "option_toggle_lands", "epub_file_valid", "epub_save_ms"]) {
      expect(verdicts.find((v) => v.gate === gate)?.verdict).toBe("PASS");
    }
  });
});
