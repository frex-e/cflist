import type { Db } from "./connection.js";

export const migrate = (db: Db): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
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
      handle TEXT NOT NULL,
      contest_id INTEGER NOT NULL,
      problem_index TEXT NOT NULL,
      solved INTEGER NOT NULL DEFAULT 0,
      first_accepted_submission_id INTEGER,
      first_accepted_at_seconds INTEGER,
      accepted_count INTEGER NOT NULL DEFAULT 0,
      last_checked_at TEXT NOT NULL,
      PRIMARY KEY (handle, contest_id, problem_index)
    );

    CREATE TABLE IF NOT EXISTS user_problem_overrides (
      handle TEXT NOT NULL,
      contest_id INTEGER NOT NULL,
      problem_index TEXT NOT NULL,
      solved_override INTEGER,
      note TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (handle, contest_id, problem_index)
    );

    CREATE INDEX IF NOT EXISTS idx_problems_rating ON problems(rating);
    CREATE INDEX IF NOT EXISTS idx_problems_solved_count ON problems(solved_count);
    CREATE INDEX IF NOT EXISTS idx_problem_tags_tag ON problem_tags(tag);
    CREATE INDEX IF NOT EXISTS idx_contests_derived ON contests(derived_family, derived_division);
    CREATE INDEX IF NOT EXISTS idx_user_status_handle_solved ON user_problem_status(handle, solved);
    CREATE INDEX IF NOT EXISTS idx_sync_runs_started_at ON sync_runs(started_at);
  `);
};

