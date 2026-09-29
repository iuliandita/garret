// app/harness/test/mirror-acts-gates.test.ts
// Mirror actions, including the explicit full check and preservation guards.
import { describe, expect, test } from "bun:test";
import { evaluateMirrorActsGates, type MirrorActsMetrics } from "../src/gates";

/** A run where every act behaved exactly as designed. Every test below moves
 *  ONE field. */
const GREEN: MirrorActsMetrics = {
  files_in_folder_before: 0,
  files_in_folder_after: 5,
  store_documents: 5,
  state_sentence: "Mirroring 5 files.",
  state_sentence_expected_count: 5,
  where_names_the_directory: true,
  where_sentence_redacted: "The mirror is written to <scratch>/my-novel",
  settings_mirrored_book_ids: ["0123456789abcdef0123456789abcdef"],
  book_id: "0123456789abcdef0123456789abcdef",

  rows_before_any_reopen: 1,
  edited_file_holds_the_writers_words: true,
  pass_window_ms: 20_000,
  book_side_rev_moved: true,
  outside_edit_led_by_ms: 11_000,
  watched_document_row_found: true,
  process_restarted: false,

  conflict_row_state_text: "The words changed here and in your book",
  conflict_state_expected: "The words changed here and in your book",
  sidecar_name: "scene-one.from-project.md",
  sidecar_exists: true,
  sidecar_holds_the_books_words: true,
  rows_at_conflict: 1,
  rows_about_other_files: 0,
  sidecar_named_in_a_row: false,

  thorough_process_restarted: false,
  thorough_metadata_preserved: true,
  thorough_was_invisible: true,
  thorough_pressed: true,
  thorough_row_found: true,
  thorough_survived_restart: true,
  thorough_rev_moved: true,
  thorough_pass_ms: 10_000,
  thorough_file_preserved: true,
  scheduled_warmup_reached_mirror: true,
  pending_commit_reached_store: true,
  pending_window_ms: 500,
  pending_indicator_text: "The readable folder is being written",
  pending_indicator_expected: "The readable folder is being written",
  pending_mirror_lacks_second_marker: true,
  pending_popover_captured: true,
  completion_reached_mirror: true,
  completion_indicator_text: "The readable folder matches what you have typed",
  completion_indicator_expected: "The readable folder matches what you have typed",
  owned_cleanup_killed: [0, 0, 0, 1],
  owned_cleanup_succeeded: [true, true, true, true],
  peak_rss_mb: 500,
};

function verdictOf(gate: string, patch: Partial<MirrorActsMetrics>): string {
  const found = evaluateMirrorActsGates({ ...GREEN, ...patch }).find((v) => v.gate === gate);
  if (found === undefined) throw new Error(`no gate named ${gate}`);
  return found.verdict;
}

test("a run where every act behaved as designed is green on every gate", () => {
  const verdicts = evaluateMirrorActsGates(GREEN);
  expect(verdicts).toHaveLength(14);
  expect(verdicts.filter((v) => v.verdict !== "PASS")).toEqual([]);
});

test("every gate states a threshold and a value", () => {
  for (const v of evaluateMirrorActsGates(GREEN)) {
    expect(v.threshold.length).toBeGreaterThan(10);
    expect(String(v.value).length).toBeGreaterThan(0);
  }
});

describe("enable_writes_the_folder", () => {
  test("fails the vacuity guard when the folder already held files before the press", () => {
    expect(verdictOf("enable_writes_the_folder", { files_in_folder_before: 3 })).toBe("FAIL");
  });
  test("fails when the store has no documents even though the folder reads empty after", () => {
    expect(
      verdictOf("enable_writes_the_folder", { store_documents: 0, files_in_folder_after: 0 }),
    ).toBe("FAIL");
  });
  test("fails when the folder holds fewer files than documents", () => {
    expect(verdictOf("enable_writes_the_folder", { files_in_folder_after: 2 })).toBe("FAIL");
  });
});

describe("enable_reports_where_and_how_many", () => {
  test("fails when the state sentence names the wrong count", () => {
    expect(verdictOf("enable_reports_where_and_how_many", { state_sentence: "Mirroring 4 files." })).toBe(
      "FAIL",
    );
  });
  test("fails when the expected count is only a substring of the count named", () => {
    // 4 inside "40" is not the count 4.
    expect(
      verdictOf("enable_reports_where_and_how_many", {
        state_sentence_expected_count: 4,
        state_sentence: "40 files, last written just now.",
      }),
    ).toBe("FAIL");
  });
  test("fails when the where sentence did not name the mirror directory", () => {
    // The rig compares the WHOLE path it handed the host, because the
    // sentence's own wording contains the word "mirror" and a basename check
    // passed on that alone.
    expect(
      verdictOf("enable_reports_where_and_how_many", { where_names_the_directory: false }),
    ).toBe("FAIL");
  });
  test("fails when there was no where sentence at all", () => {
    expect(
      verdictOf("enable_reports_where_and_how_many", { where_sentence_redacted: "" }),
    ).toBe("FAIL");
  });
  test("fails the vacuity guard when the expected count is zero", () => {
    expect(
      verdictOf("enable_reports_where_and_how_many", {
        state_sentence_expected_count: 0,
        state_sentence: "Mirroring 0 files.",
      }),
    ).toBe("FAIL");
  });
});

