import { describe, expect, test } from "bun:test";
import { evaluateBibleGates, type BibleMetrics } from "../src/gates";

/** A run where everything worked. Every test below moves ONE field, so a gate
 *  that fails here fails for the reason the test names and not because the
 *  fixture was broken in three ways at once. */
const ok: BibleMetrics = {
  note_root_type: "bible",
  note_body_holds_nonce: true,
  export_holds_note_nonce: false,
  export_holds_manuscript_prose: true,
  synopsis_rows: 1,
  synopsis_on_the_open_scene: true,
  synopsis_body: "She has not opened the letter.",
  synopsis_typed: "She has not opened the letter.",
  synopsis_after_blind_resave: "She has not opened the letter.",
  cast_names: ["Ilse Vandermeer"],
  cast_typed_name: "Ilse Vandermeer",
  cast_kind: "character",
  cast_expected_kind: "character",
  appearance_on_scene: ["Ilse Vandermeer"],
  appearance_rows_total: 1,
  cast_aliases: ["Ils"],
  cast_alias_typed: "Ils",
  cast_alias_card_text: "Ilse Vandermeer\nkeeps the letter",
  picture_full_button_found: true,
  picture_viewer_open: true,
  thumbnail_long_side: 256,
  original_long_side: 3000,
  peak_rss_mb: 600,
};

function verdict(m: BibleMetrics, gate: string): string {
  const found = evaluateBibleGates(m).find((v) => v.gate === gate);
  if (found === undefined) throw new Error(`no gate ${gate}`);
  return found.verdict;
}

