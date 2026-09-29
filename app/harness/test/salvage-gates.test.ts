// app/harness/test/salvage-gates.test.ts
// The sixteen salvage gates, and the failing direction of each. A threshold
// test far from the boundary tests the arithmetic and not the comparison, so
// both numeric gates are exercised AT their boundary and one step past it.
import { describe, expect, test } from "bun:test";
import {
  evaluateSalvageGates,
  type SalvageCorpusRun,
  type SalvageMetrics,
} from "../src/gates";

/** A run where everything came back. Every test below moves ONE field. */
const GREEN: SalvageMetrics = {
  fixture: "tiny",
  store_items: 40,
  store_documents: 30,
  manifest_items_recovered: 40,
  manifest_documents_recovered: 30,
  document_files_written: 30,
  manuscript_holds_stored_prose: true,
  synopses_planted: 2,
  synopses_recovered: 2,
  synopses_in_file: 2,
  synopsis_bodies_match: true,
  cast_members_planted: 2,
  cast_fields_planted: 2,
  cast_members_recovered: 2,
  cast_fields_recovered: 2,
  cast_file_agrees: true,
  appearances_planted: 2,
  appearances_recovered: 2,
  appearance_lines_found: 2,
  comments_planted: 3,
  comments_recovered: 3,
  comments_orphaned: 1,
  comment_orphan_marks: 1,
  comment_resolved_marks: 1,
  comment_bodies_match: true,
  collapsed_anchor_planted: true,
  healthy_complete: true,
  healthy_loss_kinds: [],
  wordlist_planted: ["Zelenko", "alderman", "Ravensmoot"],
  wordlist_recovered: 3,
  wordlist_in_file: ["Ravensmoot", "Zelenko", "alderman"],
  pictures_planted: 1,
  pictures_recovered: 1,
  picture_bytes_match: true,
  covers_planted: 2,
  covers_recovered: 2,
  cover_files_written: 2,
  design_planted: { "design.font": "Crimson Text", "design.glyph": "fleuron" },
  design_recovered: { "design.font": "Crimson Text", "design.glyph": "fleuron" },
  snapshots_planted: 1,
  snapshot_documents_planted: 2,
  snapshots_recovered: 1,
  versions_recovered: 2,
  snapshot_files_written: 2,
  snapshot_holds_the_past_draft: true,
  automatic_versions_planted: 2,
  versions_dropped: 2,
  damaged_exit_code: 3,
  damaged_complete: false,
  expected_loss_kinds: ["missing_blob", "orphan_doc"],
  damaged_loss_kinds: ["missing_blob", "orphan_doc"],
  damaged_raw_bodies: 1,
  exit_healthy: 0,
  exit_occupied_destination: 1,
  exit_unreadable_source: 2,
  exit_damaged: 3,
  salvage_ms: 493,
  peak_rss_mb: 101,
  manifests_read: 8,
  named_paths_in_manifests: [],
  corpus: greenCorpus(),
  corpus_healthy_items: 40,
  corpus_healthy_documents: 30,
};

/** One damaged file that answered, recovering less than the healthy salvage and
 *  saying so. Every corpus test below moves ONE field of ONE entry. */
function run(name: string, patch: Partial<SalvageCorpusRun> = {}): SalvageCorpusRun {
  return {
    name,
    allowed_exits: [2, 3],
    exit_code: 3,
    wall_ms: 480,
    panicked: false,
    complete: false,
    items_recovered: 31,
    documents_recovered: 22,
    loss_kinds: ["enumeration_stopped"],
    digest: `digest-of-${name}`,
    digest_again: `digest-of-${name}`,
    ...patch,
  };
}

/** A corpus where every file behaved: the two refusals refused with 2, the torn
 *  page stopped an enumeration, and both tail-loss files came back with rows. */
