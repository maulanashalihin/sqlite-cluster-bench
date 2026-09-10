import { Database } from "bun:sqlite";

// Sharded cluster: each worker owns a private DB file -> no shared WAL lock.
const PORT = parseInt(process.env.PORT || "4104");
const DB_BASE = process.env.DB_BASE || "/tmp/sqlbench/shard";
const IS_WORKER = process.env.IS_WORKER === "1";

if (!IS_WORKER) {
  const N = parseInt(process.env.WORKERS || "6");
  for (let w = 0; w < N; w++) {
    const p = `${DB_BASE}.${w}.db`;
    try { await Bun.file(p).unlink(); } catch {}
    try { await Bun.file(p + "-wal").unlink(); } catch {}
    try { await Bun.file(p + "-shm").unlink(); } catch {}
    const seed = new Database(p);
    seed.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA cache_size=-64000;");
    seed.exec("DROP TABLE IF EXISTS kv; CREATE TABLE kv (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)");
    const vs = "v".repeat(100);
    const t0 = performance.now();
    seed.transaction((n) => {
      const ins = seed.prepare("INSERT INTO kv(val) VALUES(?)");
      for (let i = 0; i < n; i++) ins.run(vs);
    })(20000);
    console.log(`shard seeded ${p} 20000 rows in ${(performance.now() - t0).toFixed(0)}ms`);
    seed.close();
  }
  console.log(`shard primary spawning ${N} workers on :${PORT} reusePort`);
  const procs = [];
  for (let i = 0; i < N; i++) {
    const p = Bun.spawn(["bun", import.meta.path], {
      env: { ...process.env, IS_WORKER: "1", SHARD_IDX: String(i) },
      stdout: "inherit",
      stderr: "inherit",
    });
    procs.push(p);
  }
  const stop = () => { for (const p of procs) try { p.kill(); } catch {} process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await Promise.all(procs.map(p => p.exited));
} else {
  const idx = process.env.SHARD_IDX || "0";
  const p = `${DB_BASE}.${idx}.db`;
  const db = new Database(p);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA cache_size=-64000;");
  const ins = db.prepare("INSERT INTO kv(val) VALUES(?)");
  const sel = db.prepare("SELECT val FROM kv WHERE id = ?");
  const VS = "v".repeat(100);
  Bun.serve({
    port: PORT,
    hostname: "0.0.0.0",
    reusePort: true,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") return Response.json({ status: "ok", shard: idx });
      try {
        if (req.method === "POST" && url.pathname === "/write") {
          ins.run(VS);
          return Response.json({ ok: 1 });
        }
        if (url.pathname === "/read") {
          const id = parseInt(url.searchParams.get("id") || "1");
          const row = sel.get(id);
          if (!row) return Response.json({ error: "not found" }, { status: 500 });
          return Response.json({ ok: 1 });
        }
        return new Response("ok");
      } catch (e) {
        return Response.json({ error: String(e?.message || e) }, { status: 500 });
      }
    },
  });
  console.log(`shard worker idx=${idx} pid=${process.pid} db=${p} on :${PORT}`);
}
