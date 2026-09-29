# Fault rig results

| candidate | fixture | OLD_INTACT | NEW_COMPLETE | REGRESSION | CORRUPT | total |
|---|---|---|---|---|---|---|
| sqlite-rs | normal | 0 | 9 | 0 | 2 | 11 |

| candidate | survival intact | corruption caught | verdict |
|---|---|---|---|
| sqlite-rs | 9/9 | 2/2 | PASS |

Exit bar: every SIGKILL (survival) case must stay OLD_INTACT/NEW_COMPLETE, and every injected-corruption (detection) case must be caught as CORRUPT. A survival case that reports CORRUPT/REGRESSION, or a detection case that does NOT, fails the backend.

Scope: SIGKILL exercises atomicity/crash-consistency under process kill, not fsync durability against power loss (kernel + page cache survive). Treat REGRESSION counts as an atomicity signal, not a durability proof.

## Binding spot-check (rusqlite vs bun:sqlite)

`sqlite-rs` writes through `rusqlite 0.40 (system libsqlite3)` (SQLite 3.53.3); baseline `sqlite-normal` (rig commit `fe4b0f0`) writes through `bun:sqlite` (SQLite 3.53.0). Both are read back and integrity-checked by the same `bun:sqlite` verifier, so only the write path differs.

| case | baseline verdict | rusqlite verdict | same |
|---|---|---|---|
| kill@fsync#1 | NEW_COMPLETE | NEW_COMPLETE | yes |
| kill@fsync#2 | NEW_COMPLETE | NEW_COMPLETE | yes |
| kill@fsync#3 | NEW_COMPLETE | NEW_COMPLETE | yes |
| kill@rename#1 | NEW_COMPLETE | NEW_COMPLETE | yes |
| kill@rename#2 | NEW_COMPLETE | NEW_COMPLETE | yes |
| kill@rename#3 | NEW_COMPLETE | NEW_COMPLETE | yes |
| kill@commit-done#1 | NEW_COMPLETE | NEW_COMPLETE | yes |
| mutator+kill@fsync#1 | NEW_COMPLETE | NEW_COMPLETE | yes |
| mutator+kill@rename#1 | NEW_COMPLETE | NEW_COMPLETE | yes |
| corrupt@torn | CORRUPT | CORRUPT | yes |
| corrupt@flip | CORRUPT | CORRUPT | yes |

Agreement 11/11: every verdict is identical, so the SIGKILL and corruption results are a property of SQLite and the OS, not of `bun:sqlite`.

Scope: one platform, one filesystem, the worst subset of the SIGKILL matrix plus both corruption cases. It confirms binding-independence only — it re-measures no latency and cannot re-decide the encoding.

## Salvage of CORRUPT artifacts

| candidate | case | scenes recovered | assets recovered | losses | sidecars | source unmodified |
|---|---|---|---|---|---|---|
| sqlite-rs | corrupt@torn | 0 | 0 | 1 | none | yes |
| sqlite-rs | corrupt@flip | 0 | 0 | 1 | none | yes |

Salvage runs read-only against a copy; `source unmodified` compares the artifact hash before and after the rescue. Recovering content from an artifact the verifier called CORRUPT is expected — detection and total loss are different claims. `corrupt@*` rows come from the fault matrix (header damage after a clean close); `demo@flip-*` rows sweep damage sites across the artifact. The `sidecars` column is the deciding variable: a surviving SQLite `-wal` is a second copy of recent pages.
