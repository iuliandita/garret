# Fault rig results

| candidate | fixture | OLD_INTACT | NEW_COMPLETE | REGRESSION | CORRUPT | total |
|---|---|---|---|---|---|---|
| dir-manifest | stress | 3 | 14 | 0 | 2 | 19 |
| sqlite | stress | 4 | 13 | 0 | 2 | 19 |

| candidate | survival intact | corruption caught | verdict |
|---|---|---|---|
| dir-manifest | 17/17 | 2/2 | PASS |
| sqlite | 17/17 | 2/2 | PASS |

Exit bar: every SIGKILL (survival) case must stay OLD_INTACT/NEW_COMPLETE, and every injected-corruption (detection) case must be caught as CORRUPT. A survival case that reports CORRUPT/REGRESSION, or a detection case that does NOT, fails the backend.

Scope: SIGKILL exercises atomicity/crash-consistency under process kill, not fsync durability against power loss (kernel + page cache survive). Treat REGRESSION counts as an atomicity signal, not a durability proof.

## Commit metrics

| candidate | fixture | project | ops | commit latency p50/p95/p99 ms | bytes after | bytes/op | overhead x | mirror flushes | mirror bytes | amplification x |
|---|---|---|---|---|---|---|---|---|---|---|
| dir-manifest | stress | empty | 40 | 0.05/0.09/0.42 | 2990 | 75 | 18.3 | 1 | 58772 | 360.6 |
| dir-manifest | stress | fixture-loaded | 40 | 55.75/58.95/81.61 | 22610159 | 565254 | 138712.6 | 1 | 903992017 | 5545963.3 |
| sqlite | stress | empty | 40 | 0.07/0.14/1.24 | 28672 | 717 | 175.9 | 1 | 4271680 | 26206.6 |
| sqlite | stress | fixture-loaded | 40 | 0.86/1.57/3.13 | 12349440 | 308736 | 75763.4 | 1 | 499047040 | 3061638.3 |

`project` is the state the commits are charged against: `empty` starts from nothing, `fixture-loaded` preloads the fixture manuscript first (untimed). Latency is wall-clock around one durable commit on an unkilled run of the same seeded workload. `mirror bytes` is whole-artifact traffic with no coalescing credit (worst case for a folder mirror); `amplification` is that traffic divided by the bytes the workload actually authored.

## Salvage of CORRUPT artifacts

| candidate | case | scenes recovered | assets recovered | losses | sidecars | source unmodified |
|---|---|---|---|---|---|---|
| dir-manifest | corrupt@torn | 0 | 0 | 1 | none | yes |
| dir-manifest | corrupt@flip | 0 | 0 | 1 | none | yes |
| dir-manifest | demo@flip-0pct | 0 | 0 | 1 | none | yes |
| dir-manifest | demo@flip-25pct | 0 | 0 | 1 | none | yes |
| dir-manifest | demo@flip-50pct | 21 | 4 | 2 | none | yes |
| dir-manifest | demo@flip-80pct | 0 | 0 | 1 | none | yes |
| dir-manifest | demo@flip-95pct | 0 | 0 | 1 | none | yes |
| sqlite | corrupt@torn | 0 | 0 | 1 | none | yes |
| sqlite | corrupt@flip | 0 | 0 | 1 | none | yes |
| sqlite | demo@flip-0pct | 0 | 0 | 1 | project.db-shm project.db-wal | yes |
| sqlite | demo@flip-25pct | 23 | 4 | 0 | project.db-shm project.db-wal | yes |
| sqlite | demo@flip-50pct | 23 | 4 | 0 | project.db-shm project.db-wal | yes |
| sqlite | demo@flip-80pct | 23 | 4 | 0 | project.db-shm project.db-wal | yes |
| sqlite | demo@flip-95pct | 23 | 4 | 0 | project.db-shm project.db-wal | yes |

Salvage runs read-only against a copy; `source unmodified` compares the artifact hash before and after the rescue. Recovering content from an artifact the verifier called CORRUPT is expected — detection and total loss are different claims. `corrupt@*` rows come from the fault matrix (header damage after a clean close); `demo@flip-*` rows sweep damage sites across the artifact. The `sidecars` column is the deciding variable: a surviving SQLite `-wal` is a second copy of recent pages.