function greenCorpus(): SalvageCorpusRun[] {
  return [
    run("header_torn", {
      allowed_exits: [2],
      exit_code: 2,
      complete: null,
      items_recovered: null,
      documents_recovered: null,
      loss_kinds: [],
      wall_ms: 43,
    }),
    run("tail_lost_at_page_boundary", { loss_kinds: ["file_truncated"] }),
    run("tail_lost_mid_page", { loss_kinds: ["file_truncated"] }),
    run("torn_page_zeroed"),
    run("torn_page_overwritten", { loss_kinds: ["unreadable_doc_row"] }),
    run("header_page_size_lie", {
      exit_code: 2,
      complete: null,
      items_recovered: null,
      documents_recovered: null,
      loss_kinds: [],
      wall_ms: 41,
    }),
    run("broken_interior_pointer", { loss_kinds: ["unreadable_doc_row"] }),
    run("orphaned_wal", {
      allowed_exits: [0, 2, 3],
      exit_code: 0,
      complete: true,
      items_recovered: 40,
      documents_recovered: 30,
      loss_kinds: [],
    }),
  ];
}

/** Replace one entry of the green corpus, by name. */
function withEntry(name: string, patch: Partial<SalvageCorpusRun>): Partial<SalvageMetrics> {
  return {
    corpus: greenCorpus().map((r) => (r.name === name ? { ...r, ...patch } : r)),
  };
}

function verdictOf(gate: string, patch: Partial<SalvageMetrics>): string {
  const found = evaluateSalvageGates({ ...GREEN, ...patch }).find((v) => v.gate === gate);
  if (found === undefined) throw new Error(`no gate named ${gate}`);
  return found.verdict;
}

function reds(patch: Partial<SalvageMetrics>): string[] {
  return evaluateSalvageGates({ ...GREEN, ...patch })
    .filter((v) => v.verdict !== "PASS")
    .map((v) => v.gate);
}

test("a run where everything came back is green on every gate", () => {
  const verdicts = evaluateSalvageGates(GREEN);
  expect(verdicts).toHaveLength(24);
  expect(verdicts.filter((v) => v.verdict !== "PASS")).toEqual([]);
});

test("every gate states a threshold and a value", () => {
  for (const v of evaluateSalvageGates(GREEN)) {
    expect(v.threshold.length).toBeGreaterThan(20);
    expect(String(v.value).length).toBeGreaterThan(0);
  }
});

describe("salvage_prose_recovered", () => {
  test("fails when one document is not counted", () => {
    expect(verdictOf("salvage_prose_recovered", { manifest_documents_recovered: 29 })).toBe("FAIL");
  });
  test("fails when one item is not counted", () => {
    expect(verdictOf("salvage_prose_recovered", { manifest_items_recovered: 39 })).toBe("FAIL");
  });
  test("fails when the counts are right and a file is missing", () => {
    expect(verdictOf("salvage_prose_recovered", { document_files_written: 29 })).toBe("FAIL");
  });
  test("THE NEEDLE: counts and files right, manuscript empty of the store's prose", () => {
    // Without this clause a recovery that wrote thirty empty files passes.
    expect(verdictOf("salvage_prose_recovered", { manuscript_holds_stored_prose: false })).toBe(
      "FAIL",
    );
  });
});

describe("salvage_synopses_recovered", () => {
  test("fails when the manifest undercounts", () => {
    expect(verdictOf("salvage_synopses_recovered", { synopses_recovered: 1 })).toBe("FAIL");
  });
  test("fails when the count is right and the file holds fewer", () => {
    expect(verdictOf("salvage_synopses_recovered", { synopses_in_file: 1 })).toBe("FAIL");
  });
  test("fails when both counts are right and a body does not match", () => {
    expect(verdictOf("salvage_synopses_recovered", { synopsis_bodies_match: false })).toBe("FAIL");
  });
});

describe("salvage_cast_recovered", () => {
  test("fails when a member is not counted", () => {
    expect(verdictOf("salvage_cast_recovered", { cast_members_recovered: 1 })).toBe("FAIL");
  });
  test("fails when a detail is not counted", () => {
    expect(verdictOf("salvage_cast_recovered", { cast_fields_recovered: 1 })).toBe("FAIL");
  });
  test("fails when the counts agree and the file does not", () => {
    expect(verdictOf("salvage_cast_recovered", { cast_file_agrees: false })).toBe("FAIL");
  });
});

