import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { migrate } from "../src/db/migrate.js";

test("migration 2 creates contest_sync_jobs on upgraded databases", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE "user" (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      emailVerified INTEGER NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      cfHandle TEXT NOT NULL
    );

    CREATE TABLE contests (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE problems (
      contest_id INTEGER NOT NULL,
      problem_index TEXT NOT NULL,
      name TEXT NOT NULL,
      rating INTEGER,
      solved_count INTEGER,
      tags_json TEXT NOT NULL,
      url TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (contest_id, problem_index)
    );

    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    INSERT INTO schema_migrations (version, applied_at) VALUES (1, '2026-01-01T00:00:00.000Z');
  `);

  try {
    migrate(db);

    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'contest_sync_jobs'")
      .get() as { name: string } | undefined;
    const version = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number };
    const claimIndex = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_contest_sync_jobs_claim'")
      .get() as { name: string } | undefined;

    assert.equal(table?.name, "contest_sync_jobs");
    assert.equal(version.version, 5);
    assert.equal(claimIndex?.name, "idx_contest_sync_jobs_claim");
  } finally {
    db.close();
  }
});
