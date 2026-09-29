# Bake-off results (Track 2)

| candidate | fixture | gate | value | threshold | verdict |
|---|---|---|---|---|---|
| tauri | normal | typing_p95 | 34 | < 50 ms | PASS |
| tauri | normal | typing_p99 | 34.00000000000182 | < 100 ms | PASS |
| tauri | normal | nav_p95 | 34.000000000000455 | < 150 ms | PASS |
| tauri | normal | cold_start | 40 | < 3000 ms | PASS |
| tauri | normal | warm_start | 3 | < 1500 ms | PASS |
| tauri | normal | peak_rss_mb | 590 | < 750 MB | PASS |
| tauri | normal | a11y_exposure | editor=true nav=true dialog=true | editor+navigator+dialog exposed | PASS |
| tauri | normal | soak_peak_rss_mb | 590 | < 750 MB | PASS |
| tauri | normal | soak_projected_8h_rss_mb | 607 | < 750 MB | ADVISORY |
| tauri | normal | soak_typing_p95_last_cycle | 34.00000000023283 | < 50 ms | PASS |

| candidate | fails | unknowns | advisory | outcome |
|---|---|---|---|---|
| tauri | 0 | 0 | 1 | SURVIVES |

## Soak (sustained session)

| candidate | minutes | cycles | chars typed | peak RSS MB | final RSS MB | leak slope MB/h | projected 8h RSS MB | typing p95 first -> last ms |
|---|---|---|---|---|---|---|---|---|
| tauri | 30 | 96 | 38800 | 590 | 572 | 4.4 | 607 | 34.0 -> 34.0 |

The soak replays the same seeded script continuously and never undoes the typed text, so the document grows the way a real session grows: `chars typed` is reported beside the slope precisely because RSS growth is not automatically a leak. `leak slope` is a least-squares fit over the sampled RSS series with the first 20% dropped as startup allocation. The projection carries that slope forward over a 8-hour session and compares it against the spec's existing 750 MB limit — the session length is the assumption, the memory threshold is not new. A soak shorter than 10 minutes reports no slope at all: a fit over a still-settling process is noise, not a trend. The projection is ADVISORY and does not eliminate: at 30 minutes the slope is not stable enough to multiply by eight (two baseline soaks of the same variant configuration fitted 64.2 and 22.3 MB/h). Memory eliminations rest on measured peak RSS, not on the projection.

Exit bar: a stack failing any gate irrecoverably on a tested OS is out. UNKNOWN gates (probe unavailable, e.g. AT-SPI/pyatspi absent) do not eliminate but block promotion until measured. ADVISORY gates are recorded and argued with, never decisive. If both survive, the tie breaks on variance, memory headroom, and accessibility quality. macOS remains an unmeasured gap: no gate promotes to contract without it.