describe("salvage_appearances_recovered", () => {
  test("fails when a tag is not counted", () => {
    expect(verdictOf("salvage_appearances_recovered", { appearances_recovered: 1 })).toBe("FAIL");
  });
  test("fails when the count is right and no line names the item", () => {
    // 039's whole point: a count alone passes a list of uuid pairs.
    expect(verdictOf("salvage_appearances_recovered", { appearance_lines_found: 0 })).toBe("FAIL");
  });
});

describe("salvage_comments_recovered", () => {
  test("fails when a note is not counted", () => {
    expect(verdictOf("salvage_comments_recovered", { comments_recovered: 2 })).toBe("FAIL");
  });
  test("fails when a quote or a body does not match", () => {
    expect(verdictOf("salvage_comments_recovered", { comment_bodies_match: false })).toBe("FAIL");
  });
  test("fails when the file carries no mark of any kind", () => {
    expect(
      verdictOf("salvage_comments_recovered", {
        comment_orphan_marks: 0,
        comment_resolved_marks: 0,
      }),
    ).toBe("FAIL");
  });
});

describe("salvage_collapsed_anchor_is_not_a_loss", () => {
  test("FAILS when the collapsed anchor is reported as damage", () => {
    // The exact defect 049 refused: a Loss here hands complete:false and exit 3
    // to every healthy, heavily revised book.
    expect(
      verdictOf("salvage_collapsed_anchor_is_not_a_loss", {
        healthy_complete: false,
        healthy_loss_kinds: ["orphan_comment"],
      }),
    ).toBe("FAIL");
  });
  test("fails when the manifest says complete AND carries a loss", () => {
    // `complete` and `losses` are two readings of one fact, and this gate reads
    // BOTH so a build where they drift apart fails rather than being believed.
    // Salvage cannot produce this pair today; the clause exists because the
    // alternative is trusting one field to speak for the other.
    expect(
      verdictOf("salvage_collapsed_anchor_is_not_a_loss", {
        healthy_complete: true,
        healthy_loss_kinds: ["orphan_comment"],
      }),
    ).toBe("FAIL");
  });

  test("fails when the note is not counted as orphaned", () => {
    expect(verdictOf("salvage_collapsed_anchor_is_not_a_loss", { comments_orphaned: 0 })).toBe(
      "FAIL",
    );
  });
  test("fails when the file carries no (orphaned) mark", () => {
    expect(verdictOf("salvage_collapsed_anchor_is_not_a_loss", { comment_orphan_marks: 0 })).toBe(
      "FAIL",
    );
  });
  test("UNKNOWN, never PASS, when no collapsed anchor was planted", () => {
    // A gate whose subject was never in the file must not report a verdict about
    // it. Asserted against PASS as well as against the value: the two ways to
    // get this wrong are silence and a claim.
    expect(verdictOf("salvage_collapsed_anchor_is_not_a_loss", { collapsed_anchor_planted: false }))
      .toBe("UNKNOWN");
  });
});

describe("salvage_wordlist_recovered", () => {
  test("fails when a word is not counted", () => {
    expect(verdictOf("salvage_wordlist_recovered", { wordlist_recovered: 2 })).toBe("FAIL");
  });
  test("fails when the words come back in the order they were WRITTEN", () => {
    // The planted order is Zelenko, alderman, Ravensmoot and the alphabetical
    // one is Ravensmoot, Zelenko, alderman. An emitter that did not sort hands
    // back the first, and no other input separates the two implementations.
    expect(
      verdictOf("salvage_wordlist_recovered", {
        wordlist_in_file: ["Zelenko", "alderman", "Ravensmoot"],
      }),
    ).toBe("FAIL");
  });
  test("fails when a word is counted and missing from the file", () => {
    expect(
      verdictOf("salvage_wordlist_recovered", { wordlist_in_file: ["Ravensmoot", "Zelenko"] }),
    ).toBe("FAIL");
  });
});

