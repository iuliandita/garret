// lab/fault-rig/src/report.ts
import type { ResultRecord } from "./results";
import type { CommitMetrics } from "./measure";
import type { Verdict } from "./model";

const VERDICTS: Verdict[] = ["OLD_INTACT", "NEW_COMPLETE", "REGRESSION", "CORRUPT"];

// Markdown summary rendered straight from result JSON. Numbers are never
// hand-edited; this is the only path from measurements to prose.
export function renderReport(records: ResultRecord[]): string {
  const lines: string[] = ["# Fault rig results", ""];
  lines.push("| candidate | fixture | " + VERDICTS.join(" | ") + " | total |");
  lines.push("|" + "---|".repeat(VERDICTS.length + 3));
  for (const rec of records) {
    const counts = Object.fromEntries(VERDICTS.map((v) => [v, 0])) as
      Record<Verdict, number>;
    for (const cv of rec.verdicts) counts[cv.verdict] += 1;
    const row = [
      rec.candidate,
      rec.fixture,
      ...VERDICTS.map((v) => String(counts[v])),
      String(rec.verdicts.length),
    ];
    lines.push("| " + row.join(" | ") + " |");
  }
  lines.push("");
  // Two case classes with OPPOSITE expectations, so a raw CORRUPT count is not
  // itself a failure: survival cases (SIGKILL) must stay intact; detection
  // cases (injected corruption, "corrupt@*") must be caught as CORRUPT.
  lines.push("| candidate | survival intact | corruption caught | verdict |");
  lines.push("|---|---|---|---|");
  for (const rec of records) {
    const detection = rec.verdicts.filter((v) => v.case.startsWith("corrupt@"));
    const survival = rec.verdicts.filter((v) => !v.case.startsWith("corrupt@"));
    const survivalBad = survival.filter(
      (v) => v.verdict === "REGRESSION" || v.verdict === "CORRUPT",
    ).length;
    const missed = detection.filter((v) => v.verdict !== "CORRUPT").length;
    const pass = survivalBad === 0 && missed === 0;
    lines.push(
      `| ${rec.candidate} | ${survival.length - survivalBad}/${survival.length} | ` +
      `${detection.length - missed}/${detection.length} | ${pass ? "PASS" : "FAIL"} |`,
    );
  }
  lines.push("");
  lines.push(
    "Exit bar: every SIGKILL (survival) case must stay OLD_INTACT/NEW_COMPLETE, " +
    "and every injected-corruption (detection) case must be caught as CORRUPT. " +
    "A survival case that reports CORRUPT/REGRESSION, or a detection case that " +
    "does NOT, fails the backend.",
  );
  lines.push("");
  // The SIGKILL disclaimer is false for a block-layer durability run, which
  // tests exactly the thing that note says is untested.
  const durabilityRun = records.every((r) => r.metrics.durability);
  if (!durabilityRun) {
    lines.push(
      "Scope: SIGKILL exercises atomicity/crash-consistency under process kill, " +
      "not fsync durability against power loss (kernel + page cache survive). " +
      "Treat REGRESSION counts as an atomicity signal, not a durability proof.",
    );
  }
  lines.push(...renderSpotcheck(records));
  lines.push(...renderDurability(records));
  lines.push(...renderCommitMetrics(records));
  lines.push(...renderSalvage(records));
  return lines.join("\n") + "\n";
}

// The binding hedge: identical verdicts against the recorded bun:sqlite run are
// the only thing this section can claim. It is not a second Q3 result.
function renderSpotcheck(records: ResultRecord[]): string[] {
  const withSpot = records.filter((r) => r.metrics.spotcheck);
  if (withSpot.length === 0) return [];
  const lines = ["", "## Binding spot-check (rusqlite vs bun:sqlite)", ""];
  for (const rec of withSpot) {
    const s = rec.metrics.spotcheck!;
    lines.push(
      `\`${rec.candidate}\` writes through \`${s.writer_binding}\` (SQLite ` +
      `${s.sqlite_version_writer}); baseline \`${s.baseline_run_id}\` (rig ` +
      `commit \`${s.baseline_rig_commit}\`) writes through ` +
      `\`${s.reader_binding}\` (SQLite ${s.sqlite_version_reader}). Both are ` +
      `read back and integrity-checked by the same \`${s.reader_binding}\` ` +
      `verifier, so only the write path differs.`,
    );
    lines.push("");
    lines.push("| case | baseline verdict | rusqlite verdict | same |");
    lines.push("|" + "---|".repeat(4));
    for (const c of s.comparison) {
      lines.push(
        `| ${c.case} | ${c.baseline} | ${c.candidate} | ` +
        `${c.baseline === c.candidate ? "yes" : "**NO**"} |`,
      );
    }
    lines.push("");
    lines.push(
      s.divergences.length === 0
        ? `Agreement ${s.agreements}/${s.cases_compared}: every verdict is ` +
          "identical, so the SIGKILL and corruption results are a property of " +
          "SQLite and the OS, not of `bun:sqlite`."
        : `**Divergence on ${s.divergences.length}/${s.cases_compared} cases ` +
          `(${s.divergences.map((d) => d.case).join(", ")}). The encoding ` +
          "decision stays blocked until this is explained.**",
    );
  }
  lines.push("");
  lines.push(
    "Scope: one platform, one filesystem, the worst subset of the SIGKILL " +
    "matrix plus both corruption cases. It confirms binding-independence only " +
    "— it re-measures no latency and cannot re-decide the encoding.",
  );
  return lines;
}

