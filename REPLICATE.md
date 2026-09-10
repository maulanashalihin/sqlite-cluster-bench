# Replication guide (for AI agents and humans)

Reproduce the full experiment matrix on a different machine. Every claim in
`README.md` must be re-derivable from `bench/run.sh` output. Absolute numbers
will differ per hardware — **directions and ratios must hold**.

## 0. What you need

| Dep | Check | Notes |
|---|---|---|
| Bun ≥ 1.4 | `bun --version` | servers + harness |
| Go ≥ 1.22, gcc | `go version`, `gcc --version` | CGo for mattn/go-sqlite3; first build ~1 min |
| Postgres 14+ | `pg_isready` | E4–E6 only; empty DB + role. Default `PG_URL=postgres://ubuntu:bench123@localhost:5432/hookbench` — **override via env**, never commit credentials |
| curl, 6+ GB free disk | | DB + WAL files land in `/tmp` |
| Ports | `PORT_BASE` (default 4200–4211) must be free | override with `PORT_BASE=4300` |

CPU count matters for interpretation, not validity: record `nproc`, RAM,
disk type (HDD/SATA/NVMe) in your report. Original box: 6 CPU / 11.7 GB / Ubuntu.

## 1. Quick smoke test (~2 min)

```bash
ITERS=1 REQS=1000 CONC=10 EXP=e1 PORT_BASE=4300 ./bench/run.sh
```

Expected: `pg ok` NOT required for E1 (PG check is lazy); two servers boot;
8 JSON lines into `data/rep-e1-*.log` (2 read + 2 write × 1 iter);
all `fail=0`. Then processes are killed automatically (`trap ... EXIT`).

## 2. Full run (~10–15 min)

```bash
./bench/run.sh
# or subset: EXP="e1 e4" ITERS=5 ./bench/run.sh
```

What it does per experiment: fresh seed (SQLite 20k rows / PG 20k rows),
boot server(s), `wait_up` on `/health`, interleave A/B runs per round
(order effects cancel), kill all. Logs: `data/rep-<exp>-<read|write|mix>.log`
(JSON-lines, same schema as `data/*.log`).

| Exp | Servers | Workload | Question |
|---|---|---|---|
| E1 | Fiber+mattn vs Bun 6-worker, 1 shared file | pure read + pure write | does Bun cluster show the same WAL tail? |
| E2/E3 | Bun single vs 6-worker-1-file vs 6-worker-6-file | pure | single-writer vs contention vs sharding |
| E4 | Bun PG single vs 6-worker, shared table | pure | does PG collapse too? (+c150 probe manually) |
| E5 | Bun-SQLite-1, Bun-PG-1, Bun-PG-6, Fiber-PG | mixed 95/5 | DB × stack under realistic load |
| E6 | Bun-PG with 1/2/4/6 workers (each reseeds) | mixed 95/5 | worker scaling curve |

c150 crossover probe (manual, after E4 while servers live — or re-run E4 section):
```bash
bun bench/bench.js http://127.0.0.1:$P5/read 15000 150 read
```

## 3. What must reproduce (invariants, not absolutes)

1. E1 write: cluster p50 < single p50 BUT cluster p99 > single p99, ranges across
   rounds do not overlap. (Original: p99 19.8 vs 35.6, 5/5 rounds.)
2. E2 write: single beats cluster-1-file on rps AND p99 by ≥2x.
3. E3 write: shard-6-file rps ≥ 1.5x single, p99 within ~1.5x of single.
4. E4: PG single-vs-cluster gap ≤1.5x on every percentile (no collapse).
5. E5: SQLite-single rps ≥ best PG; E6: throughput peaks at 1–3 workers then
   flattens/degrades (exact peak depends on core count).
6. `fail=0` everywhere (busy_timeout absorbs SQLITE_BUSY; any fail>0 = infra issue).

If invariant 1 flips on NVMe-very-fast storage, that is a finding, not a failure:
report disk type + `results/summary.json` recomputed via your own aggregation.

## 4. Pitfalls we already hit (do not rediscover)

- **One writer per SQLite file.** Never point two server processes at one `.db`
  except the experiment that explicitly tests it (E1/E2-cluster).
- **Detached launches**: use `setsid nohup ... &` + `/health` polling. A bare
  `cmd &` dies with the agent's background-job timeout (we lost a 6-worker
  cluster this way and briefly measured a dead port as "fail=15000").
- **Each bash tool call may start in a different cwd** — always use absolute paths.
- **Bun.SQL array params**: `unnest(${jsArray}::text[])` throws 22P02; seed PG with
  concurrent single-row inserts instead (see `seed_pg` in `run.sh`).
- **Cluster primary reseeds on boot** (`DROP+CREATE`): start order matters when two
  servers share one PG table — boot the seeder last, or seed explicitly first.
- **Port conflicts**: default range 4200–4211; set `PORT_BASE` if busy.
- WAL data lives mostly in `-wal` until checkpoint — small `.db` right after
  seeding is normal; verify with `SELECT COUNT(*)`, not `ls`.

## 5. Reporting back

1. Recompute `results/summary.json` (script in `docs/`, or inline the one-liner
   from git history) including `nproc`, disk, PG version.
2. Note every invariant 1–6 as hold/violated with numbers.
3. Open a PR/issue with the summary table — do not overwrite `data/` in `master`.
