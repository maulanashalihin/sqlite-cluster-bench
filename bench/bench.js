#!/usr/bin/env bun
// HTTP benchmark: fixed concurrency, reports avg/p50/p95/p99/max + throughput + errors
const url = process.argv[2];
const TOTAL = parseInt(process.argv[3] || "20000");
const CONC = parseInt(process.argv[4] || "50");
const MODE = process.argv[5] || "read"; // read|write

const lat = new Float64Array(TOTAL);
let ok = 0, fail = 0;
let idx = 0;

async function one(i) {
  const t0 = performance.now();
  try {
    let res;
    if (MODE === "write") {
      res = await fetch(url, { method: "POST", body: "x".repeat(100) });
    } else {
      // random hot id in [1,20000+] — writes grow the table, so allow headroom
      const id = 1 + Math.floor(Math.random() * 20000);
      res = await fetch(`${url}?id=${id}`);
    }
    await res.arrayBuffer();
    if (res.ok) ok++; else fail++;
  } catch { fail++; }
  lat[i] = performance.now() - t0;
}

async function worker(n) {
  while (true) {
    const i = idx++;
    if (i >= TOTAL) break;
    await one(i);
    if ((i + 1) % 5000 === 0) console.error(`  ...${i + 1}/${TOTAL}`);
  }
}

const t0 = performance.now();
await Promise.all(Array.from({ length: CONC }, (_, k) => worker(k)));
const el = performance.now() - t0;

const s = Array.from(lat).sort((a, b) => a - b);
const q = (p) => s[Math.min(TOTAL - 1, Math.floor(p * TOTAL))];
const mean = s.reduce((a, b) => a + b, 0) / TOTAL;
console.log(JSON.stringify({
  mode: MODE, url, total: TOTAL, conc: CONC,
  ms_total: +el.toFixed(1),
  rps: +((ok / el) * 1000).toFixed(1),
  ok, fail,
  avg_ms: +mean.toFixed(3),
  p50_ms: +q(0.50).toFixed(3),
  p95_ms: +q(0.95).toFixed(3),
  p99_ms: +q(0.99).toFixed(3),
  max_ms: +s[TOTAL - 1].toFixed(3),
}));
