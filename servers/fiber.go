package main

import (
	"database/sql"
	"fmt"
	"os"

	"github.com/gofiber/fiber/v2"
	_ "github.com/mattn/go-sqlite3"
)

func main() {
	port := "4101"
	if len(os.Args) > 1 {
		port = os.Args[1]
	}
	dbPath := "/tmp/sqlbench/fiber.db"
	if len(os.Args) > 2 {
		dbPath = os.Args[2]
	}
	os.Remove(dbPath)
	os.Remove(dbPath + "-wal")
	os.Remove(dbPath + "-shm")

	db, err := sql.Open("sqlite3", dbPath+"?cache=shared")
	if err != nil {
		panic(err)
	}
	// Realistic Fiber default: pool sized to cores, NOT 1.
	// This is what exposes WAL write-lock queueing under goroutine fan-in.
	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(10)

	for _, p := range []string{
		"PRAGMA journal_mode=WAL;",
		"PRAGMA synchronous=NORMAL;",
		"PRAGMA busy_timeout=5000;",
		"PRAGMA cache_size=-64000;",
	} {
		if _, err := db.Exec(p); err != nil {
			panic(err)
		}
	}
	if _, err := db.Exec(`DROP TABLE IF EXISTS kv; CREATE TABLE kv (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)`); err != nil {
		panic(err)
	}
	// seed 20k rows so reads hit real data
	tx, _ := db.Begin()
	stmt, _ := tx.Prepare("INSERT INTO kv(val) VALUES(?)")
	v := make([]byte, 100)
	for i := range v {
		v[i] = 'v'
	}
	vs := string(v)
	for i := 0; i < 20000; i++ {
		if _, err := stmt.Exec(vs); err != nil {
			panic(err)
		}
	}
	stmt.Close()
	if err := tx.Commit(); err != nil {
		panic(err)
	}
	var cnt int
	db.QueryRow("SELECT COUNT(*) FROM kv").Scan(&cnt)
	fmt.Printf("fiber seeded rows=%d db=%s\n", cnt, dbPath)

	ins, err := db.Prepare("INSERT INTO kv(val) VALUES(?)")
	if err != nil {
		panic(err)
	}
	// point lookup by id
	sel, err := db.Prepare("SELECT val FROM kv WHERE id = ?")
	if err != nil {
		panic(err)
	}

	app := fiber.New(fiber.Config{
		Prefork:               false,
		DisableStartupMessage: true,
		// keep server overhead minimal so sqlite is the bottleneck
	})

	app.Get("/health", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{"status": "ok"})
	})
	app.Post("/write", func(c *fiber.Ctx) error {
		// 100B payload like harness
		if _, err := ins.Exec(vs); err != nil {
			return c.Status(500).JSON(fiber.Map{"error": err.Error()})
		}
		return c.JSON(fiber.Map{"ok": 1})
	})
	app.Get("/read", func(c *fiber.Ctx) error {
		id := c.QueryInt("id", 1)
		var val string
		if err := sel.QueryRow(id).Scan(&val); err != nil {
			return c.Status(500).JSON(fiber.Map{"error": err.Error()})
		}
		return c.JSON(fiber.Map{"ok": 1})
	})

	fmt.Printf("fiber listening :%s\n", port)
	if err := app.Listen("0.0.0.0:" + port); err != nil {
		panic(err)
	}
}
