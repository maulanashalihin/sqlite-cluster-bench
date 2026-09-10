#!/usr/bin/env bash
# Replication runner for sqlite-cluster-bench.
# Runs experiment matrix E1-E6, drops JSON-lines logs into data/rep-*.log.
# Knobs (env): ITERS (default 3), REQS (default 20000), CONC (default 50),
#   EXP subset (e.g. EXP=e1 or EXP="e1 e4"), PG_URL, PORT_BASE (default 4200).
# Smoke test: ITERS=1 REQS=1000 CONC=10 EXP=e1 ./bench/run.sh
# Full run: ./bench/run.sh   (~10-15 min, needs gcc + postgres)
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERV="$ROOT/servers"; BENCH="$ROOT/bench"; DATA="$ROOT/data"
ITERS="${ITERS:-3}"; REQS="${REQS:-20000}"; CONC="${CONC:-50}"
EXP="${EXP:-e1 e2 e3 e4 e5 e6}"
PG_URL="${PG_URL:-postgres://ubuntu:bench123@localhost:5432/hookbench?sslmode=disable}"
export PG_URL
P0="${PORT_BASE:-4200}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "MISSING: $1"; exit 1; }; }
need bun; need go; need gcc; need curl
[ -x "$SERV/fiber-server" ] || (cd "$SERV" && go mod tidy >/dev/null 2>&1 && go build -o fiber-server fiber.go && go build -o fiber-pg-server fiber-pg.go)
case " $EXP " in *" e4 "*|*" e5 "*|*" e6 "*)
bun -e 'import {SQL} from "bun"; const s=new SQL(process.env.PG_URL,{max:2}); await s`select 1`; await s.close(); console.log("pg ok")' \
  || { echo "PG unreachable at $PG_URL — override with PG_URL env"; exit 1; } ;;
esac

seed_sqlite() {
  rm -f "$1" "$1-wal" "$1-shm"
  bun -e "
import {Database} from 'bun:sqlite';
const db = new Database('$1');
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA cache_size=-64000;');
db.exec('DROP TABLE IF EXISTS kv; CREATE TABLE kv (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)');
const vs='v'.repeat(100);
db.transaction(n=>{const ins=db.prepare('INSERT INTO kv(val) VALUES(?)'); for(let i=0;i<n;i++) ins.run(vs);})(20000);
db.close(); console.log('sqlite seeded $1');"
}
seed_pg() {
  bun -e "
import {SQL} from 'bun';
const sql = new SQL(process.env.PG_URL, {max: 10});
const VS='v'.repeat(100);
await sql\x60DROP TABLE IF EXISTS pgkv\x60;
await sql\x60CREATE TABLE pgkv (id SERIAL PRIMARY KEY, val TEXT)\x60;
await Promise.all(Array.from({length:10}, async()=>{ for(let i=0;i<2000;i++) await sql\x60INSERT INTO pgkv (val) VALUES(\x24{VS})\x60; }));
await sql.close(); console.log('pg seeded');"
}
wait_up() {
  for _ in $(seq 1 30); do curl -sf -m 2 "http://127.0.0.1:$1/health" >/dev/null 2>&1 && return 0; sleep 1; done
  echo "server on $1 never came up"; return 1
}
stop_all() { pkill -f "servers/pg-server|servers/bun-server|servers/bun-shard|fiber-server|fiber-pg-server" 2>/dev/null; sleep 1; }
run_bench() { bun "$BENCH/bench.js" "$1" "$2" "$3" "$4" 2>/dev/null; }
run_mix() { bun "$BENCH/mix.js" "$1" "$2" "$3" 5 2>/dev/null; }
has() { case " $EXP " in *" $1 "*) return 0;; *) return 1;; esac; }

trap stop_all EXIT
rm -f "$DATA"/rep-*.log

if has e1; then echo "== E1 fiber+mattn vs bun-cluster, shared file =="
  rm -f /tmp/rep-fiber.db* /tmp/rep-bun.db*
  (cd "$SERV" && setsid nohup ./fiber-server $P0 /tmp/rep-fiber.db >"$DATA/.fiber.log" 2>&1 < /dev/null &)
  setsid nohup env PORT=$((P0+1)) WORKERS=6 DB_PATH=/tmp/rep-bun.db bun "$SERV/bun-server.js" >"$DATA/.bun6.log" 2>&1 < /dev/null &
  sleep 6; wait_up $P0 && wait_up $((P0+1))
  for _ in $(seq "$ITERS"); do
    run_bench http://127.0.0.1:$P0/read "$REQS" "$CONC" read | tee -a "$DATA/rep-e1-read.log" | grep '^{'
    run_bench http://127.0.0.1:$((P0+1))/read "$REQS" "$CONC" read | tee -a "$DATA/rep-e1-read.log" | grep '^{'
    run_bench http://127.0.0.1:$P0/write "$REQS" "$CONC" write | tee -a "$DATA/rep-e1-write.log" | grep '^{'
    run_bench http://127.0.0.1:$((P0+1))/write "$REQS" "$CONC" write | tee -a "$DATA/rep-e1-write.log" | grep '^{'
  done; stop_all
