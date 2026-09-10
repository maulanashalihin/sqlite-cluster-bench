#!/usr/bin/env bun
// E12: YCSB-A style — 50% reads, 50% read-modify-write (counter +1) over
// Zipfian keys. Tracks per-row RMW attempts to quantify lost updates:
// expected[row] = attempts, final[row] read back at end.
const PORTS = (process.argv[2] || "4401,4402,4403").split(",").map(Number);
const TOTAL = parseInt(process.argv[3] || "20000");
const CONC = parseInt(process.argv[4] || "50");
const READ_PCT = parseFloat(process.argv[5] || "50");
const ZIPF_S = parseFloat(process.argv[6] || "0.99");
const POOL = process.argv[7] || "/tmp/hookbench/yz-ids.json";
import { readFileSync, writeFileSync } from "fs";

const bases = PORTS.map(p => `http://127.0.0.1:${p}`);
const ids = JSON.parse(readFileSync(POOL, "utf8"));
const NKEYS = ids.length;
// Zipf rank: APR formula for s != 1
function zipfRank() {
  const u = Math.random();
  const s = ZIPF_S, N = NKEYS;
  const zeta = (Math.pow(N, 1 - s) - 1) / (1 - s);
  const r = Math.floor(Math.pow(u * zeta * (1 - s) + 1, 1 / (1 - s)));
  return Math.min(N - 1, Math.max(0, r - 1));
}
const attempts = new Map(); // id -> rmw count
const lat = [];
let ok = 0, fail = 0, idx = 0, rr = 0;
async function one(i) {
  const base = bases[(rr++) % bases.length];
  const isRead = Math.random() * 100 < READ_PCT;
  const id = ids[zipfRank()];
  const t0 = performance.now();
  try {
    if (isRead) {
      const res = await fetch(`${base}/api/items/${id}`);
      await res.arrayBuffer();
      if (res.ok) ok++; else fail++;
      lat.push({ t: performance.now() - t0, w: 0 });
    } else {
      const g = await fetch(`${base}/api/items/${id}`);
      if (!g.ok) { fail++; return; }
      const row = await g.json();
      const w = await fetch(`${base}/api/items/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: row.name, value: row.value + 1 }) });
      await w.arrayBuffer();
      if (w.ok) { ok++; attempts.set(id, (attempts.get(id) || 0) + 1); } else fail++;
      lat.push({ t: performance.now() - t0, w: 1 });
    }
  } catch { fail++; }
}
async function worker() { while (true) { const i = idx++; if (i >= TOTAL) break; await one(i); if ((i + 1) % 5000 === 0) console.error(`  ...${i+1}/${TOTAL}`); } }
const t0 = performance.now();
await Promise.all(Array.from({ length: CONC }, worker));
const el = performance.now() - t0;
// read back hot rows for lost-update accounting (top-50 attempted)
const hot = [...attempts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50);
let lost = 0, checked = 0;
for (const [id, att] of hot) {
  const r = await fetch(`${bases[0]}/api/items/${id}`);
  if (!r.ok) continue;
  const row = await r.json();
  lost += att - row.value; // seeded value=0
  checked++;
}
const pct = (a, p) => { a = [...a].sort((x, y) => x - y); return a.length ? +a[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(3) : 0; };
const rep = f => { const a = lat.filter(f).map(x => x.t); return { n: a.length, p50: pct(a, .5), p95: pct(a, .95), p99: pct(a, .99), max: pct(a, 1) }; };
const attTot = [...attempts.values()].reduce((a, b) => a + b, 0);
console.log(JSON.stringify({
  mode: "ycsb-a", ports: PORTS, total: TOTAL, conc: CONC, read_pct: READ_PCT, zipf_s: ZIPF_S,
  ms_total: +el.toFixed(1), rps: +((ok / el) * 1000).toFixed(1), ok, fail,
  read: rep(x => !x.w), rmw: rep(x => !!x.w),
  lost_update: { hot_rows: checked, attempts: attTot, lost, lost_pct: +(100 * lost / Math.max(1, attTot)).toFixed(2) },
}));
writeFileSync(POOL + ".attempts.json", JSON.stringify([...attempts]));