describe("salvage_pictures_recovered", () => {
  test("fails when the photograph is not counted", () => {
    expect(verdictOf("salvage_pictures_recovered", { pictures_recovered: 0 })).toBe("FAIL");
  });
  test("fails when it is counted and the bytes differ", () => {
    expect(verdictOf("salvage_pictures_recovered", { picture_bytes_match: false })).toBe("FAIL");
  });
});

describe("salvage_covers_recovered", () => {
  test("fails when one side is not counted", () => {
    expect(verdictOf("salvage_covers_recovered", { covers_recovered: 1 })).toBe("FAIL");
  });
  test("fails when both are counted and one file is not there", () => {
    expect(verdictOf("salvage_covers_recovered", { cover_files_written: 1 })).toBe("FAIL");
  });
});

describe("salvage_design_recovered", () => {
  test("fails when a row comes back null", () => {
    expect(
      verdictOf("salvage_design_recovered", {
        design_recovered: { "design.font": "Crimson Text", "design.glyph": null },
      }),
    ).toBe("FAIL");
  });
  test("fails when a value is changed rather than handed back verbatim", () => {
    // 048: salvage states values and does not interpret them. A build that ran
    // these through its own parser would drop what it cannot read.
    expect(
      verdictOf("salvage_design_recovered", {
        design_recovered: { "design.font": "Crimson", "design.glyph": "fleuron" },
      }),
    ).toBe("FAIL");
  });
  test("fails rather than passes vacuously when nothing was planted", () => {
    // An empty planted map makes `every` true for any recovery at all, which is
    // a PASS on a run that graded nothing.
    expect(verdictOf("salvage_design_recovered", { design_planted: {}, design_recovered: {} })).toBe(
      "FAIL",
    );
  });
});

describe("salvage_snapshots_recovered", () => {
  test("fails when the named moment is not counted", () => {
    expect(verdictOf("salvage_snapshots_recovered", { snapshots_recovered: 0 })).toBe("FAIL");
  });
  test("fails when a document of it is not written", () => {
    expect(verdictOf("salvage_snapshots_recovered", { snapshot_files_written: 1 })).toBe("FAIL");
  });
  test("THE NEEDLE: counts right, files written, and none holds the past draft", () => {
    expect(verdictOf("salvage_snapshots_recovered", { snapshot_holds_the_past_draft: false })).toBe(
      "FAIL",
    );
  });
});

describe("salvage_versions_dropped_counted", () => {
  test("fails when a dropped version is not counted", () => {
    // 050: a dropped version is in no loss list, so an undercount here is
    // silent loss and nothing else in the recovery says otherwise.
    expect(verdictOf("salvage_versions_dropped_counted", { versions_dropped: 0 })).toBe("FAIL");
  });
  test("fails when more are reported dropped than existed", () => {
    expect(verdictOf("salvage_versions_dropped_counted", { versions_dropped: 3 })).toBe("FAIL");
  });
  test("UNKNOWN when no automatic version was planted", () => {
    expect(
      verdictOf("salvage_versions_dropped_counted", {
        automatic_versions_planted: 0,
        versions_dropped: 0,
      }),
    ).toBe("UNKNOWN");
  });
});

describe("salvage_damage_is_reported", () => {
  test("fails when a scripted loss is not reported", () => {
    expect(verdictOf("salvage_damage_is_reported", { damaged_loss_kinds: ["missing_blob"] })).toBe(
      "FAIL",
    );
  });
  test("fails when a loss NOBODY SCRIPTED is reported", () => {
    // The other direction, and the one a looser gate would miss: a recovery
    // inventing damage is as wrong as one hiding it.
    expect(
      verdictOf("salvage_damage_is_reported", {
        damaged_loss_kinds: ["missing_blob", "orphan_doc", "orphan_item"],
      }),
    ).toBe("FAIL");
  });
  test("fails when the damaged run still calls itself complete", () => {
    expect(verdictOf("salvage_damage_is_reported", { damaged_complete: true })).toBe("FAIL");
  });
  test("fails when the body that would not parse was not written verbatim", () => {
    expect(verdictOf("salvage_damage_is_reported", { damaged_raw_bodies: 0 })).toBe("FAIL");
  });
});

