import type { Db } from "../connection.js";
import type { FilterOptions } from "./types.js";

export const getFilterOptions = (db: Db): FilterOptions => {
  const ratings = db
    .prepare(
      `
      SELECT DISTINCT COALESCE(rating, estimated_rating) AS rating
      FROM problems
      WHERE COALESCE(rating, estimated_rating) IS NOT NULL
      ORDER BY rating ASC
    `,
    )
    .all()
    .map((row) => (row as { rating: number }).rating);

  const tags = db
    .prepare("SELECT DISTINCT tag FROM problem_tags ORDER BY tag COLLATE NOCASE ASC")
    .all()
    .map((row) => (row as { tag: string }).tag);

  const contestFamilies = db
    .prepare(
      "SELECT DISTINCT derived_family FROM contests WHERE derived_family IS NOT NULL ORDER BY derived_family COLLATE NOCASE ASC",
    )
    .all()
    .map((row) => (row as { derived_family: string }).derived_family);

  const divisions = db
    .prepare(
      "SELECT DISTINCT derived_division FROM contests WHERE derived_division IS NOT NULL ORDER BY derived_division COLLATE NOCASE ASC",
    )
    .all()
    .map((row) => (row as { derived_division: string }).derived_division);

  return { ratings, tags, contestFamilies, divisions };
};

export const getLatestSyncRun = (db: Db): { started_at: string; finished_at: string | null; status: string; message: string | null } | undefined => {
  return db
    .prepare(
      "SELECT started_at, finished_at, status, message FROM sync_runs ORDER BY id DESC LIMIT 1",
    )
    .get() as { started_at: string; finished_at: string | null; status: string; message: string | null } | undefined;
};

export const getLatestUserSyncRun = (
  db: Db,
  userId: string,
): { started_at: string; finished_at: string | null; status: string; message: string | null } | undefined => {
  return db
    .prepare(
      `
      SELECT started_at, finished_at, status, message
      FROM sync_runs
      WHERE source = 'codeforces:user' AND user_id = @userId
      ORDER BY id DESC
      LIMIT 1
    `,
    )
    .get({ userId }) as { started_at: string; finished_at: string | null; status: string; message: string | null } | undefined;
};

export const hasSuccessfulUserSyncRun = (db: Db, userId: string): boolean => {
  const row = db
    .prepare(
      `
      SELECT 1 AS found
      FROM sync_runs
      WHERE source = 'codeforces:user' AND user_id = @userId AND status = 'success'
      LIMIT 1
    `,
    )
    .get({ userId }) as { found: number } | undefined;

  return Boolean(row);
};

export type ManualUserSyncCooldown =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number; lastFinishedAt: string };

export const getManualUserSyncCooldown = (
  db: Db,
  userId: string,
  intervalMs: number,
  nowMs: number = Date.now(),
): ManualUserSyncCooldown => {
  if (intervalMs <= 0) return { allowed: true };

  const row = db
    .prepare(
      `
      SELECT finished_at
      FROM sync_runs
      WHERE source = 'codeforces:user'
        AND user_id = @userId
        AND status = 'success'
        AND finished_at IS NOT NULL
      ORDER BY id DESC
      LIMIT 1
    `,
    )
    .get({ userId }) as { finished_at: string } | undefined;

  if (!row) return { allowed: true };

  const finishedAt = Date.parse(row.finished_at);
  if (!Number.isFinite(finishedAt)) return { allowed: true };

  const elapsed = nowMs - finishedAt;
  if (elapsed >= intervalMs) return { allowed: true };

  return {
    allowed: false,
    retryAfterMs: Math.max(0, intervalMs - elapsed),
    lastFinishedAt: row.finished_at,
  };
};

export type AuthUserRow = {
  id: string;
  name: string;
  email: string;
  cfHandle: string;
};

export const getAuthUserRow = (db: Db, userId: string): AuthUserRow | undefined => {
  return db
    .prepare(
      `
      SELECT id, name, email, cfHandle
      FROM "user"
      WHERE id = @userId
    `,
    )
    .get({ userId }) as AuthUserRow | undefined;
};

export type AutoSyncUser = {
  id: string;
  cfHandle: string;
};

export const listActiveUsersDueForDailySync = (
  db: Db,
  options: {
    activeWithinMs: number;
    minSyncAgeMs: number;
    nowMs?: number;
    limit?: number;
  },
): AutoSyncUser[] => {
  const nowMs = options.nowMs ?? Date.now();
  const activeCutoff = new Date(nowMs - options.activeWithinMs).toISOString();
  const syncCutoff = new Date(nowMs - options.minSyncAgeMs).toISOString();
  const nowIso = new Date(nowMs).toISOString();
  const limit = Math.max(0, options.limit ?? Number.MAX_SAFE_INTEGER);

  return db
    .prepare(
      `
      SELECT u.id AS id, u.cfHandle AS cfHandle
      FROM "user" u
      WHERE TRIM(u.cfHandle) != ''
        AND EXISTS (
          SELECT 1
          FROM "session" s
          WHERE s.userId = u.id
            AND s.updatedAt >= @activeCutoff
            AND s.expiresAt > @nowIso
        )
        AND NOT EXISTS (
          SELECT 1
          FROM sync_runs r
          WHERE r.user_id = u.id
            AND r.source = 'codeforces:user'
            AND r.status = 'success'
            AND r.finished_at IS NOT NULL
            AND r.finished_at >= @syncCutoff
        )
      ORDER BY (
        SELECT MAX(r.finished_at)
        FROM sync_runs r
        WHERE r.user_id = u.id
          AND r.source = 'codeforces:user'
          AND r.status = 'success'
          AND r.finished_at IS NOT NULL
      ) ASC NULLS FIRST
      LIMIT @limit
    `,
    )
    .all({ activeCutoff, syncCutoff, nowIso, limit }) as AutoSyncUser[];
};

