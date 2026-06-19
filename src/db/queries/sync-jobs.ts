import type { Db } from "../connection.js";

const MAX_CONTEST_JOB_ATTEMPTS = 3;
const STUCK_USER_SYNC_MINUTES = 15;

export type ContestSyncJobCounts = {
  queued: number;
  running: number;
  done: number;
  failedRetryable: number;
  failedPermanent: number;
  total: number;
};

export type ContestSyncJobRow = {
  contest_id: number;
  status: string;
  last_error: string | null;
  attempts: number;
};

export const getContestSyncJobCounts = (db: Db, userId: string): ContestSyncJobCounts => {
  const row = db
    .prepare(
      `
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
        SUM(CASE WHEN status = 'failed' AND attempts < @maxAttempts THEN 1 ELSE 0 END) AS failed_retryable,
        SUM(CASE WHEN status = 'failed' AND attempts >= @maxAttempts THEN 1 ELSE 0 END) AS failed_permanent
      FROM contest_sync_jobs
      WHERE user_id = @userId
    `,
    )
    .get({ userId, maxAttempts: MAX_CONTEST_JOB_ATTEMPTS }) as {
    total: number;
    queued: number | null;
    running: number | null;
    done: number | null;
    failed_retryable: number | null;
    failed_permanent: number | null;
  };

  return {
    total: row.total,
    queued: row.queued ?? 0,
    running: row.running ?? 0,
    done: row.done ?? 0,
    failedRetryable: row.failed_retryable ?? 0,
    failedPermanent: row.failed_permanent ?? 0,
  };
};

export const getContestSyncJobsByContest = (db: Db, userId: string): Map<number, ContestSyncJobRow> => {
  const rows = db
    .prepare(
      `
      SELECT contest_id, status, last_error, attempts
      FROM contest_sync_jobs
      WHERE user_id = @userId
    `,
    )
    .all({ userId }) as ContestSyncJobRow[];

  return new Map(rows.map((row) => [row.contest_id, row]));
};

export const hasPendingContestSyncJobs = (counts: ContestSyncJobCounts): boolean => {
  return counts.queued + counts.running + counts.failedRetryable > 0;
};

export const isStuckUserSyncRun = (
  latestSync: { started_at: string; finished_at: string | null; status: string } | undefined,
  syncRunning: boolean,
): boolean => {
  if (!latestSync || latestSync.status !== "running" || syncRunning || latestSync.finished_at) return false;
  const startedAt = Date.parse(latestSync.started_at);
  if (!Number.isFinite(startedAt)) return false;
  return Date.now() - startedAt > STUCK_USER_SYNC_MINUTES * 60 * 1000;
};