describe("salvage_exit_codes", () => {
  test("fails when a healthy salvage is not 0", () => {
    expect(verdictOf("salvage_exit_codes", { exit_healthy: 3 })).toBe("FAIL");
  });
  test("fails when an occupied destination reads as an unreadable source", () => {
    // 1 and 2 are different sentences: the source was fine and the destination
    // was the operator's mistake.
    expect(verdictOf("salvage_exit_codes", { exit_occupied_destination: 2 })).toBe("FAIL");
  });
  test("fails when a zero-byte file is read as an empty project", () => {
    expect(verdictOf("salvage_exit_codes", { exit_unreadable_source: 0 })).toBe("FAIL");
  });
  test("fails when a salvage carrying losses exits 0", () => {
    expect(verdictOf("salvage_exit_codes", { exit_damaged: 0 })).toBe("FAIL");
  });
});

describe("salvage_ms, at its boundary", () => {
  test("passes AT the threshold", () => {
    expect(verdictOf("salvage_ms", { salvage_ms: 3000 })).toBe("PASS");
  });
  test("fails one millisecond past it", () => {
    expect(verdictOf("salvage_ms", { salvage_ms: 3001 })).toBe("FAIL");
  });
});

describe("peak_rss_mb, at its boundary", () => {
  test("passes AT the threshold", () => {
    expect(verdictOf("peak_rss_mb", { peak_rss_mb: 300 })).toBe("PASS");
  });
  test("fails one megabyte past it", () => {
    expect(verdictOf("peak_rss_mb", { peak_rss_mb: 301 })).toBe("FAIL");
  });
});

describe("one break is one red gate", () => {
  // A gate that goes red for somebody else's break cannot be read as evidence
  // about its own subject. Each of these is a single-field break and the whole
  // claim is the LENGTH of the list.
  test("a lost synopsis reddens only its own gate", () => {
    expect(reds({ synopses_recovered: 1 })).toEqual(["salvage_synopses_recovered"]);
  });
  test("an unsorted wordlist reddens only its own gate", () => {
    expect(reds({ wordlist_in_file: ["Zelenko", "alderman", "Ravensmoot"] })).toEqual([
      "salvage_wordlist_recovered",
    ]);
  });
  test("a dropped design row reddens only its own gate", () => {
    expect(
      reds({ design_recovered: { "design.font": "Crimson Text", "design.glyph": null } }),
    ).toEqual(["salvage_design_recovered"]);
  });
  test("a collapsed anchor reported as a loss reddens only its own gate", () => {
    expect(reds({ healthy_complete: false, healthy_loss_kinds: ["orphan_comment"] })).toEqual([
      "salvage_collapsed_anchor_is_not_a_loss",
    ]);
  });
});

// -------------------------------------------------------------- the corpus
//
// The corpus gates do not grade whether salvage recovered everything -- it will
// not, and a gate that demanded it would be lowered the first time it was
// inconvenient. They grade that every damaged file TERMINATES, does not panic,
// reports what it could not read, and never calls itself complete when it lost
// something.

describe("salvage_corpus_terminates", () => {
  test("fails on an exit code the entry does not allow", () => {
    expect(
      verdictOf("salvage_corpus_terminates", withEntry("torn_page_zeroed", { exit_code: 1 })),
    ).toBe("FAIL");
  });
  test("fails on a killed process, which is how a hang arrives here", () => {
    expect(
      verdictOf("salvage_corpus_terminates", withEntry("torn_page_zeroed", { exit_code: 137 })),
    ).toBe("FAIL");
  });
  test("fails on a panic even when the exit code is one the entry allows", () => {
    expect(
      verdictOf("salvage_corpus_terminates", withEntry("torn_page_zeroed", { panicked: true })),
    ).toBe("FAIL");
  });
  test("fails on a corpus too small to be evidence", () => {
    expect(verdictOf("salvage_corpus_terminates", { corpus: greenCorpus().slice(0, 3) })).toBe(
      "FAIL",
    );
  });
  test("fails on an empty corpus rather than passing over nothing", () => {
    expect(verdictOf("salvage_corpus_terminates", { corpus: [] })).toBe("FAIL");
  });
});

