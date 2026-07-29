import { backfillUserContestPerformances } from "../cf/sync/cache.js";
import {
  backfillCanonicalIds,
  linkCanonicalIdsByRoundPairs,
  refreshRoundPairs,
} from "../cf/sync/canonical-problems.js";
import type { Db } from "./connection.js";
import { cleanupOrphanRows } from "./migrate-audit.js";

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
    CREATE INDEX IF NOT EXISTS idx_contests_start_time ON contests(start_time_seconds DESC, id DESC);
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

const columnExists = (db: Db, table: string, column: string): boolean => {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((row) => row.name === column);
};

const migrateOverridesToCanonical = (db: Db): void => {
  db.exec(`
    CREATE TABLE user_problem_overrides_new (
      user_id TEXT NOT NULL,
      canonical_id TEXT NOT NULL,
      solved_override INTEGER CHECK (solved_override IS NULL OR solved_override IN (0, 1)),
      note TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, canonical_id),
      FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    INSERT INTO user_problem_overrides_new (user_id, canonical_id, solved_override, note, updated_at)
    SELECT
      merged.user_id,
      merged.canonical_id,
      merged.solved_override,
      (
        SELECT u.note
        FROM user_problem_overrides u
        JOIN problems p ON p.contest_id = u.contest_id AND p.problem_index = u.problem_index
        WHERE u.user_id = merged.user_id
          AND p.canonical_id = merged.canonical_id
        ORDER BY u.updated_at DESC
        LIMIT 1
      ) AS note,
      merged.updated_at
    FROM (
      SELECT
        u.user_id,
        p.canonical_id,
        MAX(u.solved_override) AS solved_override,
        MAX(u.updated_at) AS updated_at
      FROM user_problem_overrides u
      JOIN problems p ON p.contest_id = u.contest_id AND p.problem_index = u.problem_index
      GROUP BY u.user_id, p.canonical_id
    ) merged
  `);

  db.exec(`DROP TABLE user_problem_overrides`);
  db.exec(`ALTER TABLE user_problem_overrides_new RENAME TO user_problem_overrides`);
};