describe("enable_is_remembered", () => {
  test("fails when a legacy slug is stored instead of an identity", () => {
    expect(verdictOf("enable_is_remembered", {
      settings_mirrored_book_ids: ["my-novel"], book_id: "my-novel",
    })).toBe("FAIL");
  });
  test("fails when the identity is absent from the mirrored list", () => {
    expect(verdictOf("enable_is_remembered", { settings_mirrored_book_ids: ["some-other-project"] })).toBe("FAIL");
  });
  test("fails when the identity is empty", () => {
    expect(verdictOf("enable_is_remembered", { book_id: "" })).toBe("FAIL");
  });
});

describe("the_panel_offers_the_change_without_a_reopen", () => {
  test("fails when the process was restarted, even with rows present", () => {
    expect(verdictOf("the_panel_offers_the_change_without_a_reopen", { process_restarted: true })).toBe("FAIL");
  });
  test("fails when no rows were offered before any reopen", () => {
    expect(verdictOf("the_panel_offers_the_change_without_a_reopen", { rows_before_any_reopen: 0 })).toBe("FAIL");
  });
  test("fails when no row names the watched document", () => {
    expect(verdictOf("the_panel_offers_the_change_without_a_reopen", { watched_document_row_found: false })).toBe(
      "FAIL",
    );
  });
});

describe("conflict_is_reported", () => {
  test("fails when the row states the plain prose state sentence instead", () => {
    // `mirror.changes.state.prose`, the sentence the rig records as
    // `prose_state_for_comparison`: what a run that never reached a conflict
    // finds in the conflict sentence's place.
    expect(verdictOf("conflict_is_reported", { conflict_row_state_text: "The words changed" })).toBe(
      "FAIL",
    );
  });
  test("fails the vacuity guard when the expected sentence is empty", () => {
    expect(
      verdictOf("conflict_is_reported", { conflict_state_expected: "", conflict_row_state_text: "" }),
    ).toBe("FAIL");
  });
});

describe("the_books_side_is_preserved", () => {
  test("fails when the sidecar name lacks the expected suffix", () => {
    expect(verdictOf("the_books_side_is_preserved", { sidecar_name: "scene-one.bak" })).toBe("FAIL");
  });
  test("fails when the sidecar does not exist", () => {
    expect(verdictOf("the_books_side_is_preserved", { sidecar_exists: false })).toBe("FAIL");
  });
  test("fails when the sidecar's body does not hold the book's words", () => {
    expect(verdictOf("the_books_side_is_preserved", { sidecar_holds_the_books_words: false })).toBe("FAIL");
  });
});

describe("the_sidecar_is_not_offered_as_a_change", () => {
  test("fails when the sidecar is named in a row", () => {
    expect(verdictOf("the_sidecar_is_not_offered_as_a_change", { sidecar_named_in_a_row: true })).toBe(
      "FAIL",
    );
  });
  test("fails the vacuity guard when no rows were offered at all", () => {
    expect(
      verdictOf("the_sidecar_is_not_offered_as_a_change", {
        rows_at_conflict: 0,
        sidecar_named_in_a_row: false,
      }),
    ).toBe("FAIL");
  });
  test("fails when a row is about a file the rig never edited, whatever it is called", () => {
    expect(
      verdictOf("the_sidecar_is_not_offered_as_a_change", { rows_at_conflict: 2, rows_about_other_files: 1 }),
    ).toBe("FAIL");
  });
});

describe("peak_rss_mb", () => {
  test("passes exactly at the line and fails one over it", () => {
    expect(verdictOf("peak_rss_mb", { peak_rss_mb: 750 })).toBe("PASS");
    expect(verdictOf("peak_rss_mb", { peak_rss_mb: 751 })).toBe("FAIL");
  });
  test("fails on a zero measurement, which is no sample rather than a real reading", () => {
    expect(verdictOf("peak_rss_mb", { peak_rss_mb: 0 })).toBe("FAIL");
  });
});

