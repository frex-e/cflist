import type { Db } from "../connection.js";

export const startSyncRun = (
  db: Db,
  source: string,
  startedAt: string,
  userId?: string,
  cfHandle?: string,
): number => {
  if (userId !== undefined && cfHandle !== undefined) {
    const result = db
      .prepare(
        `
        INSERT INTO sync_runs (started_at, status, source, user_id, cf_handle)
        VALUES (@startedAt, 'running', @source, @userId, @cfHandle)
      `,
      )
      .run({ startedAt, source, userId, cfHandle });
    return Number(result.lastInsertRowid);
  }

  const result = db
    .prepare("INSERT INTO sync_runs (started_at, status, source) VALUES (@startedAt, 'running', @source)")
    .run({ startedAt, source });
  return Number(result.lastInsertRowid);
};

export const finishSyncRun = (
  db: Db,
  id: number,
  status: "success" | "failed",
  message: string,
  finishedAt = new Date().toISOString(),
): void => {
  db.prepare(
    `
    UPDATE sync_runs
    SET status = @status, finished_at = @finishedAt, message = @message
    WHERE id = @id
  `,
  ).run({ id, status, finishedAt, message });
};

const STUCK_USER_SYNC_MINUTES = 15;

export const resetStaleUserSyncRuns = (db: Db): number => {
  const timestamp = new Date().toISOString();
  const staleBefore = new Date(Date.now() - STUCK_USER_SYNC_MINUTES * 60 * 1000).toISOString();
  const result = db.prepare(
    `
    UPDATE sync_runs
    SET status = 'failed',
      finished_at = @timestamp,
      message = 'Reset stale running user sync after process restart or timeout'
    WHERE source = 'codeforces:user'
      AND status = 'running'
      AND finished_at IS NULL
      AND started_at <= @staleBefore
  `,
  ).run({ timestamp, staleBefore });
  return Number(result.changes);
};
