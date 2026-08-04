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
    const userColumns = db
      .prepare(`PRAGMA table_info("user")`)
      .all()
      .map((row) => (row as { name: string }).name);

    assert.ok(problemColumns.includes("canonical_id"));
    assert.ok(problemColumns.includes("estimated_rating"));
    assert.ok(problemColumns.includes("estimated_rating_at"));
    assert.ok(contestResultColumns.includes("standings_checked_at"));
    assert.ok(userColumns.includes("lastLoginAt"));

    const overrideColumns = db
      .prepare("PRAGMA table_info(user_problem_overrides)")
      .all()
      .map((row) => (row as { name: string }).name);
    assert.ok(overrideColumns.includes("skipped"));
  } finally {
    db.close();
  }
});

test("migrate adds lastLoginAt to an existing auth user table", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");

  try {
    db.exec(`
      CREATE TABLE "user" (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        emailVerified INTEGER NOT NULL,
        image TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        cfHandle TEXT NOT NULL
      );
    `);

    migrate(db);
    migrate(db);

    const matchingColumns = db
      .prepare(`PRAGMA table_info("user")`)
      .all()
      .map((row) => (row as { name: string }).name)
      .filter((name) => name === "lastLoginAt");
    assert.deepEqual(matchingColumns, ["lastLoginAt"]);

    const indexes = db
      .prepare(`PRAGMA index_list("user")`)
      .all()
      .map((row) => (row as { name: string }).name);
    assert.ok(indexes.includes("user_lastLoginAt_idx"));
  } finally {
    db.close();
  }
});

test("migrate adds estimated_rating columns to a pre-PR#10 problems table", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");

  try {
    db.exec(`
      CREATE TABLE contests (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT,
        phase TEXT,
        duration_seconds INTEGER,
        start_time_seconds INTEGER,
        year INTEGER,
        derived_family TEXT,
        derived_division TEXT,
        derived_label TEXT,
        raw_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE problems (
        contest_id INTEGER NOT NULL,
        problemset_name TEXT,
        problem_index TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT,
        points REAL,
        rating INTEGER,
        solved_count INTEGER,
        tags_json TEXT NOT NULL,
        url TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        canonical_id TEXT NOT NULL,
        PRIMARY KEY (contest_id, problem_index),
        FOREIGN KEY (contest_id) REFERENCES contests(id) ON DELETE CASCADE
      );
      INSERT INTO contests (
        id, name, raw_json, updated_at
      ) VALUES (
        1, 'Contest 1', '{}', '2026-01-01T00:00:00.000Z'
      );
      INSERT INTO problems (
        contest_id, problem_index, name, rating, tags_json, url, raw_json,
        updated_at, canonical_id
      ) VALUES (
        1, 'A', 'Problem A', 800, '[]', 'https://example.com', '{}',
        '2026-01-01T00:00:00.000Z', 'canonical-a'
      );
    `);

    migrate(db);

    const problemColumns = db
      .prepare("PRAGMA table_info(problems)")
      .all()
      .map((row) => (row as { name: string }).name);
    assert.ok(problemColumns.includes("estimated_rating"));
    assert.ok(problemColumns.includes("estimated_rating_at"));

    const row = db
      .prepare(
        `
        SELECT name, rating, estimated_rating, estimated_rating_at
        FROM problems
        WHERE contest_id = 1 AND problem_index = 'A'
      `,
      )
      .get() as {
      name: string;
      rating: number | null;
      estimated_rating: number | null;
      estimated_rating_at: string | null;
    };
    assert.equal(row.name, "Problem A");
    assert.equal(row.rating, 800);
    assert.equal(row.estimated_rating, null);
    assert.equal(row.estimated_rating_at, null);

    // Idempotent on a second migrate.
    migrate(db);
    const again = db
      .prepare("PRAGMA table_info(problems)")
      .all()
      .map((row) => (row as { name: string }).name)
      .filter((name) => name === "estimated_rating" || name === "estimated_rating_at");
    assert.deepEqual(again, ["estimated_rating", "estimated_rating_at"]);
  } finally {
    db.close();
  }
});

test("migrate preserves a deployed current-schema database", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");

  try {
    migrate(db);
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations (version, applied_at)
      VALUES (9, '2026-01-01T00:00:00.000Z');
    `);
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
    const version = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as {
      version: number;
    };
    assert.equal(users.count, 1);
    assert.equal(version.version, 9);
  } finally {
    db.close();
  }
});
