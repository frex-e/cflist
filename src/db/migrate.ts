import type { Db } from "./connection.js";

export const migrate = (db: Db): void => {
  db.exec(`
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
    CREATE INDEX IF NOT EXISTS idx_sync_runs_started_at ON sync_runs(started_at);
  `);
};