const applyCanonicalMigration = (db: Db): void => {
  if (currentVersion(db) >= 6) return;
  if (!tableExists(db, "problems")) {
    recordMigration(db, 6);
    return;
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS contest_round_pairs (
      contest_id_low INTEGER NOT NULL,
      contest_id_high INTEGER NOT NULL,
      start_time_seconds INTEGER NOT NULL,
      PRIMARY KEY (contest_id_low, contest_id_high),
      FOREIGN KEY (contest_id_low) REFERENCES contests(id) ON DELETE CASCADE,
      FOREIGN KEY (contest_id_high) REFERENCES contests(id) ON DELETE CASCADE
    )
  `);

  if (!columnExists(db, "problems", "canonical_id")) {
    db.exec(`ALTER TABLE problems ADD COLUMN canonical_id TEXT`);
  }

  backfillCanonicalIds(db);

  db.exec(`
    UPDATE problems
    SET canonical_id = lower(hex(randomblob(16)))
    WHERE canonical_id IS NULL OR canonical_id = ''
  `);

  if (columnExists(db, "user_problem_overrides", "contest_id")) {
    migrateOverridesToCanonical(db);
  }

  recordMigration(db, 6);
};

const applyIntegrityMigration = (db: Db): void => {
  if (currentVersion(db) >= 7) return;
  if (!tableExists(db, "problems")) {
    recordMigration(db, 7);
    return;
  }

  cleanupOrphanRows(db);

  db.exec("PRAGMA foreign_keys = OFF");

  try {
  if (columnExists(db, "contest_performance_cache", "handle_key") && tableExists(db, "user_contest_results")) {
    db.exec(`
      CREATE TABLE contest_performance_cache_new (
        contest_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        performance INTEGER,
        calculated_at TEXT NOT NULL,
        PRIMARY KEY (contest_id, user_id),
        FOREIGN KEY (contest_id) REFERENCES contests(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE
      )
    `);
    const handleJoin = columnExists(db, "user_contest_results", "cf_handle")
      ? "AND lower(ucr.cf_handle) = cpc.handle_key"
      : "AND ucr.user_id IS NOT NULL";
    db.exec(`
      INSERT INTO contest_performance_cache_new (contest_id, user_id, performance, calculated_at)
      SELECT cpc.contest_id, ucr.user_id, cpc.performance, cpc.calculated_at
      FROM contest_performance_cache cpc
      JOIN user_contest_results ucr
        ON ucr.contest_id = cpc.contest_id
        ${handleJoin}
    `);
    db.exec(`DROP TABLE contest_performance_cache`);
    db.exec(`ALTER TABLE contest_performance_cache_new RENAME TO contest_performance_cache`);
  }

  const problemsetNameSelect = columnExists(db, "problems", "problemset_name")
    ? "problemset_name"
    : "NULL AS problemset_name";
  const typeSelect = columnExists(db, "problems", "type") ? "type" : "NULL AS type";
  const pointsSelect = columnExists(db, "problems", "points") ? "points" : "NULL AS points";

  db.exec(`
    CREATE TABLE problems_new (
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
    )
  `);
  db.exec(`
    INSERT INTO problems_new (
      contest_id, problemset_name, problem_index, name, type, points, rating,
      solved_count, tags_json, url, raw_json, updated_at, canonical_id
    )
    SELECT
      contest_id, ${problemsetNameSelect}, problem_index, name, ${typeSelect}, ${pointsSelect}, rating,
      solved_count, tags_json, url, raw_json, updated_at, canonical_id
    FROM problems
  `);
  db.exec(`DROP TABLE problems`);
  db.exec(`ALTER TABLE problems_new RENAME TO problems`);

  if (tableExists(db, "user_problem_status")) {
    db.exec(`
      CREATE TABLE user_problem_status_new (
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
        FOREIGN KEY (contest_id, problem_index) REFERENCES problems(contest_id, problem_index) ON DELETE CASCADE
      )
    `);
    db.exec(`
      INSERT INTO user_problem_status_new (
        user_id, contest_id, problem_index, solved, first_accepted_submission_id,
        first_accepted_at_seconds, accepted_count, last_checked_at
      )
      SELECT
        user_id, contest_id, problem_index, solved, first_accepted_submission_id,
        first_accepted_at_seconds, accepted_count, last_checked_at
      FROM user_problem_status
    `);
    db.exec(`DROP TABLE user_problem_status`);
    db.exec(`ALTER TABLE user_problem_status_new RENAME TO user_problem_status`);
  }

  if (tableExists(db, "user_contest_results")) {
    db.exec(`
      CREATE TABLE user_contest_results_new (
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
        PRIMARY KEY (user_id, contest_id),
        FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE,
        FOREIGN KEY (contest_id) REFERENCES contests(id) ON DELETE CASCADE
      )
    `);
    db.exec(`
      INSERT INTO user_contest_results_new (
        user_id, contest_id, rank, points, penalty, participant_type,
        old_rating, new_rating, rating_delta, performance, last_checked_at
      )
      SELECT
        user_id, contest_id, rank, points, penalty, participant_type,
        old_rating, new_rating, rating_delta, performance, last_checked_at
      FROM user_contest_results
    `);
    db.exec(`DROP TABLE user_contest_results`);
    db.exec(`ALTER TABLE user_contest_results_new RENAME TO user_contest_results`);
  }

  if (tableExists(db, "sync_runs")) {
    db.exec(`
      CREATE TABLE sync_runs_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')),
        source TEXT NOT NULL,
        user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
        cf_handle TEXT,
        message TEXT
      )
    `);
    db.exec(`
      INSERT INTO sync_runs_new (
        id, started_at, finished_at, status, source, user_id, cf_handle, message
      )
      SELECT id, started_at, finished_at, status, source, user_id, cf_handle, message
      FROM sync_runs
    `);
    db.exec(`DROP TABLE sync_runs`);
    db.exec(`ALTER TABLE sync_runs_new RENAME TO sync_runs`);
  }

  if (tableExists(db, "contest_sync_jobs")) {
    db.exec(`
      CREATE TABLE contest_sync_jobs_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        cf_handle TEXT NOT NULL,
        contest_id INTEGER NOT NULL,
        priority INTEGER NOT NULL DEFAULT 100,
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
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
      )
    `);
    db.exec(`
      INSERT INTO contest_sync_jobs_new (
        id, user_id, cf_handle, contest_id, priority, status, attempts, available_at,
        started_at, finished_at, last_error, created_at, updated_at
      )
      SELECT
        id, user_id, cf_handle, contest_id, priority, status, attempts, available_at,
        started_at, finished_at, last_error, created_at, updated_at
      FROM contest_sync_jobs
    `);
    db.exec(`DROP TABLE contest_sync_jobs`);
    db.exec(`ALTER TABLE contest_sync_jobs_new RENAME TO contest_sync_jobs`);
  }

  if (tableExists(db, "account") && !db.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name='account_provider_account_idx'`).get()) {
    db.exec(`CREATE UNIQUE INDEX account_provider_account_idx ON "account"(providerId, accountId)`);
  }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_problems_contest ON problems(contest_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_problems_canonical_id ON problems(canonical_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_problems_contest_name ON problems(contest_id, name)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_problems_needs_metadata ON problems(updated_at) WHERE rating IS NULL`);
  if (tableExists(db, "contests")) {
    const contestColumns = db.prepare("PRAGMA table_info(contests)").all() as { name: string }[];
    if (contestColumns.some((column) => column.name === "start_time_seconds")) {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_contests_start_time ON contests(start_time_seconds DESC, id DESC)`);
    }
  }
  if (tableExists(db, "user_problem_status")) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_user_status_user_solved ON user_problem_status(user_id, solved)`);
  }
  if (tableExists(db, "user_contest_results")) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_user_contest_results_user ON user_contest_results(user_id, contest_id DESC)`);
  }
  if (tableExists(db, "contest_sync_jobs")) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_contest_sync_jobs_claim ON contest_sync_jobs(status, available_at, priority, id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_contest_sync_jobs_user ON contest_sync_jobs(user_id, status)`);
  }
  if (tableExists(db, "sync_runs")) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sync_runs_started_at ON sync_runs(started_at)`);
  }

  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }

  recordMigration(db, 7);
};

