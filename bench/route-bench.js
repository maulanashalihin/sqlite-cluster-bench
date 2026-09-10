#!/usr/bin/env bun
// Routed benchmark: writes -> single writer port, reads -> round-robin reader ports.
const wbase = process.argv[2];
const rports = process.argv[3].split(",");
const TOTAL = parseInt(process.argv[4] || "20000");
const CONC = parseInt(process.argv[5] || "50");
const MIX = parseFloat(process.argv[6] || "5");
const rbases = rports.map(p => `http://127.0.0.1:${p}`);
const lat = [];
let ok = 0, fail = 0, idx = 0, rr = 0;
async function one(i) {
  const isWrite = Math.random() * 100 < MIX;
  const t0 = performance.now();
  try {
    let res;
    if (isWrite) res = await fetch(`${wbase}/write`, { method: "POST", body: "x".repeat(100) });
    else res = await fetch(`${rbases[(rr++) % rbases.length]}/read?id=${1 + Math.floor(Math.random() * 20000)}`);
    await res.arrayBuffer();
    if (res.ok) ok++; else fail++;
    lat.push({ t: performance.now() - t0, w: isWrite ? 1 : 0 });
  } catch { fail++; lat.push({ t: -1, w: isWrite ? 1 : 0 }); }
}
async function worker() { while (true) { const i = idx++; if (i >= TOTAL) break; await one(i); if ((i+1)%5000===0) console.error(`  ...${i+1}/${TOTAL}`); } }
const t0 = performance.now();
await Promise.all(Array.from({ length: CONC }, worker));
const el = performance.now() - t0;
const pct = (a,p) => { a=[...a].sort((x,y)=>x-y); return a.length ? +a[Math.min(a.length-1,Math.floor(p*a.length))].toFixed(3) : 0; };
const rep = f => { const a = lat.filter(x=>x.t>=0).filter(f).map(x=>x.t); return { n: a.length, p50: pct(a,.5), p95: pct(a,.95), p99: pct(a,.99), max: pct(a,1) }; };
console.log(JSON.stringify({ mode: `mix${MIX}`, total: TOTAL, conc: CONC, ms_total: +el.toFixed(1), rps: +((ok/el)*1000).toFixed(1), ok, fail, all: rep(()=>true), read: rep(x=>!x.w), write: rep(x=>!!x.w) }));
