import { SQL } from "bun";

// Shared Postgres backend: single writer lock does NOT exist here (MVCC),
// so cluster is expected to scale for writes too — unlike SQLite.
const PORT = parseInt(process.env.PORT || "4106");
const PG_URL = process.env.PG_URL || "postgres://ubuntu:bench123@localhost:5432/hookbench?sslmode=disable";
const IS_WORKER = process.env.IS_WORKER === "1";

const VS = "v".repeat(100);

async function seed() {
  const sql = new SQL(PG_URL, { max: 10 });
  await sql`DROP TABLE IF EXISTS pgkv`;
  await sql`CREATE TABLE pgkv (id SERIAL PRIMARY KEY, val TEXT)`;
  const t0 = performance.now();
  // 10 concurrent streams x 2k single-row inserts
  await Promise.all(Array.from({ length: 10 }, async () => {
    for (let i = 0; i < 2000; i++) {
      await sql`INSERT INTO pgkv (val) VALUES(${VS})`;
    }
  }));
  console.log(`pg seeded 20000 rows in ${(performance.now() - t0).toFixed(0)}ms`);
  await sql.close();
}
function serve() {
  const sql = new SQL(PG_URL, { max: 10 });
  Bun.serve({
    port: PORT,
    hostname: "0.0.0.0",
    reusePort: true,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") return Response.json({ status: "ok" });
      try {
        if (req.method === "POST" && url.pathname === "/write") {
          await sql`INSERT INTO pgkv (val) VALUES(${VS})`;
          return Response.json({ ok: 1 });
        }
        if (url.pathname === "/read") {
          const id = parseInt(url.searchParams.get("id") || "1");
          const rows = await sql`SELECT val FROM pgkv WHERE id = ${id}`;
          if (rows.length === 0) return Response.json({ error: "not found" }, { status: 500 });
          return Response.json({ ok: 1 });
        }
        return new Response("ok");
      } catch (e) {
        return Response.json({ error: String(e?.message || e) }, { status: 500 });
      }
    },
  });
  console.log(`pg worker pid=${process.pid} on :${PORT}`);
}

if (!IS_WORKER) {
  await seed();
  const N = parseInt(process.env.WORKERS || "6");
  console.log(`pg primary spawning ${N} workers on :${PORT} reusePort`);
  const procs = [];
  for (let i = 0; i < N; i++) {
    procs.push(Bun.spawn(["bun", import.meta.path], {
      env: { ...process.env, IS_WORKER: "1" },
      stdout: "inherit", stderr: "inherit",
    }));
  }
  const stop = () => { for (const p of procs) try { p.kill(); } catch {} process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await Promise.all(procs.map(p => p.exited));
} else {
  serve();
}
