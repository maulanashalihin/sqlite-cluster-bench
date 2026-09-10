#!/usr/bin/env bun
// Demo sharding SQLite: 4 file, router hash(tenant)%4, scatter-gather.
import { Database } from "bun:sqlite";
import { unlinkSync, existsSync } from "fs";

const N = 4;
const files = Array.from({ length: N }, (_, i) => `/tmp/shard-demo/s${i}.db`);
if (process.argv[2] === "reset") for (const f of files) if (existsSync(f)) { unlinkSync(f); try { unlinkSync(f + "-wal"); } catch {} try { unlinkSync(f + "-shm"); } catch {} }

// fnv-1a hash -> shard index (deterministik)
function shardOf(tenant) {
  let h = 0x811c9dc5;
  for (let i = 0; i < tenant.length; i++) { h ^= tenant.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0) % N;
}
const dbs = files.map(f => {
  const db = new Database(f, { create: true });
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
  db.exec("CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, tenant TEXT, total INTEGER)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tenant ON orders(tenant)");
  return db;
});
const ins = dbs.map(db => db.prepare("INSERT INTO orders(id, tenant, total) VALUES(?,?,?)"));

const tenants = ["acme", "budi", "cinta", "dedi", "eko", "farah", "gilang", "hendra"];
console.log("== peta tenant -> shard ==");
for (const t of tenants) console.log(`   ${t.padEnd(8)} -> s${shardOf(t)}.db`);

// seed 500 order/tenant, total acak 10..100
let n = 0;
const t0 = performance.now();
for (const t of tenants) {
  const db = dbs[shardOf(t)];
  const tx = db.transaction(() => { for (let i = 0; i < 500; i++) ins[shardOf(t)].run(crypto.randomUUID(), t, 10 + Math.floor(Math.random() * 91)); });
  tx(); n += 500;
}
console.log(`\n== seed ${n} order @ ${(performance.now() - t0).toFixed(0)}ms ==`);

// 1) query satu tenant: sentuh 1 file saja
const t1 = performance.now();
const one = dbs[shardOf("acme")].prepare("SELECT COUNT(*) c, SUM(total) s FROM orders WHERE tenant=?").get("acme");
console.log(`per-tenant (acme, 1 file): count=${one.c} sum=${one.s} (${(performance.now() - t1).toFixed(2)}ms)`);

// 2) scatter-gather: semua file, jumlahkan di app
const t2 = performance.now();
let tc = 0, ts = 0;
for (const db of dbs) {
  const r = db.prepare("SELECT COUNT(*) c, SUM(total) s FROM orders").get();
  tc += r.c; ts += r.s;
}
console.log(`scatter-gather (4 file): count=${tc} sum=${ts} (${(performance.now() - t2).toFixed(2)}ms)`);

// 3) bukti mandiri: tiap file hanya punya tenant-nya
console.log("\n== isi tiap file ==");
for (let i = 0; i < N; i++) {
  const rows = dbs[i].prepare("SELECT DISTINCT tenant FROM orders").all();
  console.log(`   s${i}.db: [${rows.map(r => r.tenant).join(", ")}]`);
}
for (const db of dbs) db.close();