describe("salvage_corpus_completeness_is_honest", () => {
  test("fails when a damaged file calls itself complete having recovered fewer items", () => {
    expect(
      verdictOf(
        "salvage_corpus_completeness_is_honest",
        withEntry("torn_page_zeroed", {
          complete: true,
          exit_code: 0,
          loss_kinds: [],
          items_recovered: 31,
          documents_recovered: 30,
        }),
      ),
    ).toBe("FAIL");
  });
  test("fails when it calls itself complete having recovered fewer documents", () => {
    expect(
      verdictOf(
        "salvage_corpus_completeness_is_honest",
        withEntry("torn_page_zeroed", {
          complete: true,
          exit_code: 0,
          loss_kinds: [],
          items_recovered: 40,
          documents_recovered: 22,
        }),
      ),
    ).toBe("FAIL");
  });
  test("fails when it calls itself complete while carrying a loss", () => {
    expect(
      verdictOf(
        "salvage_corpus_completeness_is_honest",
        withEntry("orphaned_wal", { complete: true, loss_kinds: ["missing_blob"] }),
      ),
    ).toBe("FAIL");
  });
  test("fails when it calls itself complete and exits 3", () => {
    expect(
      verdictOf(
        "salvage_corpus_completeness_is_honest",
        withEntry("orphaned_wal", { complete: true, exit_code: 3 }),
      ),
    ).toBe("FAIL");
  });
  test("passes a file that recovered everything and said so", () => {
    expect(verdictOf("salvage_corpus_completeness_is_honest", {})).toBe("PASS");
  });
});

describe("salvage_corpus_reports_what_it_lost", () => {
  test("fails on a silent short answer", () => {
    expect(
      verdictOf("salvage_corpus_reports_what_it_lost", withEntry("torn_page_zeroed", { loss_kinds: [] })),
    ).toBe("FAIL");
  });
  test("fails on a refusal that did not exit 2", () => {
    expect(
      verdictOf("salvage_corpus_reports_what_it_lost", withEntry("header_torn", { exit_code: 3 })),
    ).toBe("FAIL");
  });
  test("a file that recovered everything owes no loss", () => {
    expect(verdictOf("salvage_corpus_reports_what_it_lost", {})).toBe("PASS");
  });
});

describe("salvage_corpus_is_byte_exact", () => {
  test("fails when a second generation produced different bytes", () => {
    expect(
      verdictOf("salvage_corpus_is_byte_exact", withEntry("tail_lost_mid_page", { digest_again: "other" })),
    ).toBe("FAIL");
  });
  test("fails when two entries are the same bytes", () => {
    expect(
      verdictOf(
        "salvage_corpus_is_byte_exact",
        // BOTH digests move together. Setting only `digest` also makes the
        // entry unstable, and the two clauses would cover for each other --
        // the recorded shape where one rule refuses the input the other was
        // written for, and only a mutation sees it.
        withEntry("tail_lost_mid_page", {
          digest: "digest-of-tail_lost_at_page_boundary",
          digest_again: "digest-of-tail_lost_at_page_boundary",
        }),
      ),
    ).toBe("FAIL");
  });
});

describe("salvage_corpus_enumeration_stopped_is_reached", () => {
  test("fails when the torn index page did not stop an enumeration", () => {
    expect(
      verdictOf(
        "salvage_corpus_enumeration_stopped_is_reached",
        withEntry("torn_page_zeroed", { loss_kinds: ["unreadable_doc_row"] }),
      ),
    ).toBe("FAIL");
  });
  test("reads UNKNOWN, never PASS, when no torn-page entry was generated", () => {
    expect(
      verdictOf("salvage_corpus_enumeration_stopped_is_reached", {
        corpus: greenCorpus().filter((r) => r.name !== "torn_page_zeroed"),
      }),
    ).toBe("UNKNOWN");
  });
});

