# Bake-off results (Track 2)

| candidate | fixture | gate | value | threshold | verdict |
|---|---|---|---|---|---|
| tauri | stress | typing_p95 | 34.000000000000455 | < 50 ms | PASS |
| tauri | stress | typing_p99 | 34.00000000000182 | < 100 ms | PASS |
| tauri | stress | nav_p95 | 34.00000000000091 | < 150 ms | PASS |
| tauri | stress | cold_start | 194 | < 3000 ms | PASS |
| tauri | stress | warm_start | 2 | < 1500 ms | PASS |
| tauri | stress | peak_rss_mb | 686 | < 750 MB | PASS |
| tauri | stress | a11y_exposure | editor=true nav=true dialog=true | editor+navigator+dialog exposed | PASS |
| electron | stress | typing_p95 | 33.5 | < 50 ms | PASS |
| electron | stress | typing_p99 | 33.69999998807907 | < 100 ms | PASS |
| electron | stress | nav_p95 | 33.69999998807907 | < 150 ms | PASS |
| electron | stress | cold_start | 172.80000001192093 | < 3000 ms | PASS |
| electron | stress | warm_start | 1.5 | < 1500 ms | PASS |
| electron | stress | peak_rss_mb | 1107 | < 750 MB | FAIL |
| electron | stress | a11y_exposure | probe-unavailable | editor+navigator+dialog exposed | UNKNOWN |

| candidate | fails | unknowns | advisory | outcome |
|---|---|---|---|---|
| tauri | 0 | 0 | 0 | SURVIVES |
| electron | 1 | 1 | 0 | ELIMINATED |

Exit bar: a stack failing any gate irrecoverably on a tested OS is out. UNKNOWN gates (probe unavailable, e.g. AT-SPI/pyatspi absent) do not eliminate but block promotion until measured. ADVISORY gates are recorded and argued with, never decisive. If both survive, the tie breaks on variance, memory headroom, and accessibility quality. macOS remains an unmeasured gap: no gate promotes to contract without it.
