import { Database } from "bun:sqlite";

const PORT = parseInt(process.env.PORT || "4102");
const DB_PATH = process.env.DB_PATH || "/tmp/sqlbench/bun.db";
const IS_WORKER = process.env.IS_WORKER === "1";

if (!IS_WORKER) {
  // primary: fresh DB + seed 20k, then spawn workers
  try { await Bun.file(DB_PATH).unlink(); } catch {}
  try { await Bun.file(DB_PATH + "-wal").unlink(); } catch {}
  try { await Bun.file(DB_PATH + "-shm").unlink(); } catch {}
  const seed = new Database(DB_PATH);
  seed.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA cache_size=-64000;");
  seed.exec("DROP TABLE IF EXISTS kv; CREATE TABLE kv (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)");
  const vs = "v".repeat(100);
  const t0 = performance.now();
  const tx = seed.transaction((n) => {
    const ins = seed.prepare("INSERT INTO kv(val) VALUES(?)");
    for (let i = 0; i < n; i++) ins.run(vs);
  });
  tx(20000);
  console.log(`bun seeded 20000 rows in ${(performance.now() - t0).toFixed(0)}ms db=${DB_PATH}`);
  seed.close();

  const N = parseInt(process.env.WORKERS || "6");
  console.log(`bun primary spawning ${N} workers on :${PORT} reusePort`);
  const procs = [];
  for (let i = 0; i < N; i++) {
    const p = Bun.spawn(["bun", import.meta.path], {
      env: { ...process.env, IS_WORKER: "1" },
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
  const db = new Database(DB_PATH);
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
      if (url.pathname === "/health") return Response.json({ status: "ok" });
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
  console.log(`bun worker pid=${process.pid} on :${PORT}`);
}
