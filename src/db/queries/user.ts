import type { Db } from "../connection.js";
import type { FilterOptions } from "./types.js";

export const getFilterOptions = (db: Db): FilterOptions => {
  const ratings = db
    .prepare("SELECT DISTINCT rating FROM problems WHERE rating IS NOT NULL ORDER BY rating ASC")
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

export const setSolvedOverride = (
  db: Db,
  userId: string,
  contestId: number,
  problemIndex: string,
  solvedOverride: 0 | 1 | null,
  note: string | null,
): void => {
  if (solvedOverride === null && !note) {
    db.prepare(
      `
      DELETE FROM user_problem_overrides
      WHERE user_id = @userId AND contest_id = @contestId AND problem_index = @problemIndex
    `,
    ).run({ userId, contestId, problemIndex });
    return;
  }

  db.prepare(
    `
    INSERT INTO user_problem_overrides (
      user_id,
      contest_id,
      problem_index,
      solved_override,
      note,
      updated_at
    ) VALUES (
      @userId,
      @contestId,
      @problemIndex,
      @solvedOverride,
      @note,
      @updatedAt
    )
    ON CONFLICT(user_id, contest_id, problem_index) DO UPDATE SET
      solved_override = excluded.solved_override,
      note = excluded.note,
      updated_at = excluded.updated_at
  `,
  ).run({
    userId,
    contestId,
    problemIndex,
    solvedOverride,
    note,
    updatedAt: new Date().toISOString(),
  });
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