describe("the_watcher_keeps_the_pass_off_an_edited_file", () => {
  // The gate a sabotage run wrote. With `spawn_mirror_watcher` disabled the
  // change panel STILL offers the row -- it scans when it opens -- so the
  // panel gate above passes with the watcher gone. What actually needs the
  // watcher is the entry being paused in time, which is what stops the pass
  // rewriting the writer's file with the book's words.
  test("passes when the file still holds the writer's words after a real pass window", () => {
    expect(verdictOf("the_watcher_keeps_the_pass_off_an_edited_file", {})).toBe("PASS");
  });
  test("fails when the pass overwrote the writer's words", () => {
    expect(
      verdictOf("the_watcher_keeps_the_pass_off_an_edited_file", {
        edited_file_holds_the_writers_words: false,
      }),
    ).toBe("FAIL");
  });
  test("fails the vacuity guard when no pass was ever owed", () => {
    // A file nothing was going to rewrite is unchanged for free.
    expect(
      verdictOf("the_watcher_keeps_the_pass_off_an_edited_file", { pass_window_ms: 4_000 }),
    ).toBe("FAIL");
  });
  test("fails when the window was never measured at all", () => {
    expect(
      verdictOf("the_watcher_keeps_the_pass_off_an_edited_file", { pass_window_ms: 0 }),
    ).toBe("FAIL");
  });
  test("passes exactly at the staleness bound and fails one under it", () => {
    expect(verdictOf("the_watcher_keeps_the_pass_off_an_edited_file", { pass_window_ms: 10_000 })).toBe("PASS");
    expect(verdictOf("the_watcher_keeps_the_pass_off_an_edited_file", { pass_window_ms: 9_999 })).toBe("FAIL");
  });
  test("fails when the typing never reached the store, so no pass was owed", () => {
    // `mirror-cli`'s typingLanded guard: a click that missed the editor
    // leaves the file unchanged for free.
    expect(
      verdictOf("the_watcher_keeps_the_pass_off_an_edited_file", { book_side_rev_moved: false }),
    ).toBe("FAIL");
  });
});


describe("the thorough check", () => {
  for (const field of ["thorough_metadata_preserved", "thorough_was_invisible", "thorough_pressed", "thorough_row_found"] as const) {
    test(`refuses discovery evidence without ${field}`, () => {
      expect(verdictOf("thorough_check_finds_a_preserved_metadata_edit", { [field]: false })).toBe("FAIL");
    });
  }
  test("refuses discovery after a restart", () => {
    expect(verdictOf("thorough_check_finds_a_preserved_metadata_edit", { thorough_process_restarted: true })).toBe("FAIL");
  });
  for (const patch of [{ thorough_survived_restart: false }, { thorough_rev_moved: false }, { thorough_file_preserved: false },
    { thorough_pass_ms: 9_999 }, { thorough_pressed: false }]) {
    test(`refuses vacuous preservation ${JSON.stringify(patch)}`, () => {
      expect(verdictOf("thorough_check_keeps_the_pass_off_an_edited_file", patch)).toBe("FAIL");
    });
  }
});

describe("mirror pending indication", () => {
  test("requires a successful cleanup receipt for every owned launch", () => {
    const gate = "mirror_actions_reap_every_owned_launch";
    expect(verdictOf(gate, { owned_cleanup_succeeded: [] })).toBe("FAIL");
    expect(verdictOf(gate, { owned_cleanup_succeeded: [true, true, true] })).toBe("FAIL");
    expect(verdictOf(gate, { owned_cleanup_succeeded: [true, false, true, true] })).toBe("FAIL");
    expect(verdictOf(gate, { owned_cleanup_killed: [] })).toBe("FAIL");
    expect(verdictOf(gate, { owned_cleanup_killed: [0, 0, 0, -1] })).toBe("FAIL");
    expect(verdictOf(gate, { owned_cleanup_killed: [0, 2, 3, 1] })).toBe("PASS");
  });
  test("fails if the scheduled warm-up never reaches the actual folder", () => {
    expect(
      verdictOf("mirror_reports_updating_for_a_committed_pending_save", {
        scheduled_warmup_reached_mirror: false,
      }),
    ).toBe("FAIL");
  });
  test("fails when the full second marker never commits to SQLite", () => {
    expect(
      verdictOf("mirror_reports_updating_for_a_committed_pending_save", {
        pending_commit_reached_store: false,
      }),
    ).toBe("FAIL");
  });
  test("fails at either edge of the scheduling window", () => {
    expect(verdictOf("mirror_reports_updating_for_a_committed_pending_save", { pending_window_ms: 0 })).toBe("FAIL");
    expect(verdictOf("mirror_reports_updating_for_a_committed_pending_save", { pending_window_ms: 10_000 })).toBe("FAIL");
  });
  test("fails if current is shown while the second marker is absent", () => {
    expect(
      verdictOf("mirror_reports_updating_for_a_committed_pending_save", {
        pending_indicator_text: "The readable folder matches what you have typed",
      }),
    ).toBe("FAIL");
  });
  test("fails if the folder already contains the second marker or the popover was not captured", () => {
    expect(
      verdictOf("mirror_reports_updating_for_a_committed_pending_save", {
        pending_mirror_lacks_second_marker: false,
      }),
    ).toBe("FAIL");
    expect(
      verdictOf("mirror_reports_updating_for_a_committed_pending_save", {
        pending_popover_captured: false,
      }),
    ).toBe("FAIL");
  });
  test("fails if completion does not write the same marker or return the indicator to current", () => {
    expect(
      verdictOf("mirror_returns_current_after_the_pending_save_lands", {
        completion_reached_mirror: false,
      }),
    ).toBe("FAIL");
    expect(
      verdictOf("mirror_returns_current_after_the_pending_save_lands", {
        completion_indicator_text: "The readable folder is being written",
      }),
    ).toBe("FAIL");
  });
});
