import { config } from "../../config.js";
import type { Db } from "../connection.js";
import { latestSuccessfulSyncAgeMs, problemCount } from "../queries/user.js";

export type ProblemMetadataKey = {
  contestId: number;
  problemIndex: string;
};

export const getLatestCatalogSyncRun = (
  db: Db,
): { status: string; finished_at: string | null } | undefined => {
  return db
    .prepare(
      `
      SELECT status, finished_at
      FROM sync_runs
      WHERE source = 'codeforces:catalog'
      ORDER BY id DESC
      LIMIT 1
    `,
    )
    .get() as { status: string; finished_at: string | null } | undefined;
};

export const shouldSyncCatalog = (db: Db): boolean => {
  if (problemCount(db) === 0) return true;

  const latest = getLatestCatalogSyncRun(db);
  if (latest?.status === "failed") return true;

  const maxAgeMs = config.syncIntervalMinutes * 60 * 1000;
  const age = latestSuccessfulSyncAgeMs(db);
  return age === undefined || age > maxAgeMs;
};

export const countProblemsNeedingMetadata = (db: Db): number => {
  const row = db
    .prepare(
      `
      SELECT COUNT(*) AS count
      FROM problems p
      WHERE p.rating IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM problem_tags pt
          WHERE pt.contest_id = p.contest_id
            AND pt.problem_index = p.problem_index
        )
    `,
    )
    .get() as { count: number };
  return row.count;
};

export const listProblemsNeedingMetadata = (db: Db): ProblemMetadataKey[] => {
  return db
    .prepare(
      `
      SELECT contest_id AS contestId, problem_index AS problemIndex
      FROM problems p
      WHERE p.rating IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM problem_tags pt
          WHERE pt.contest_id = p.contest_id
            AND pt.problem_index = p.problem_index
        )
    `,
    )
    .all() as ProblemMetadataKey[];
};

export const getLatestMetadataRefreshRun = (
  db: Db,
): { status: string; finished_at: string | null } | undefined => {
  return db
    .prepare(
      `
      SELECT status, finished_at
      FROM sync_runs
      WHERE source = 'codeforces:catalog-metadata'
      ORDER BY id DESC
      LIMIT 1
    `,
    )
    .get() as { status: string; finished_at: string | null } | undefined;
};

const latestSuccessfulMetadataRefreshAgeMs = (db: Db): number | undefined => {
  const row = db
    .prepare(
      `
      SELECT finished_at
      FROM sync_runs
      WHERE source = 'codeforces:catalog-metadata' AND status = 'success'
      ORDER BY id DESC
      LIMIT 1
    `,
    )
    .get() as { finished_at: string } | undefined;
  if (!row) return undefined;
  const finishedAt = Date.parse(row.finished_at);
  return Number.isFinite(finishedAt) ? Date.now() - finishedAt : undefined;
};

export const shouldRefreshProblemMetadata = (db: Db): boolean => {
  if (shouldSyncCatalog(db)) return false;
  if (countProblemsNeedingMetadata(db) === 0) return false;

  const latest = getLatestMetadataRefreshRun(db);
  if (latest?.status === "failed") return true;

  const maxAgeMs = config.syncUnratedIntervalMinutes * 60 * 1000;
  const age = latestSuccessfulMetadataRefreshAgeMs(db);
  return age === undefined || age > maxAgeMs;
};
