package main

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	port := "4107"
	if len(os.Args) > 1 {
		port = os.Args[1]
	}
	pgURL := "postgres://ubuntu:bench123@localhost:5432/hookbench?sslmode=disable"
	if u := os.Getenv("PG_URL"); u != "" {
		pgURL = u
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, pgURL)
	if err != nil {
		panic(err)
	}
	defer pool.Close()
	pool.Config().MaxConns = 10

	vs := strings.Repeat("v", 100)
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Get("/health", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{"status": "ok"})
	})
	app.Post("/write", func(c *fiber.Ctx) error {
		if _, err := pool.Exec(ctx, "INSERT INTO pgkv(val) VALUES($1)", vs); err != nil {
			return c.Status(500).JSON(fiber.Map{"error": err.Error()})
		}
		return c.JSON(fiber.Map{"ok": 1})
	})
	app.Get("/read", func(c *fiber.Ctx) error {
		id := c.QueryInt("id", 1)
		var val string
		if err := pool.QueryRow(ctx, "SELECT val FROM pgkv WHERE id=$1", id).Scan(&val); err != nil {
			return c.Status(500).JSON(fiber.Map{"error": err.Error()})
		}
		return c.JSON(fiber.Map{"ok": 1})
	})
	fmt.Printf("fiber-pg listening :%s\n", port)
	if err := app.Listen("0.0.0.0:" + port); err != nil {
		panic(err)
	}
}
