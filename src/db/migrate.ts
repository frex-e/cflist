import { backfillUserContestPerformances } from "../cf/sync/cache.js";
import type { Db } from "./connection.js";

const MIGRATION_1_SQL = `
    CREATE TABLE IF NOT EXISTS "user" (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      emailVerified INTEGER NOT NULL,
      image TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      cfHandle TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "session" (
      id TEXT PRIMARY KEY,
      expiresAt TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      ipAddress TEXT,
      userAgent TEXT,
      userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS "account" (
      id TEXT PRIMARY KEY,
      accountId TEXT NOT NULL,
      providerId TEXT NOT NULL,
      userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      accessToken TEXT,
      refreshToken TEXT,
      idToken TEXT,
      accessTokenExpiresAt TEXT,
      refreshTokenExpiresAt TEXT,
      scope TEXT,
      password TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "verification" (
      id TEXT PRIMARY KEY,
      identifier TEXT NOT NULL,
      value TEXT NOT NULL,
      expiresAt TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      user_id TEXT,
      cf_handle TEXT,
      message TEXT
    );

    CREATE TABLE IF NOT EXISTS contests (
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

    CREATE TABLE IF NOT EXISTS problems (
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
      PRIMARY KEY (contest_id, problem_index)
    );

    CREATE TABLE IF NOT EXISTS problem_tags (
      contest_id INTEGER NOT NULL,
      problem_index TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (contest_id, problem_index, tag),
      FOREIGN KEY (contest_id, problem_index) REFERENCES problems(contest_id, problem_index) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_problem_status (
      user_id TEXT NOT NULL,
      cf_handle TEXT NOT NULL,
      contest_id INTEGER NOT NULL,
      problem_index TEXT NOT NULL,
      solved INTEGER NOT NULL DEFAULT 0,
      first_accepted_submission_id INTEGER,
      first_accepted_at_seconds INTEGER,
      accepted_count INTEGER NOT NULL DEFAULT 0,
      last_checked_at TEXT NOT NULL,
      PRIMARY KEY (user_id, contest_id, problem_index),
      FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_problem_overrides (
      user_id TEXT NOT NULL,
      contest_id INTEGER NOT NULL,
      problem_index TEXT NOT NULL,
      solved_override INTEGER,
      note TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, contest_id, problem_index),
      FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_contest_results (
      user_id TEXT NOT NULL,
      cf_handle TEXT NOT NULL,
      contest_id INTEGER NOT NULL,
      rank INTEGER,
      points REAL,
      penalty INTEGER,
      participant_type TEXT,
      old_rating INTEGER,
      new_rating INTEGER,
      rating_delta INTEGER,
      performance INTEGER,
      last_checked_at TEXT NOT NULL,
      PRIMARY KEY (user_id, contest_id),
      FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE,
      FOREIGN KEY (contest_id) REFERENCES contests(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_contest_problem_results (
      user_id TEXT NOT NULL,
      contest_id INTEGER NOT NULL,
      problem_index TEXT NOT NULL,
      points REAL,
      penalty INTEGER,
      rejected_attempt_count INTEGER,
      best_submission_time_seconds INTEGER,
      solved_in_contest INTEGER NOT NULL DEFAULT 0,
      upsolved INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, contest_id, problem_index),
      FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE,
      FOREIGN KEY (contest_id, problem_index) REFERENCES problems(contest_id, problem_index) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS contest_rating_changes_cache (
      contest_id INTEGER PRIMARY KEY,
      raw_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      FOREIGN KEY (contest_id) REFERENCES contests(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS contest_standings_cache (
      contest_id INTEGER PRIMARY KEY,
      raw_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      FOREIGN KEY (contest_id) REFERENCES contests(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS contest_performance_cache (
      contest_id INTEGER NOT NULL,
      handle_key TEXT NOT NULL,
      handle TEXT NOT NULL,
      performance INTEGER,
      calculated_at TEXT NOT NULL,
      PRIMARY KEY (contest_id, handle_key),
      FOREIGN KEY (contest_id) REFERENCES contests(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS contest_sync_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      cf_handle TEXT NOT NULL,
      contest_id INTEGER NOT NULL,
      priority INTEGER NOT NULL DEFAULT 100,
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (user_id, contest_id),
      FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE,
      FOREIGN KEY (contest_id) REFERENCES contests(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_default_filters (
      user_id TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS session_userId_idx ON "session"(userId);
    CREATE INDEX IF NOT EXISTS account_userId_idx ON "account"(userId);
    CREATE INDEX IF NOT EXISTS verification_identifier_idx ON "verification"(identifier);
    CREATE INDEX IF NOT EXISTS idx_problems_rating ON problems(rating);
    CREATE INDEX IF NOT EXISTS idx_problems_solved_count ON problems(solved_count);
    CREATE INDEX IF NOT EXISTS idx_problem_tags_tag ON problem_tags(tag);
    CREATE INDEX IF NOT EXISTS idx_contests_derived ON contests(derived_family, derived_division);
    CREATE INDEX IF NOT EXISTS idx_user_status_user_solved ON user_problem_status(user_id, solved);
    CREATE INDEX IF NOT EXISTS idx_user_contest_results_user ON user_contest_results(user_id, contest_id DESC);
    CREATE INDEX IF NOT EXISTS idx_user_contest_problem_results_user ON user_contest_problem_results(user_id, contest_id);
    CREATE INDEX IF NOT EXISTS idx_contest_performance_cache_handle ON contest_performance_cache(handle_key);
    CREATE INDEX IF NOT EXISTS idx_contest_sync_jobs_claim ON contest_sync_jobs(status, available_at, priority, id);
    CREATE INDEX IF NOT EXISTS idx_contest_sync_jobs_user ON contest_sync_jobs(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_sync_runs_started_at ON sync_runs(started_at);
  `;