export const listUsersNeedingPostContestSync = (
  db: Db,
  options: {
    lookbackMs: number;
    nowMs?: number;
    limit?: number;
  },
): AutoSyncUser[] => {
  const nowMs = options.nowMs ?? Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  const lookbackCutoffSeconds = Math.floor((nowMs - options.lookbackMs) / 1000);
  const limit = Math.max(0, options.limit ?? Number.MAX_SAFE_INTEGER);

  return db
    .prepare(
      `
      SELECT u.id AS id, u.cfHandle AS cfHandle
      FROM "user" u
      WHERE TRIM(u.cfHandle) != ''
        AND EXISTS (
          SELECT 1
          FROM user_contest_results ucr
          JOIN contests c ON c.id = ucr.contest_id
          WHERE ucr.user_id = u.id
            AND c.start_time_seconds IS NOT NULL
            AND c.duration_seconds IS NOT NULL
            AND (c.start_time_seconds + c.duration_seconds) <= @nowSeconds
            AND (c.start_time_seconds + c.duration_seconds) > @lookbackCutoffSeconds
            AND COALESCE(
              (
                SELECT unixepoch(r.finished_at)
                FROM sync_runs r
                WHERE r.user_id = u.id
                  AND r.source = 'codeforces:user'
                  AND r.status = 'success'
                  AND r.finished_at IS NOT NULL
                ORDER BY r.id DESC
                LIMIT 1
              ),
              0
            ) < (c.start_time_seconds + c.duration_seconds)
        )
      ORDER BY (
        SELECT MAX(r.finished_at)
        FROM sync_runs r
        WHERE r.user_id = u.id
          AND r.source = 'codeforces:user'
          AND r.status = 'success'
          AND r.finished_at IS NOT NULL
      ) ASC NULLS FIRST
      LIMIT @limit
    `,
    )
    .all({ nowSeconds, lookbackCutoffSeconds, limit }) as AutoSyncUser[];
};

export const problemCount = (db: Db): number => {
  const row = db.prepare("SELECT COUNT(*) AS count FROM problems").get() as { count: number };
  return row.count;
};

export const latestSuccessfulSyncAgeMs = (db: Db): number | undefined => {
  const row = db
    .prepare("SELECT finished_at FROM sync_runs WHERE source = 'codeforces:catalog' AND status = 'success' ORDER BY id DESC LIMIT 1")
    .get() as { finished_at: string } | undefined;
  if (!row) return undefined;
  const finishedAt = Date.parse(row.finished_at);
  return Number.isFinite(finishedAt) ? Date.now() - finishedAt : undefined;
};

export type LocalProblemStatus = "solved" | "skipped" | null;

export const setProblemOverride = (
  db: Db,
  userId: string,
  contestId: number,
  problemIndex: string,
  localStatus: LocalProblemStatus,
  note: string | null,
): void => {
  const canonicalRow = db
    .prepare(
      `
      SELECT canonical_id AS canonicalId
      FROM problems
      WHERE contest_id = @contestId AND problem_index = @problemIndex
    `,
    )
    .get({ contestId, problemIndex }) as { canonicalId: string } | undefined;

  if (!canonicalRow) return;

  const { canonicalId } = canonicalRow;
  const solvedOverride = localStatus === "solved" ? 1 : null;
  const skipped = localStatus === "skipped" ? 1 : 0;

  if (localStatus === null && !note) {
    db.prepare(
      `
      DELETE FROM user_problem_overrides
      WHERE user_id = @userId AND canonical_id = @canonicalId
    `,
    ).run({ userId, canonicalId });
    return;
  }

  db.prepare(
    `
    INSERT INTO user_problem_overrides (
      user_id,
      canonical_id,
      solved_override,
      skipped,
      note,
      updated_at
    ) VALUES (
      @userId,
      @canonicalId,
      @solvedOverride,
      @skipped,
      @note,
      @updatedAt
    )
    ON CONFLICT(user_id, canonical_id) DO UPDATE SET
      solved_override = excluded.solved_override,
      skipped = excluded.skipped,
      note = excluded.note,
      updated_at = excluded.updated_at
  `,
  ).run({
    userId,
    canonicalId,
    solvedOverride,
    skipped,
    note,
    updatedAt: new Date().toISOString(),
  });
};

/** @deprecated Prefer setProblemOverride; kept for callers that only toggle solved. */
export const setSolvedOverride = (
  db: Db,
  userId: string,
  contestId: number,
  problemIndex: string,
  solvedOverride: 0 | 1 | null,
  note: string | null,
): void => {
  setProblemOverride(db, userId, contestId, problemIndex, solvedOverride === 1 ? "solved" : null, note);
};

export const getDefaultFilterQuery = (db: Db, userId: string): string | undefined => {
  const row = db
    .prepare("SELECT query FROM user_default_filters WHERE user_id = @userId")
    .get({ userId }) as { query: string } | undefined;
  return row?.query;
};

export const setDefaultFilterQuery = (db: Db, userId: string, query: string): void => {
  if (!query) {
    db.prepare("DELETE FROM user_default_filters WHERE user_id = @userId").run({ userId });
    return;
  }

  db.prepare(
    `
    INSERT INTO user_default_filters (user_id, query, updated_at)
    VALUES (@userId, @query, @updatedAt)
    ON CONFLICT(user_id) DO UPDATE SET
      query = excluded.query,
      updated_at = excluded.updated_at
  `,
  ).run({ userId, query, updatedAt: new Date().toISOString() });
};