fi

if has e2 || has e3; then echo "== E2/E3 single vs cluster-1-file vs shard-6-file =="
  seed_sqlite /tmp/rep-single.db
  setsid nohup env IS_WORKER=1 PORT=$((P0+2)) DB_PATH=/tmp/rep-single.db bun "$SERV/bun-server.js" >"$DATA/.single.log" 2>&1 < /dev/null &
  setsid nohup env PORT=$((P0+3)) WORKERS=6 DB_PATH=/tmp/rep-c6.db bun "$SERV/bun-server.js" >"$DATA/.c6.log" 2>&1 < /dev/null &
  setsid nohup env PORT=$((P0+4)) WORKERS=6 DB_BASE=/tmp/rep-shard bun "$SERV/bun-shard.js" >"$DATA/.shard.log" 2>&1 < /dev/null &
  sleep 8; wait_up $((P0+2)) && wait_up $((P0+3)) && wait_up $((P0+4))
  for _ in $(seq "$ITERS"); do
    for p in $((P0+2)) $((P0+3)) $((P0+4)); do
      run_bench http://127.0.0.1:$p/read "$REQS" "$CONC" read | tee -a "$DATA/rep-e23-read.log" | grep '^{'
    done
    for p in $((P0+2)) $((P0+3)) $((P0+4)); do
      run_bench http://127.0.0.1:$p/write "$REQS" "$CONC" write | tee -a "$DATA/rep-e23-write.log" | grep '^{'
    done
  done; stop_all
fi

if has e4; then echo "== E4 PG single vs cluster, shared table =="
  seed_pg
  setsid nohup env IS_WORKER=1 PORT=$((P0+5)) bun "$SERV/pg-server.js" >"$DATA/.pgs.log" 2>&1 < /dev/null &
  setsid nohup env PORT=$((P0+6)) WORKERS=6 bun "$SERV/pg-server.js" >"$DATA/.pgc.log" 2>&1 < /dev/null &
  sleep 8; wait_up $((P0+5)) && wait_up $((P0+6))
  for _ in $(seq "$ITERS"); do
    run_bench http://127.0.0.1:$((P0+5))/read "$REQS" "$CONC" read | tee -a "$DATA/rep-e4-read.log" | grep '^{'
    run_bench http://127.0.0.1:$((P0+6))/read "$REQS" "$CONC" read | tee -a "$DATA/rep-e4-read.log" | grep '^{'
    run_bench http://127.0.0.1:$((P0+5))/write "$REQS" "$CONC" write | tee -a "$DATA/rep-e4-write.log" | grep '^{'
    run_bench http://127.0.0.1:$((P0+6))/write "$REQS" "$CONC" write | tee -a "$DATA/rep-e4-write.log" | grep '^{'
  done; stop_all
fi

if has e5; then echo "== E5 mixed 95/5: sqlite-single vs bun-pg-1 vs bun-pg-6 vs fiber-pg =="
  seed_sqlite /tmp/rep-mix.db; seed_pg
  setsid nohup env IS_WORKER=1 PORT=$((P0+7)) DB_PATH=/tmp/rep-mix.db bun "$SERV/bun-server.js" >"$DATA/.m1.log" 2>&1 < /dev/null &
  setsid nohup env IS_WORKER=1 PORT=$((P0+8)) bun "$SERV/pg-server.js" >"$DATA/.m2.log" 2>&1 < /dev/null &
  setsid nohup env PORT=$((P0+9)) WORKERS=6 bun "$SERV/pg-server.js" >"$DATA/.m3.log" 2>&1 < /dev/null &
  (cd "$SERV" && setsid nohup ./fiber-pg-server $((P0+10)) >"$DATA/.m4.log" 2>&1 < /dev/null &)
  sleep 8
  wait_up $((P0+7)) && wait_up $((P0+8)) && wait_up $((P0+9)) && wait_up $((P0+10))
  for _ in $(seq "$ITERS"); do
    for p in $((P0+7)) $((P0+8)) $((P0+9)) $((P0+10)); do
      run_mix http://127.0.0.1:$p "$REQS" "$CONC" | tee -a "$DATA/rep-e5-mix.log" | grep '^{'
    done
  done; stop_all
fi

if has e6; then echo "== E6 worker sweep 1/2/4/6 (bun+PG, mixed 95/5) =="
  for N in 1 2 4 6; do
    stop_all
    setsid nohup env PORT=$((P0+11)) WORKERS=$N bun "$SERV/pg-server.js" >"$DATA/.sweep.log" 2>&1 < /dev/null &
    sleep 8; wait_up $((P0+11))
    echo "--- workers=$N ---" | tee -a "$DATA/rep-e6-sweep.log"
    run_mix http://127.0.0.1:$((P0+11)) 15000 "$CONC" | tee -a "$DATA/rep-e6-sweep.log" | grep '^{'
  done; stop_all
fi

echo "done. logs: $DATA/rep-*.log"
