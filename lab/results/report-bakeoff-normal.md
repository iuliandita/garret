# Bake-off results (Track 2)

| candidate | fixture | gate | value | threshold | verdict |
|---|---|---|---|---|---|
| tauri | normal | typing_p95 | 34 | < 50 ms | PASS |
| tauri | normal | typing_p99 | 34.00000000000182 | < 100 ms | PASS |
| tauri | normal | nav_p95 | 34 | < 150 ms | PASS |
| tauri | normal | cold_start | 29 | < 3000 ms | PASS |
| tauri | normal | warm_start | 3 | < 1500 ms | PASS |
| tauri | normal | peak_rss_mb | 564 | < 750 MB | PASS |
| tauri | normal | a11y_exposure | editor=true nav=true dialog=true | editor+navigator+dialog exposed | PASS |
| electron | normal | typing_p95 | 33.599999994039536 | < 50 ms | PASS |
| electron | normal | typing_p99 | 33.900000005960464 | < 100 ms | PASS |
| electron | normal | nav_p95 | 33.60000002384186 | < 150 ms | PASS |
| electron | normal | cold_start | 30.899999976158142 | < 3000 ms | PASS |
| electron | normal | warm_start | 1.600000023841858 | < 1500 ms | PASS |
| electron | normal | peak_rss_mb | 931 | < 750 MB | FAIL |
| electron | normal | a11y_exposure | editor=true nav=true dialog=true | editor+navigator+dialog exposed | PASS |

| candidate | fails | unknowns | advisory | outcome |
|---|---|---|---|---|
| tauri | 0 | 0 | 0 | SURVIVES |
| electron | 1 | 0 | 0 | ELIMINATED |

Exit bar: a stack failing any gate irrecoverably on a tested OS is out. UNKNOWN gates (probe unavailable, e.g. AT-SPI/pyatspi absent) do not eliminate but block promotion until measured. ADVISORY gates are recorded and argued with, never decisive. If both survive, the tie breaks on variance, memory headroom, and accessibility quality. macOS remains an unmeasured gap: no gate promotes to contract without it.
