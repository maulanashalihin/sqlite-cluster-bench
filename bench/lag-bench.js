#!/usr/bin/env bun
// E8: replication lag = write-to-n1 -> visible-on-replica latency.
// Polls replica every 2ms until row appears (timeout 5s). Reports percentiles.
const WRITER = process.argv[2] || "http://127.0.0.1:4401";
const REPLICAS = (process.argv[3] || "http://127.0.0.1:4402,http://127.0.0.1:4403").split(",");
const N = parseInt(process.argv[4] || "500");
const lags = [];
for (let i = 0; i < N; i++) {
  const r = await fetch(`${WRITER}/api/items`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "lag" + i, value: i }) });
  const { id } = await r.json();
  const t0 = performance.now();
  const seen = new Array(REPLICAS.length).fill(0);
  let done = 0;
  const deadline = t0 + 5000;
  while (done < REPLICAS.length && performance.now() < deadline) {
    for (let k = 0; k < REPLICAS.length; k++) {
      if (seen[k]) continue;
      const q = await fetch(`${REPLICAS[k]}/api/items/${id}`);
      if (q.ok) { await q.arrayBuffer(); seen[k] = performance.now() - t0; done++; }
    }
    if (done < REPLICAS.length) await Bun.sleep(2);
  }
  lags.push(seen);
  if ((i + 1) % 100 === 0) console.error(`  ...${i + 1}/${N}`);
}
function pct(a, p) { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2); }
const per = (k) => lags.map(l => l[k]).filter(x => x > 0);
const out = { n: N, timeouts: lags.filter(l => l.some(x => x === 0)).length };
REPLICAS.forEach((rp, k) => { const a = per(k); out[`replica_${k + 1}`] = { n: a.length, p50: pct(a, .5), p95: pct(a, .95), p99: pct(a, .99), max: pct(a, 1) }; });
const worst = lags.map(l => { const c = l.filter(x => x > 0); return c.length ? Math.max(...c) : -1; }).filter(x => x >= 0);
out.all_replicas = { n: worst.length, p50: pct(worst, .5), p95: pct(worst, .95), p99: pct(worst, .99), max: pct(worst, 1) };
console.log(JSON.stringify(out));