describe("salvage_corpus_truncation_is_recovered", () => {
  test("fails when a truncated file comes back with nothing", () => {
    expect(
      verdictOf(
        "salvage_corpus_truncation_is_recovered",
        withEntry("tail_lost_at_page_boundary", { items_recovered: 0 }),
      ),
    ).toBe("FAIL");
  });
  test("fails when a truncated file is refused outright, which is the pre-052 build", () => {
    expect(
      verdictOf(
        "salvage_corpus_truncation_is_recovered",
        withEntry("tail_lost_mid_page", {
          exit_code: 2,
          complete: null,
          items_recovered: null,
          documents_recovered: null,
          loss_kinds: [],
        }),
      ),
    ).toBe("FAIL");
  });
  test("fails when the corpus lost one of its two tail-loss entries", () => {
    expect(
      verdictOf("salvage_corpus_truncation_is_recovered", {
        corpus: greenCorpus().filter((r) => r.name !== "tail_lost_mid_page"),
      }),
    ).toBe("FAIL");
  });
});

describe("salvage_corpus_ms", () => {
  test("passes AT the threshold", () => {
    expect(verdictOf("salvage_corpus_ms", withEntry("torn_page_zeroed", { wall_ms: 5000 }))).toBe(
      "PASS",
    );
  });
  test("fails one millisecond past it", () => {
    expect(verdictOf("salvage_corpus_ms", withEntry("torn_page_zeroed", { wall_ms: 5001 }))).toBe(
      "FAIL",
    );
  });
  test("reads the WORST entry and not the last one", () => {
    expect(
      verdictOf("salvage_corpus_ms", withEntry("header_torn", { wall_ms: 9000 })),
    ).toBe("FAIL");
  });
});

test("one break in one corpus file reddens the gate it belongs to and no other", () => {
  expect(reds(withEntry("torn_page_zeroed", { panicked: true }))).toEqual([
    "salvage_corpus_terminates",
  ]);
  expect(reds(withEntry("tail_lost_mid_page", { digest_again: "other" }))).toEqual([
    "salvage_corpus_is_byte_exact",
  ]);
});

describe("salvage_manifest_names_no_path", () => {
  // 054. The manifest is plain text whose whole purpose is to be read by
  // somebody other than the person who ran the command, and it opened with the
  // operating-system user's home directory twice until this slice.
  test("fails when the manifest names an absolute path", () => {
    expect(
      verdictOf("salvage_manifest_names_no_path", {
        named_paths_in_manifests: [
          { run: "healthy", at: "source", value: "/home/writer/books/harbour.db" },
        ],
      }),
    ).toBe("FAIL");
  });

  test("names the run, the key and the value, so a red gate can be acted on", () => {
    const found = evaluateSalvageGates({
      ...GREEN,
      named_paths_in_manifests: [
        { run: "corpus:torn_page_zeroed", at: "meta.recovered_from", value: "/home/writer/x.db" },
      ],
    }).find((v) => v.gate === "salvage_manifest_names_no_path");
    expect(String(found!.value)).toContain("corpus:torn_page_zeroed");
    expect(String(found!.value)).toContain("meta.recovered_from");
    expect(String(found!.value)).toContain("/home/writer/x.db");
  });

  test("VACUITY: an empty list over no manifests at all does not pass", () => {
    // A gate whose claim is "none of them names one" is satisfied perfectly by
    // a run that read none, which is the shape this repo keeps meeting.
    expect(
      verdictOf("salvage_manifest_names_no_path", {
        manifests_read: 0,
        named_paths_in_manifests: [],
      }),
    ).toBe("FAIL");
  });

  test("a short read says so rather than reporting paths it did not find", () => {
    const found = evaluateSalvageGates({ ...GREEN, manifests_read: 1 }).find(
      (v) => v.gate === "salvage_manifest_names_no_path",
    );
    expect(String(found!.value)).toBe("only 1 manifest(s) were read");
  });

  test("passes over the manifests this build writes", () => {
    expect(verdictOf("salvage_manifest_names_no_path", {})).toBe("PASS");
  });
});
