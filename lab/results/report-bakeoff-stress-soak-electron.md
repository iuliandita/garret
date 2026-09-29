# Bake-off results (Track 2)

| candidate | fixture | gate | value | threshold | verdict |
|---|---|---|---|---|---|
| electron | stress | typing_p95 | 33.5 | < 50 ms | PASS |
| electron | stress | typing_p99 | 33.69999998807907 | < 100 ms | PASS |
| electron | stress | nav_p95 | 33.599999994039536 | < 150 ms | PASS |
| electron | stress | cold_start | 178.59999999403954 | < 3000 ms | PASS |
| electron | stress | warm_start | 1.9000000059604645 | < 1500 ms | PASS |
| electron | stress | peak_rss_mb | 1265 | < 750 MB | FAIL |
| electron | stress | a11y_exposure | probe-unavailable | editor+navigator+dialog exposed | UNKNOWN |
| electron | stress | soak_peak_rss_mb | 1265 | < 750 MB | FAIL |
| electron | stress | soak_projected_8h_rss_mb | 2098 | < 750 MB | ADVISORY |
| electron | stress | soak_typing_p95_last_cycle | 34.400000005960464 | < 50 ms | PASS |

| candidate | fails | unknowns | advisory | outcome |
|---|---|---|---|---|
| electron | 2 | 1 | 1 | ELIMINATED |

## Soak (sustained session)

| candidate | minutes | cycles | chars typed | peak RSS MB | final RSS MB | leak slope MB/h | projected 8h RSS MB | typing p95 first -> last ms |
|---|---|---|---|---|---|---|---|---|
| electron | 30 | 108 | 43475 | 1265 | 1220 | 109.7 | 2098 | 34.4 -> 34.4 |

The soak replays the same seeded script continuously and never undoes the typed text, so the document grows the way a real session grows: `chars typed` is reported beside the slope precisely because RSS growth is not automatically a leak. `leak slope` is a least-squares fit over the sampled RSS series with the first 20% dropped as startup allocation. The projection carries that slope forward over a 8-hour session and compares it against the spec's existing 750 MB limit — the session length is the assumption, the memory threshold is not new. A soak shorter than 10 minutes reports no slope at all: a fit over a still-settling process is noise, not a trend. The projection is ADVISORY and does not eliminate: at 30 minutes the slope is not stable enough to multiply by eight (two baseline soaks of the same variant configuration fitted 64.2 and 22.3 MB/h). Memory eliminations rest on measured peak RSS, not on the projection.

Exit bar: a stack failing any gate irrecoverably on a tested OS is out. UNKNOWN gates (probe unavailable, e.g. AT-SPI/pyatspi absent) do not eliminate but block promotion until measured. ADVISORY gates are recorded and argued with, never decisive. If both survive, the tie breaks on variance, memory headroom, and accessibility quality. macOS remains an unmeasured gap: no gate promotes to contract without it.
