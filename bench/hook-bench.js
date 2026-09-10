#!/usr/bin/env bun
// hook-sync mesh benchmark: round-robin across N ports (LB simulation).
// WRITE: POST /api/items {name,value} (UUID PK, async ship to peers)
// READ:  GET /api/items/:id from id pool.  Reports avg/p50/p95/p99/max + rps.
import { readFileSync, appendFileSync } from "fs";
const PORTS = (process.argv[2] || "4401,4402,4403,4404,4405,4406").split(",").map(Number);
const TOTAL = parseInt(process.argv[3] || "20000");
const CONC = parseInt(process.argv[4] || "50");
const MODE = process.argv[5] || "read"; // read|write|mix
const POOL = process.argv[6] || "/tmp/hookbench/ids.json";
const MIX_PCT = parseFloat(process.argv[7] || "5");

const bases = PORTS.map(p => `http://127.0.0.1:${p}`);
let ids = MODE === "write" ? [] : JSON.parse(readFileSync(POOL, "utf8"));
const lat = [];
let ok = 0, fail = 0, idx = 0, rr = 0;
const newIds = [];

async function one(i) {
  const base = bases[(rr++) % bases.length];
  const isWrite = MODE === "write" || (MODE === "mix" && Math.random() * 100 < MIX_PCT);
  const t0 = performance.now();
  try {
    let res;
    if (isWrite) {
      res = await fetch(`${base}/api/items`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "w" + i, value: i }) });
      const j = await res.json();
      if (res.ok && j.id) newIds.push(j.id);
      else await res.arrayBuffer?.();
    } else {
      const id = ids[Math.floor(Math.random() * ids.length)];
      res = await fetch(`${base}/api/items/${id}`);
      await res.arrayBuffer();
    }
    if (res.ok) ok++; else fail++;
  } catch { fail++; }
  lat.push({ t: performance.now() - t0, w: isWrite ? 1 : 0 });
}
async function worker() {
  while (true) { const i = idx++; if (i >= TOTAL) break; await one(i); if ((i+1) % 5000 === 0) console.error(`  ...${i+1}/${TOTAL}`); }
}
const t0 = performance.now();
await Promise.all(Array.from({ length: CONC }, worker));
const el = performance.now() - t0;
function pct(a, p) { if (!a.length) return 0; const s = [...a].sort((x,y)=>x-y); return +s[Math.min(s.length-1, Math.floor(p*s.length))].toFixed(3); }
function rep(f) { const a = lat.filter(f).map(x=>x.t); return { n: a.length, p50: pct(a,.5), p95: pct(a,.95), p99: pct(a,.99), max: pct(a,1) }; }
if (newIds.length) appendFileSync(POOL + ".new", newIds.join("\n") + "\n");
console.log(JSON.stringify({ mode: MODE, ports: PORTS, total: TOTAL, conc: CONC, ms_total: +el.toFixed(1), rps: +((ok/el)*1000).toFixed(1), ok, fail, all: rep(()=>true), read: rep(x=>!x.w), write: rep(x=>!!x.w) }));