const applyCanonicalRoundPairFixMigration = (db: Db): void => {
  if (currentVersion(db) >= 8) return;
  if (!tableExists(db, "contest_round_pairs") || !tableExists(db, "problems")) {
    recordMigration(db, 8);
    return;
  }

  refreshRoundPairs(db);
  linkCanonicalIdsByRoundPairs(db);

  recordMigration(db, 8);
};

const applyFilteredStandingsMigration = (db: Db): void => {
  if (currentVersion(db) >= 9) return;

  if (tableExists(db, "user_contest_results")) {
    if (!columnExists(db, "user_contest_results", "standings_checked_at")) {
      db.exec(`ALTER TABLE user_contest_results ADD COLUMN standings_checked_at TEXT`);
    }

    const cachedTimestamp = tableExists(db, "contest_standings_cache")
      ? `(
          SELECT csc.fetched_at
          FROM contest_standings_cache csc
          WHERE csc.contest_id = user_contest_results.contest_id
        )`
      : "NULL";
    db.exec(`
      UPDATE user_contest_results
      SET standings_checked_at = COALESCE(${cachedTimestamp}, last_checked_at)
      WHERE standings_checked_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM user_contest_problem_results ucpr
          WHERE ucpr.user_id = user_contest_results.user_id
            AND ucpr.contest_id = user_contest_results.contest_id
        )
    `);
  }

  if (tableExists(db, "contest_standings_cache")) {
    db.exec(`DROP TABLE contest_standings_cache`);
  }

  recordMigration(db, 9);
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
  applyCanonicalMigration(db);
  applyIntegrityMigration(db);
  applyCanonicalRoundPairFixMigration(db);
  applyFilteredStandingsMigration(db);
};
