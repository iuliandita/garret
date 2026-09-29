// lab/fault-rig/test/report.test.ts
import { describe, expect, test } from "bun:test";
import { renderReport } from "../src/report";
import { buildResult } from "../src/results";

describe("renderReport", () => {
  test("renders a verdict table with counts per verdict", () => {
    const rec = buildResult({
      runId: "r", backendId: "sqlite", fixture: "normal",
      verdicts: [
        { case: "kill@rename#1", verdict: "NEW_COMPLETE" },
        { case: "kill@fsync#1", verdict: "OLD_INTACT" },
        { case: "kill@delay#1", verdict: "NEW_COMPLETE" },
      ],
      metrics: {}, seed: "s", rigCommit: "abc",
      environment: { kernel: "k", cpu: "c", throttleScope: "s", biasNotes: "b" },
    });
    const md = renderReport([rec]);
    expect(md).toContain("# Fault rig results");
    expect(md).toContain("sqlite");
    expect(md).toContain("NEW_COMPLETE");
    expect(md).toContain("2");            // NEW_COMPLETE count
    expect(md).toContain("CORRUPT");      // column present even at zero
  });

  test("survival + detection assessment: caught corruption is PASS, not FAIL", () => {
    const rec = buildResult({
      runId: "r2", backendId: "dir-manifest", fixture: "tiny",
      verdicts: [
        { case: "kill@rename#1", verdict: "NEW_COMPLETE" },
        { case: "kill@delay-0", verdict: "OLD_INTACT" },
        { case: "corrupt@torn", verdict: "CORRUPT" }, // injected, correctly caught
        { case: "corrupt@flip", verdict: "CORRUPT" }, // injected, correctly caught
      ],
      metrics: {}, seed: "s", rigCommit: "abc",
      environment: { kernel: "k", cpu: "c", throttleScope: "s", biasNotes: "b" },
    });
    const md = renderReport([rec]);
    // 2 survival cases intact, 2 corruption cases caught => PASS despite CORRUPT>0
    expect(md).toContain("2/2");
    expect(md).toContain("PASS");
    expect(md).not.toContain("FAIL");
  });

  test("silent corruption (detection case not caught) is a FAIL", () => {
    const rec = buildResult({
      runId: "r3", backendId: "sqlite", fixture: "tiny",
      verdicts: [
        { case: "kill@rename#1", verdict: "NEW_COMPLETE" },
        { case: "corrupt@flip", verdict: "NEW_COMPLETE" }, // corruption slipped through!
      ],
      metrics: {}, seed: "s", rigCommit: "abc",
      environment: { kernel: "k", cpu: "c", throttleScope: "s", biasNotes: "b" },
    });
    const md = renderReport([rec]);
    expect(md).toContain("FAIL");
  });

  test("swaps the SIGKILL scope note for the durability one, with the control", () => {
    const control = {
      case: "power-loss@drop-writes", verdict: "REGRESSION" as const,
      acked_ops: 20, detail: "lost acked ops",
    };
    const rec = buildResult({
      runId: "d1", backendId: "sqlite", fixture: "normal",
      verdicts: [
        { case: "power-loss@drop-writes", verdict: "NEW_COMPLETE" },
        { case: "disk-full@enospc", verdict: "OLD_INTACT" },
      ],
      metrics: {
        durability: [
          { case: "power-loss@drop-writes", verdict: "NEW_COMPLETE", acked_ops: 20, detail: "ok" },
          {
            case: "disk-full@enospc", verdict: "OLD_INTACT" as const, acked_ops: 7,
            detail: "ok", hit_enospc: true,
            free_before_kb: 4171, free_after_kb: 12, writer_error: "ENOSPC",
          },
        ],
        durability_control: control,
      },
      seed: "s", rigCommit: "abc", method: "dm-flakey drop_writes",
      environment: { kernel: "k", cpu: "c", throttleScope: "s", biasNotes: "b" },
    });
    const md = renderReport([rec]);
    expect(md).toContain("Durability");
    // The SIGKILL disclaimer would understate what this run actually tested.
    expect(md).not.toContain("not fsync durability against power loss");
    expect(md).toContain("negative control");
    expect(md).toContain("REGRESSION");
    expect(md).toContain("disk filled (4171->12KB)");
  });

  test("renders commit latency, size and mirror numbers when measured", () => {
    const rec = buildResult({
      runId: "r4", backendId: "sqlite", fixture: "tiny",
      verdicts: [{ case: "kill@rename#1", verdict: "NEW_COMPLETE" }],
      metrics: {
        commit: {
          ops: 40,
          preloaded_bytes: 0,   // empty project: this fixture predates preload
          commit_latency_ms: { p50: 1.5, p95: 4.25, p99: 9, mean: 2, max: 9, samples: 40 },
          size: {
            bytes_after: 65536, bytes_per_op: 1638.4,
            logical_bytes: 128, overhead_ratio: 512,
          },
          mirror: {
            window_ms: 1000, flushes: 3, bytes_written: 262144,
            coalesced_bytes_estimate: 196608, amplification: 2048,
          },
        },
      },
      seed: "s", rigCommit: "abc",
      environment: { kernel: "k", cpu: "c", throttleScope: "s", biasNotes: "b" },
    });
    const md = renderReport([rec]);
    expect(md).toContain("commit latency");
    expect(md).toContain("1.50");     // p50 ms
    expect(md).toContain("4.25");     // p95 ms
    expect(md).toContain("65536");    // durable footprint
    expect(md).toContain("mirror");
  });

  test("renders the salvage table with recovery and read-only proof", () => {
    const rec = buildResult({
      runId: "r5", backendId: "sqlite", fixture: "tiny",
      verdicts: [{ case: "corrupt@flip", verdict: "CORRUPT" }],
      metrics: {
        salvage: [{
          case: "corrupt@flip", candidate: "sqlite",
          recovered_scenes: 5, recovered_assets: 2,
          loss_count: 1, losses: ["integrity_check: bad page"],
          source_unmodified: true, sidecars: ["project.db-wal"],
        }],
      },
      seed: "s", rigCommit: "abc",
      environment: { kernel: "k", cpu: "c", throttleScope: "s", biasNotes: "b" },
    });
    const md = renderReport([rec]);
    expect(md).toContain("Salvage");
    expect(md).toContain("corrupt@flip");
    expect(md).toContain("source unmodified");
    expect(md).toContain("yes");
  });

  test("flags a salvage run that modified the source artifact", () => {
    const rec = buildResult({
      runId: "r6", backendId: "dir-manifest", fixture: "tiny",
      verdicts: [{ case: "corrupt@torn", verdict: "CORRUPT" }],
      metrics: {
        salvage: [{
          case: "corrupt@torn", candidate: "dir-manifest",
          recovered_scenes: 0, recovered_assets: 0,
          loss_count: 1, losses: ["manifest unparseable"],
          source_unmodified: false, sidecars: [],
        }],
      },
      seed: "s", rigCommit: "abc",
      environment: { kernel: "k", cpu: "c", throttleScope: "s", biasNotes: "b" },
    });
    const md = renderReport([rec]);
    expect(md).toContain("| no |");
  });
});
