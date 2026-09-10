#!/usr/bin/env bun
// Mixed workload: WRITE_PCT% writes, rest reads. Reports global + per-op percentiles.
const base = process.argv[2]; // e.g. http://127.0.0.1:4105
const TOTAL = parseInt(process.argv[3] || "20000");
const CONC = parseInt(process.argv[4] || "50");
const WRITE_PCT = parseFloat(process.argv[5] || "5");

const latR = [], latW = [];
let ok = 0, fail = 0, idx = 0;

async function one(i) {
  const isWrite = Math.random() * 100 < WRITE_PCT;
  const t0 = performance.now();
  try {
    let res;
    if (isWrite) {
      res = await fetch(`${base}/write`, { method: "POST", body: "x".repeat(100) });
    } else {
      const id = 1 + Math.floor(Math.random() * 20000);
      res = await fetch(`${base}/read?id=${id}`);
    }
    await res.arrayBuffer();
    if (res.ok) ok++; else fail++;
    (isWrite ? latW : latR).push(performance.now() - t0);
  } catch { fail++; (isWrite ? latW : latR).push(performance.now() - t0); }
}

async function worker() {
  while (true) {
    const i = idx++;
    if (i >= TOTAL) break;
    await one(i);
    if ((i + 1) % 5000 === 0) console.error(`  ...${i + 1}/${TOTAL}`);
  }
}

function pct(a, p) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(3);
}

const t0 = performance.now();
await Promise.all(Array.from({ length: CONC }, worker));
const el = performance.now() - t0;
console.log(JSON.stringify({
  base, total: TOTAL, conc: CONC, write_pct: WRITE_PCT,
  ms_total: +el.toFixed(1), rps: +((ok / el) * 1000).toFixed(1), ok, fail,
  n_read: latR.length, n_write: latW.length,
  read: { p50: pct(latR, .5), p95: pct(latR, .95), p99: pct(latR, .99), max: pct(latR, 1) },
  write: { p50: pct(latW, .5), p95: pct(latW, .95), p99: pct(latW, .99), max: pct(latW, 1) },
}));