describe("evaluateBibleGates", () => {
  test("a clean run passes every gate", () => {
    const verdicts = evaluateBibleGates(ok);
    expect(verdicts.map((v) => v.gate)).toEqual([
      "bible_note_created",
      "bible_excluded_from_manuscript",
      "synopsis_saved",
      "synopsis_prefills_on_reopen",
      "cast_member_created",
      "appearance_tagged",
      "cast_alias_saved",
      "cast_alias_marks",
      "picture_thumbnail_bounded",
      "picture_viewer_opens",
      "peak_rss_mb",
    ]);
    expect(verdicts.every((v) => v.verdict === "PASS")).toBe(true);
  });

  describe("bible_note_created", () => {
    test("a note with no root at all fails", () => {
      expect(verdict({ ...ok, note_root_type: null }, "bible_note_created")).toBe("FAIL");
    });
    test("a note under the MANUSCRIPT's root fails", () => {
      // The named defect: `bible` and not merely "some root". A note beside the
      // writer's chapters is in the book.
      expect(verdict({ ...ok, note_root_type: "part" }, "bible_note_created")).toBe("FAIL");
    });
    test("a note that took no prose fails", () => {
      expect(verdict({ ...ok, note_body_holds_nonce: false }, "bible_note_created")).toBe("FAIL");
    });
  });

  describe("bible_excluded_from_manuscript", () => {
    test("the note's text in the exported book fails", () => {
      expect(
        verdict({ ...ok, export_holds_note_nonce: true }, "bible_excluded_from_manuscript"),
      ).toBe("FAIL");
    });
    test("an export holding no manuscript prose is UNKNOWN, never PASS", () => {
      // The needle. An exporter that emitted nothing excludes the bible
      // perfectly, and reporting that as evidence is the recorded vacuous
      // stability property.
      expect(
        verdict(
          { ...ok, export_holds_manuscript_prose: false, export_holds_note_nonce: false },
          "bible_excluded_from_manuscript",
        ),
      ).toBe("UNKNOWN");
    });
    test("an empty export that ALSO carries the note is still UNKNOWN", () => {
      // Impossible in practice and stated anyway: the missing needle is the
      // stronger fact, and a FAIL here would name the wrong defect.
      expect(
        verdict(
          { ...ok, export_holds_manuscript_prose: false, export_holds_note_nonce: true },
          "bible_excluded_from_manuscript",
        ),
      ).toBe("UNKNOWN");
    });
  });

  describe("synopsis_saved", () => {
    test("no row fails", () => {
      expect(verdict({ ...ok, synopsis_rows: 0 }, "synopsis_saved")).toBe("FAIL");
    });
    test("two rows fail even when one of them is right", () => {
      expect(verdict({ ...ok, synopsis_rows: 2 }, "synopsis_saved")).toBe("FAIL");
    });
    test("the right text on the wrong row fails", () => {
      expect(verdict({ ...ok, synopsis_on_the_open_scene: false }, "synopsis_saved")).toBe("FAIL");
    });
    test("a truncated body fails, where a containment check would pass", () => {
      expect(verdict({ ...ok, synopsis_body: "She has not opened the" }, "synopsis_saved")).toBe(
        "FAIL",
      );
    });
  });

  describe("synopsis_prefills_on_reopen", () => {
    test("a row deleted by the blind re-save fails", () => {
      // What a panel that did not prefill actually does: saves an empty field,
      // and the store deletes the row.
      expect(
        verdict({ ...ok, synopsis_after_blind_resave: "" }, "synopsis_prefills_on_reopen"),
      ).toBe("FAIL");
    });
    test("a body that came back different fails", () => {
      expect(
        verdict(
          { ...ok, synopsis_after_blind_resave: "something else entirely" },
          "synopsis_prefills_on_reopen",
        ),
      ).toBe("FAIL");
    });
  });

  describe("cast_member_created", () => {
    test("a name that never reached the file fails", () => {
      expect(verdict({ ...ok, cast_names: [] }, "cast_member_created")).toBe("FAIL");
    });
    test("some OTHER name in the file does not satisfy it", () => {
      expect(verdict({ ...ok, cast_names: ["Ruben"] }, "cast_member_created")).toBe("FAIL");
    });
    test("a member stored under no kind fails", () => {
      expect(verdict({ ...ok, cast_kind: "" }, "cast_member_created")).toBe("FAIL");
    });
    test("a member stored under the wrong kind fails", () => {
      expect(verdict({ ...ok, cast_kind: "place" }, "cast_member_created")).toBe("FAIL");
    });
  });

  describe("appearance_tagged", () => {
    test("an untagged scene fails", () => {
      expect(
        verdict({ ...ok, appearance_on_scene: [], appearance_rows_total: 0 }, "appearance_tagged"),
      ).toBe("FAIL");
    });
    test("the wrong member on the scene fails", () => {
      expect(verdict({ ...ok, appearance_on_scene: ["Ruben"] }, "appearance_tagged")).toBe("FAIL");
    });
    test("the right member plus rows the writer never asked for fails", () => {
      // A save that tagged every item would put the ticked member on the open
      // scene too, so the per-scene assertion alone cannot see it.
      expect(verdict({ ...ok, appearance_rows_total: 40 }, "appearance_tagged")).toBe("FAIL");
    });
  });

  describe("cast_alias_saved", () => {
    test("MUTATION TARGET: no alias stored at all fails", () => {
      expect(verdict({ ...ok, cast_aliases: [] }, "cast_alias_saved")).toBe("FAIL");
    });
    test("a stored alias that is not the one typed fails", () => {
      expect(verdict({ ...ok, cast_aliases: ["Something else"] }, "cast_alias_saved")).toBe(
        "FAIL",
      );
    });
    test("the typed alias among several others still passes", () => {
      expect(verdict({ ...ok, cast_aliases: ["Roland", "Ils"] }, "cast_alias_saved")).toBe("PASS");
    });
  });

  describe("cast_alias_marks", () => {
    test("MUTATION TARGET: a card that never opened fails", () => {
      expect(verdict({ ...ok, cast_alias_card_text: null }, "cast_alias_marks")).toBe("FAIL");
    });
    test("a card that opened naming somebody else fails", () => {
      expect(verdict({ ...ok, cast_alias_card_text: "Somebody Else" }, "cast_alias_marks")).toBe(
        "FAIL",
      );
    });
    test("an empty card text fails", () => {
      expect(verdict({ ...ok, cast_alias_card_text: "" }, "cast_alias_marks")).toBe("FAIL");
    });
  });

  describe("picture_thumbnail_bounded", () => {
    test("no thumbnail file fails", () => {
      expect(verdict({ ...ok, thumbnail_long_side: 0 }, "picture_thumbnail_bounded")).toBe("FAIL");
    });
    test("a file that is not a PNG fails", () => {
      expect(verdict({ ...ok, thumbnail_long_side: null }, "picture_thumbnail_bounded")).toBe(
        "FAIL",
      );
    });
    test("256 passes and 257 fails", () => {
      // The boundary itself. A threshold test far from the boundary tests the
      // arithmetic, not the comparison -- five gates here were caught that way.
      expect(verdict({ ...ok, thumbnail_long_side: 256 }, "picture_thumbnail_bounded")).toBe("PASS");
      expect(verdict({ ...ok, thumbnail_long_side: 257 }, "picture_thumbnail_bounded")).toBe("FAIL");
    });
    test("a thumbnail that is the original untouched fails", () => {
      // A small enough original would be under the ceiling already, and a
      // regeneration that copied the file would then pass a bare ceiling.
      expect(
        verdict(
          { ...ok, thumbnail_long_side: 200, original_long_side: 200 },
          "picture_thumbnail_bounded",
        ),
      ).toBe("FAIL");
    });
  });

  describe("picture_viewer_opens", () => {
    test("a press that painted no viewer fails", () => {
      expect(verdict({ ...ok, picture_viewer_open: false }, "picture_viewer_opens")).toBe("FAIL");
    });
    test("no button to press is UNKNOWN, never PASS and never FAIL", () => {
      // Nothing was pressed, so the viewer's claim was not tested. Reporting
      // FAIL would name a defect in the viewer for a defect in the panel.
      expect(
        verdict(
          { ...ok, picture_full_button_found: false, picture_viewer_open: false },
          "picture_viewer_opens",
        ),
      ).toBe("UNKNOWN");
    });
  });

  describe("peak_rss_mb", () => {
    test("750 passes and 751 fails", () => {
      expect(verdict({ ...ok, peak_rss_mb: 750 }, "peak_rss_mb")).toBe("PASS");
      expect(verdict({ ...ok, peak_rss_mb: 751 }, "peak_rss_mb")).toBe("FAIL");
    });
    test("a figure taken with no picture open is UNKNOWN, even under the ceiling", () => {
      // Nine rigs have recorded this gate without a photograph anywhere near
      // the process. A tenth such number under this gate's name would be the
      // reading the whole rig exists to stop being taken.
      expect(
        verdict(
          { ...ok, picture_full_button_found: false, peak_rss_mb: 300 },
          "peak_rss_mb",
        ),
      ).toBe("UNKNOWN");
    });
  });
});
