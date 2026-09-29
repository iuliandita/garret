# Fault rig results

| candidate | fixture | OLD_INTACT | NEW_COMPLETE | REGRESSION | CORRUPT | total |
|---|---|---|---|---|---|---|
| dir-manifest | normal | 0 | 2 | 0 | 0 | 2 |
| sqlite | normal | 0 | 2 | 0 | 0 | 2 |

| candidate | survival intact | corruption caught | verdict |
|---|---|---|---|
| dir-manifest | 2/2 | 0/0 | PASS |
| sqlite | 2/2 | 0/0 | PASS |

Exit bar: every SIGKILL (survival) case must stay OLD_INTACT/NEW_COMPLETE, and every injected-corruption (detection) case must be caught as CORRUPT. A survival case that reports CORRUPT/REGRESSION, or a detection case that does NOT, fails the backend.


## Durability (block-layer fault injection)

| candidate | case | verdict | acked ops | notes |
|---|---|---|---|---|
| dir-manifest | power-loss@drop-writes | NEW_COMPLETE | 20 |  |
| dir-manifest | disk-full@enospc | NEW_COMPLETE | 6 | disk filled (4171->73KB) |
| sqlite | power-loss@drop-writes | NEW_COMPLETE | 20 |  |
| sqlite | disk-full@enospc | NEW_COMPLETE | 25 | disk filled (5073->2KB) |

Harness validity: the `nofsync-control` negative control — a backend that writes in place and never calls fsync — scored **REGRESSION** (acked 20). The injection therefore does detect a missing fsync, which is what makes a PASS above meaningful.

Scope: writes are dropped at the block layer under a live ext4 filesystem, which loses anything never fsynced. One filesystem, one kernel, no barrier/FUA reordering — a lower bound on power-loss hostility, not a worst case.
