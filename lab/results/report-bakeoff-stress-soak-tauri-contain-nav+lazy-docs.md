# Bake-off results (Track 2)

| candidate | fixture | gate | value | threshold | verdict |
|---|---|---|---|---|---|
| tauri | stress | typing_p95 | 717 | < 50 ms | FAIL |
| tauri | stress | typing_p99 | 784 | < 100 ms | FAIL |
| tauri | stress | nav_p95 | 708 | < 150 ms | FAIL |
| tauri | stress | cold_start | 34 | < 3000 ms | PASS |
| tauri | stress | warm_start | 3 | < 1500 ms | PASS |
| tauri | stress | peak_rss_mb | 657 | < 750 MB | PASS |
| tauri | stress | a11y_exposure | editor=true nav=true dialog=true | editor+navigator+dialog exposed | PASS |
| tauri | stress | soak_peak_rss_mb | 657 | < 750 MB | PASS |
| tauri | stress | soak_projected_8h_rss_mb | 855 | < 750 MB | ADVISORY |
| tauri | stress | soak_typing_p95_last_cycle | 1001 | < 50 ms | FAIL |

| candidate | fails | unknowns | advisory | outcome |
|---|---|---|---|---|
| tauri | 4 | 0 | 1 | ELIMINATED |

## Soak (sustained session)

| candidate | minutes | cycles | chars typed | peak RSS MB | final RSS MB | leak slope MB/h | projected 8h RSS MB | typing p95 first -> last ms |
|---|---|---|---|---|---|---|---|---|
| tauri | 30 | 5 | 2017 | 657 | 638 | 27.1 | 855 | 1000.0 -> 1001.0 |

The soak replays the same seeded script continuously and never undoes the typed text, so the document grows the way a real session grows: `chars typed` is reported beside the slope precisely because RSS growth is not automatically a leak. `leak slope` is a least-squares fit over the sampled RSS series with the first 20% dropped as startup allocation. The projection carries that slope forward over a 8-hour session and compares it against the spec's existing 750 MB limit — the session length is the assumption, the memory threshold is not new. A soak shorter than 10 minutes reports no slope at all: a fit over a still-settling process is noise, not a trend. The projection is ADVISORY and does not eliminate: at 30 minutes the slope is not stable enough to multiply by eight (two baseline soaks of the same variant configuration fitted 64.2 and 22.3 MB/h). Memory eliminations rest on measured peak RSS, not on the projection.

Exit bar: a stack failing any gate irrecoverably on a tested OS is out. UNKNOWN gates (probe unavailable, e.g. AT-SPI/pyatspi absent) do not eliminate but block promotion until measured. ADVISORY gates are recorded and argued with, never decisive. If both survive, the tie breaks on variance, memory headroom, and accessibility quality. macOS remains an unmeasured gap: no gate promotes to contract without it.
