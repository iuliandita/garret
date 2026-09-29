// app/harness/test/pictures-gates.test.ts
// The five pictures gates, and the failing direction of each named in
// the plan's mutation targets. The numeric gate is exercised at a real
// threshold passed in explicitly, so the test is about the comparison and not
// about the placeholder constant reading FAIL by design.
import { describe, expect, test } from "bun:test";
import { evaluatePicturesGates, type PicturesMetrics } from "../src/gates";

/** A run where every act behaved exactly as designed. Every test below moves
 *  ONE field. */
const GREEN: PicturesMetrics = {
  attach_sha_matches: true,
  attach_thumb_width: 256,
  attach_thumb_height: 256,
  attach_stored_name: "0198c0de-0000-7000-8000-0000000005a1.png",
  attach_state_name: "Picture of Marisol Quillfeather",
  attach_state_expected_name: "Picture of Marisol Quillfeather",
  oversize_picture_path_before: "0198c0de-0000-7000-8000-0000000005a1.png",
  oversize_picture_path_after: "0198c0de-0000-7000-8000-0000000005a1.png",
  oversize_files_before: 2,
  oversize_files_after: 2,
  oversize_notice_text:
    "Could not change the picture, and nothing was changed: that picture says it is 50410000 " +
    "pixels and the largest this book will read is 50000000",
  oversize_expected_notice:
    "Could not change the picture, and nothing was changed: that picture says it is 50410000 " +
    "pixels and the largest this book will read is 50000000",
  attach_host_rss_mb: 90,
  attach_rss_steps_mb: [80, 85, 90, 88],
  cover_meta_value: "0198c0de-0000-7000-8000-0000000005a2.png",
  cover_file_matches: true,
  cover_sides_text:
    "600 x 900 pixels is about 100 dpi on this page. Print wants 300 dpi, which is 1800 x 2700 pixels.",
  cover_expected_sentence:
    "600 x 900 pixels is about 100 dpi on this page. Print wants 300 dpi, which is 1800 x 2700 pixels.",
};

function verdictOf(gate: string, patch: Partial<PicturesMetrics>, rss = 250, thumbMax = 256): string {
  const found = evaluatePicturesGates({ ...GREEN, ...patch }, rss, thumbMax).find((v) => v.gate === gate);
  if (found === undefined) throw new Error(`no gate named ${gate}`);
  return found.verdict;
}

test("a run where every act behaved as designed is green on every gate at a real threshold", () => {
  const verdicts = evaluatePicturesGates(GREEN, 250);
  expect(verdicts).toHaveLength(5);
  expect(verdicts.filter((v) => v.verdict !== "PASS")).toEqual([]);
});

test("every gate states a threshold and a value", () => {
  for (const v of evaluatePicturesGates(GREEN, 250)) {
    expect(v.threshold.length).toBeGreaterThan(10);
    expect(String(v.value).length).toBeGreaterThan(0);
  }
});

test("at the module's own constant (filled from the first green run) the RSS gate passes, and a zero limit is read as unfilled and FAILS", () => {
  const filled = evaluatePicturesGates(GREEN);
  expect(filled.find((v) => v.gate === "attach_host_rss_mb")!.verdict).toBe("PASS");
  const unfilled = evaluatePicturesGates(GREEN, 0);
  expect(unfilled.find((v) => v.gate === "attach_host_rss_mb")!.verdict).toBe("FAIL");
});

describe("picture_attached", () => {
  // Mutation target 1: passes on a sha mismatch.
  test("fails when the stored bytes do not match the source", () => {
    expect(verdictOf("picture_attached", { attach_sha_matches: false })).toBe("FAIL");
  });
  // Mutation target 2: passes on a 300-px thumbnail.
  test("fails when the thumbnail's width is over 256px", () => {
    expect(verdictOf("picture_attached", { attach_thumb_width: 300 })).toBe("FAIL");
  });
  test("fails when the thumbnail's height is over 256px", () => {
    expect(verdictOf("picture_attached", { attach_thumb_height: 300 })).toBe("FAIL");
  });
  test("passes at the 256px boundary and fails one pixel past it", () => {
    expect(verdictOf("picture_attached", { attach_thumb_width: 256, attach_thumb_height: 256 })).toBe("PASS");
    expect(verdictOf("picture_attached", { attach_thumb_width: 257 })).toBe("FAIL");
  });
  test("fails when no thumbnail was read at all", () => {
    expect(verdictOf("picture_attached", { attach_thumb_width: 0, attach_thumb_height: 0 })).toBe("FAIL");
  });
  test("fails when the stored name is empty", () => {
    expect(verdictOf("picture_attached", { attach_stored_name: "" })).toBe("FAIL");
  });
});

describe("picture_state_present", () => {
  test("fails when the panel never showed the picture as present", () => {
    expect(verdictOf("picture_state_present", { attach_state_name: "" })).toBe("FAIL");
  });
  test("fails when the accessible name names the wrong member", () => {
    expect(verdictOf("picture_state_present", { attach_state_name: "Picture of Someone Else" })).toBe("FAIL");
  });
});

describe("oversize_refused", () => {
  // Mutation target 3: passes when picture_path changed.
  test("fails when picture_path changed after the oversize attach", () => {
    expect(
      verdictOf("oversize_refused", {
        oversize_picture_path_after: "0198c0de-0000-7000-8000-0000000005ff.png",
      }),
    ).toBe("FAIL");
  });
  test("fails when the pictures directory gained a file", () => {
    expect(verdictOf("oversize_refused", { oversize_files_after: 3 })).toBe("FAIL");
  });
  test("fails when the banner does not carry the refusal sentence", () => {
    expect(verdictOf("oversize_refused", { oversize_notice_text: "nothing happened" })).toBe("FAIL");
  });
});

describe("attach_host_rss_mb", () => {
  // Mutation target 5: passes on a zero sample.
  test("fails when the peak reads zero against a real limit", () => {
    expect(verdictOf("attach_host_rss_mb", { attach_host_rss_mb: 0 }, 250)).toBe("FAIL");
  });
  test("passes at the limit and fails one MB past it", () => {
    expect(verdictOf("attach_host_rss_mb", { attach_host_rss_mb: 250 }, 250)).toBe("PASS");
    expect(verdictOf("attach_host_rss_mb", { attach_host_rss_mb: 251 }, 250)).toBe("FAIL");
  });
});

describe("cover_set", () => {
  // Mutation target 4: passes with the meta row absent.
  test("fails when the meta row is absent", () => {
    expect(verdictOf("cover_set", { cover_meta_value: null })).toBe("FAIL");
  });
  test("fails when the stored file's bytes do not match the source", () => {
    expect(verdictOf("cover_set", { cover_file_matches: false })).toBe("FAIL");
  });
  test("fails when the panel does not say the expected finding sentence", () => {
    expect(verdictOf("cover_set", { cover_sides_text: "No cover yet." })).toBe("FAIL");
  });
});
