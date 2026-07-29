import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { migrate } from "../src/db/migrate.js";

test("migrate bootstraps the current schema without migration history", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");

  try {
    migrate(db);

    const tables = db
      .prepare(
        `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `,
      )
      .all()
      .map((row) => (row as { name: string }).name);

    assert.deepEqual(tables, [
      "account",
      "contest_performance_cache",
      "contest_rating_changes_cache",
      "contest_round_pairs",
      "contest_sync_jobs",
      "contests",
      "problem_tags",
      "problems",
      "session",
      "sync_runs",
      "user",
      "user_contest_problem_results",
      "user_contest_results",
      "user_default_filters",
      "user_problem_overrides",
      "user_problem_status",
      "verification",
    ]);

    const problemColumns = db
      .prepare("PRAGMA table_info(problems)")
      .all()
      .map((row) => (row as { name: string }).name);
    const contestResultColumns = db
      .prepare("PRAGMA table_info(user_contest_results)")
      .all()
      .map((row) => (row as { name: string }).name);

    assert.ok(problemColumns.includes("canonical_id"));
    assert.ok(contestResultColumns.includes("standings_checked_at"));
  } finally {
    db.close();
  }
});

test("migrate is idempotent", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");

  try {
    migrate(db);
    db.prepare(
      `
      INSERT INTO "user" (
        id, name, email, emailVerified, createdAt, updatedAt, cfHandle
      ) VALUES (
        'user-1', 'Test User', 'test@example.com', 1,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'tourist'
      )
    `,
    ).run();

    migrate(db);

    const users = db.prepare(`SELECT COUNT(*) AS count FROM "user"`).get() as { count: number };
    assert.equal(users.count, 1);
  } finally {
    db.close();
  }
});