const MIGRATION_2_SQL = `
    CREATE TABLE IF NOT EXISTS contest_sync_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      cf_handle TEXT NOT NULL,
      contest_id INTEGER NOT NULL,
      priority INTEGER NOT NULL DEFAULT 100,
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (user_id, contest_id),
      FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE,
      FOREIGN KEY (contest_id) REFERENCES contests(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_contest_sync_jobs_claim ON contest_sync_jobs(status, available_at, priority, id);
    CREATE INDEX IF NOT EXISTS idx_contest_sync_jobs_user ON contest_sync_jobs(user_id, status);
  `;

const MIGRATION_3_SQL = `
    DELETE FROM contest_performance_cache
    WHERE (contest_id, handle_key) IN (
      SELECT contest_id, lower(cf_handle)
      FROM user_contest_results
      WHERE old_rating = 0
    );

    UPDATE user_contest_results
    SET performance = NULL
    WHERE old_rating = 0 AND performance IS NOT NULL;
  `;

const MIGRATION_4_SQL = `
    DELETE FROM contest_performance_cache;

    UPDATE user_contest_results
    SET performance = NULL
    WHERE performance IS NOT NULL;
  `;

const currentVersion = (db: Db): number => {
  const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number | null };
  return row.version ?? 0;
};

const tableExists = (db: Db, name: string): boolean => {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = @name").get({ name }) as { name: string } | undefined;
  return row !== undefined;
};

const recordMigration = (db: Db, version: number): void => {
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (@version, @appliedAt)",
  ).run({ version, appliedAt: new Date().toISOString() });
};

const applyMigration = (db: Db, version: number, sql: string, skipSqlIfTablesExist?: string): void => {
  if (currentVersion(db) >= version) return;

  if (skipSqlIfTablesExist && tableExists(db, skipSqlIfTablesExist)) {
    recordMigration(db, version);
    return;
  }

  db.exec(sql);
  recordMigration(db, version);
};

const applyPerformanceRecalculationMigration = (db: Db): void => {
  if (currentVersion(db) >= 3) return;

  if (tableExists(db, "contest_performance_cache") && tableExists(db, "user_contest_results")) {
    db.exec(MIGRATION_3_SQL);
  }

  recordMigration(db, 3);
};

const applyBootstrapPerformanceMigration = (db: Db): void => {
  if (currentVersion(db) >= 4) return;

  if (tableExists(db, "contest_performance_cache") && tableExists(db, "user_contest_results")) {
    db.exec(MIGRATION_4_SQL);
  }

  recordMigration(db, 4);
};

const applyPerformanceBackfillMigration = (db: Db): void => {
  if (currentVersion(db) >= 5) return;
  if (!tableExists(db, "user_contest_results")) {
    recordMigration(db, 5);
    return;
  }

  const users = db.prepare(`
    SELECT DISTINCT user_id AS userId
    FROM user_contest_results
  `).all() as { userId: string }[];

  for (const user of users) {
    backfillUserContestPerformances(db, user.userId);
  }

  recordMigration(db, 5);
};

export const migrate = (db: Db): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  applyMigration(db, 1, MIGRATION_1_SQL, "problems");
  applyMigration(db, 2, MIGRATION_2_SQL);
  applyPerformanceRecalculationMigration(db);
  applyBootstrapPerformanceMigration(db);
  applyPerformanceBackfillMigration(db);
};