// Block-layer fault injection: the cases SIGKILL structurally cannot reach.
function renderDurability(records: ResultRecord[]): string[] {
  const withDur = records.filter((r) => r.metrics.durability?.length);
  if (withDur.length === 0) return [];
  const lines = ["", "## Durability (block-layer fault injection)", ""];
  lines.push("| candidate | case | verdict | acked ops | notes |");
  lines.push("|" + "---|".repeat(5));
  for (const rec of withDur) {
    for (const c of rec.metrics.durability!) {
      const notes = c.hit_enospc === undefined
        ? ""
        : c.hit_enospc
          ? `disk filled (${c.free_before_kb}->${c.free_after_kb}KB)` +
            (c.writer_error ? "" : ", writer reported no error")
          : "**disk did NOT fill — case vacuous**";
      lines.push(`| ${rec.candidate} | ${c.case} | ${c.verdict} | ${c.acked_ops} | ${notes} |`);
    }
  }
  const control = withDur[0]!.metrics.durability_control;
  if (control) {
    const detected = control.verdict === "REGRESSION" || control.verdict === "CORRUPT";
    lines.push("");
    lines.push(
      `Harness validity: the \`nofsync-control\` negative control — a backend ` +
      `that writes in place and never calls fsync — scored **${control.verdict}** ` +
      `(acked ${control.acked_ops}). ` +
      (detected
        ? "The injection therefore does detect a missing fsync, which is what " +
          "makes a PASS above meaningful."
        : "**It survived, so the injection is NOT reaching the disk and no " +
          "durability conclusion holds.**"),
    );
  }
  lines.push("");
  lines.push(
    "Scope: writes are dropped at the block layer under a live ext4 filesystem, " +
    "which loses anything never fsynced. One filesystem, one kernel, no " +
    "barrier/FUA reordering — a lower bound on power-loss hostility, not a " +
    "worst case.",
  );
  return lines;
}

// Q5 numbers from a clean (unkilled) run of the same seeded workload: commit
// latency at the durability cadence, footprint growth, mirror amplification.
function renderCommitMetrics(records: ResultRecord[]): string[] {
  const measured = records.filter((r) => r.metrics.commit || r.metrics.commit_at_scale);
  if (measured.length === 0) return [];
  const lines = ["", "## Commit metrics", ""];
  lines.push(
    "| candidate | fixture | project | ops | commit latency p50/p95/p99 ms | bytes after | " +
    "bytes/op | overhead x | mirror flushes | mirror bytes | amplification x |",
  );
  lines.push("|" + "---|".repeat(11));
  const rows: { rec: ResultRecord; label: string; m: CommitMetrics }[] = [];
  for (const rec of measured) {
    if (rec.metrics.commit) rows.push({ rec, label: "empty", m: rec.metrics.commit });
    if (rec.metrics.commit_at_scale) {
      rows.push({ rec, label: "fixture-loaded", m: rec.metrics.commit_at_scale });
    }
  }
  for (const { rec, label, m } of rows) {
    lines.push("| " + [
      rec.candidate,
      rec.fixture,
      label,
      String(m.ops),
      `${m.commit_latency_ms.p50.toFixed(2)}/${m.commit_latency_ms.p95.toFixed(2)}/` +
      `${m.commit_latency_ms.p99.toFixed(2)}`,
      String(m.size.bytes_after),
      m.size.bytes_per_op.toFixed(0),
      m.size.overhead_ratio.toFixed(1),
      String(m.mirror.flushes),
      String(m.mirror.bytes_written),
      m.mirror.amplification.toFixed(1),
    ].join(" | ") + " |");
  }
  lines.push("");
  lines.push(
    "`project` is the state the commits are charged against: `empty` starts from " +
    "nothing, `fixture-loaded` preloads the fixture manuscript first (untimed). " +
    "Latency is wall-clock around one durable commit on an unkilled run of the " +
    "same seeded workload. `mirror bytes` is whole-artifact traffic with no " +
    "coalescing credit (worst case for a folder mirror); `amplification` is that " +
    "traffic divided by the bytes the workload actually authored.",
  );
  return lines;
}

// Spec: every CORRUPT artifact feeds the read-only salvage prototype, which must
// extract objects and report losses without modifying the source.
function renderSalvage(records: ResultRecord[]): string[] {
  const withSalvage = records.filter((r) => (r.metrics.salvage?.length ?? 0) > 0);
  if (withSalvage.length === 0) return [];
  const lines = ["", "## Salvage of CORRUPT artifacts", ""];
  lines.push(
    "| candidate | case | scenes recovered | assets recovered | losses | " +
    "sidecars | source unmodified |",
  );
  lines.push("|" + "---|".repeat(7));
  for (const rec of withSalvage) {
    for (const ev of rec.metrics.salvage!) {
      lines.push("| " + [
        ev.candidate,
        ev.case,
        String(ev.recovered_scenes),
        String(ev.recovered_assets),
        String(ev.loss_count),
        ev.sidecars.length ? ev.sidecars.join(" ") : "none",
        ev.source_unmodified ? "yes" : "no",
      ].join(" | ") + " |");
    }
  }
  lines.push("");
  lines.push(
    "Salvage runs read-only against a copy; `source unmodified` compares the " +
    "artifact hash before and after the rescue. Recovering content from an " +
    "artifact the verifier called CORRUPT is expected — detection and total " +
    "loss are different claims. `corrupt@*` rows come from the fault matrix " +
    "(header damage after a clean close); `demo@flip-*` rows sweep damage " +
    "sites across the artifact. The `sidecars` column is the deciding " +
    "variable: a surviving SQLite `-wal` is a second copy of recent pages.",
  );
  return lines;
}
