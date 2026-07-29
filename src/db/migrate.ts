import type { Db } from "./connection.js";

const SCHEMA_SQL = `
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
    status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')),
    source TEXT NOT NULL,
    user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
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
    canonical_id TEXT NOT NULL,
    PRIMARY KEY (contest_id, problem_index),
    FOREIGN KEY (contest_id) REFERENCES contests(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS problem_tags (
    contest_id INTEGER NOT NULL,
    problem_index TEXT NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY (contest_id, problem_index, tag),
    FOREIGN KEY (contest_id, problem_index)
      REFERENCES problems(contest_id, problem_index) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS contest_round_pairs (
    contest_id_low INTEGER NOT NULL,
    contest_id_high INTEGER NOT NULL,
    start_time_seconds INTEGER NOT NULL,
    PRIMARY KEY (contest_id_low, contest_id_high),
    FOREIGN KEY (contest_id_low) REFERENCES contests(id) ON DELETE CASCADE,
    FOREIGN KEY (contest_id_high) REFERENCES contests(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS user_problem_status (
    user_id TEXT NOT NULL,
    contest_id INTEGER NOT NULL,
    problem_index TEXT NOT NULL,
    solved INTEGER NOT NULL DEFAULT 0 CHECK (solved IN (0, 1)),
    first_accepted_submission_id INTEGER,
    first_accepted_at_seconds INTEGER,
    accepted_count INTEGER NOT NULL DEFAULT 0,
    last_checked_at TEXT NOT NULL,
    PRIMARY KEY (user_id, contest_id, problem_index),
    FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE,
    FOREIGN KEY (contest_id, problem_index)
      REFERENCES problems(contest_id, problem_index) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS user_problem_overrides (
    user_id TEXT NOT NULL,
    canonical_id TEXT NOT NULL,
    solved_override INTEGER CHECK (solved_override IS NULL OR solved_override IN (0, 1)),
    note TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, canonical_id),
    FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS user_contest_results (
    user_id TEXT NOT NULL,
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
    standings_checked_at TEXT,
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
    FOREIGN KEY (contest_id, problem_index)
      REFERENCES problems(contest_id, problem_index) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS contest_rating_changes_cache (
    contest_id INTEGER PRIMARY KEY,
    raw_json TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    FOREIGN KEY (contest_id) REFERENCES contests(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS contest_performance_cache (
    contest_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    performance INTEGER,
    calculated_at TEXT NOT NULL,
    PRIMARY KEY (contest_id, user_id),
    FOREIGN KEY (contest_id) REFERENCES contests(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS contest_sync_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    cf_handle TEXT NOT NULL,
    contest_id INTEGER NOT NULL,
    priority INTEGER NOT NULL DEFAULT 100,
    status TEXT NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued', 'running', 'done', 'failed')),
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
  CREATE UNIQUE INDEX IF NOT EXISTS account_provider_account_idx
    ON "account"(providerId, accountId);
  CREATE INDEX IF NOT EXISTS verification_identifier_idx ON "verification"(identifier);
  CREATE INDEX IF NOT EXISTS idx_problems_contest ON problems(contest_id);
  CREATE INDEX IF NOT EXISTS idx_problems_canonical_id ON problems(canonical_id);
  CREATE INDEX IF NOT EXISTS idx_problems_contest_name ON problems(contest_id, name);
  CREATE INDEX IF NOT EXISTS idx_problems_needs_metadata
    ON problems(updated_at) WHERE rating IS NULL;
  CREATE INDEX IF NOT EXISTS idx_problem_tags_tag ON problem_tags(tag);
  CREATE INDEX IF NOT EXISTS idx_contests_derived
    ON contests(derived_family, derived_division);
  CREATE INDEX IF NOT EXISTS idx_contests_start_time
    ON contests(start_time_seconds DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_user_status_user_solved
    ON user_problem_status(user_id, solved);
  CREATE INDEX IF NOT EXISTS idx_user_contest_results_user
    ON user_contest_results(user_id, contest_id DESC);
  CREATE INDEX IF NOT EXISTS idx_user_contest_problem_results_user
    ON user_contest_problem_results(user_id, contest_id);
  CREATE INDEX IF NOT EXISTS idx_contest_sync_jobs_claim
    ON contest_sync_jobs(status, available_at, priority, id);
  CREATE INDEX IF NOT EXISTS idx_contest_sync_jobs_user
    ON contest_sync_jobs(user_id, status);
  CREATE INDEX IF NOT EXISTS idx_sync_runs_started_at ON sync_runs(started_at);
`;

export const migrate = (db: Db): void => {
  db.exec(SCHEMA_SQL);
};
