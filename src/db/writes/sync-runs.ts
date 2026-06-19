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
