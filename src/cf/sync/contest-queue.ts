import { transaction, type Db } from "../../db/connection.js";
import { CodeforcesClient } from "../client.js";
import { now } from "./helpers.js";
import { hydrateUserContestResult } from "./contest-hydration.js";
import { syncState } from "./state.js";

const MAX_CONTEST_JOB_ATTEMPTS = 3;
const MAX_CONTEST_JOBS_PER_KICK = 3;
const STALE_CONTEST_JOB_MINUTES = 30;

type ContestJob = {
  id: number;
  user_id: string;
  cf_handle: string;
  contest_id: number;
  attempts: number;
};

export type ContestHydrationJob = {
  contestId: number;
  priority: number;
};

export const enqueueContestHydrationJobs = (
  db: Db,
  userId: string,
  cfHandle: string,
  jobs: ContestHydrationJob[],
): number => {
  const timestamp = now();
  const upsert = db.prepare(`
    INSERT INTO contest_sync_jobs (
      user_id,
      cf_handle,
      contest_id,
      priority,
      status,
      attempts,
      available_at,
      created_at,
      updated_at
    ) VALUES (
      @userId,
      @cfHandle,
      @contestId,
      @priority,
      'queued',
      0,
      @availableAt,
      @createdAt,
      @updatedAt
    )
    ON CONFLICT(user_id, contest_id) DO UPDATE SET
      cf_handle = excluded.cf_handle,
      priority = MIN(contest_sync_jobs.priority, excluded.priority),
      status = CASE
        WHEN contest_sync_jobs.status = 'running' THEN contest_sync_jobs.status
        ELSE 'queued'
      END,
      attempts = CASE
        WHEN contest_sync_jobs.status = 'running' THEN contest_sync_jobs.attempts
        ELSE 0
      END,
      available_at = excluded.available_at,
      updated_at = excluded.updated_at,
      last_error = CASE
        WHEN contest_sync_jobs.status = 'running' THEN contest_sync_jobs.last_error
        ELSE NULL
      END
  `);

  let changedRows = 0;
  transaction(db, () => {
    for (const job of jobs) {
      const result = upsert.run({
        userId,
        cfHandle,
        contestId: job.contestId,
        priority: job.priority,
        availableAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      changedRows += Number(result.changes);
    }
  });

  return changedRows;
};

const claimContestJob = (db: Db): ContestJob | undefined => {
  const timestamp = now();
  const job = db
    .prepare(
      `
      SELECT id, user_id, cf_handle, contest_id, attempts
      FROM contest_sync_jobs
      WHERE status IN ('queued', 'failed')
        AND attempts < @maxAttempts
        AND available_at <= @timestamp
      ORDER BY priority ASC, id ASC
      LIMIT 1
    `,
    )
    .get({ maxAttempts: MAX_CONTEST_JOB_ATTEMPTS, timestamp }) as ContestJob | undefined;
  if (!job) return undefined;

  db.prepare(
    `
    UPDATE contest_sync_jobs
    SET status = 'running',
      attempts = attempts + 1,
      started_at = @startedAt,
      updated_at = @startedAt
    WHERE id = @id
  `,
  ).run({ id: job.id, startedAt: timestamp });

  return { ...job, attempts: job.attempts + 1 };
};

const resetStaleContestJobs = (db: Db): void => {
  const timestamp = now();
  const staleBefore = new Date(Date.now() - STALE_CONTEST_JOB_MINUTES * 60 * 1000).toISOString();
  db.prepare(
    `
    UPDATE contest_sync_jobs
    SET status = 'queued',
      available_at = @timestamp,
      updated_at = @timestamp,
      last_error = 'Reset stale running contest sync job after process restart'
    WHERE status = 'running'
      AND started_at IS NOT NULL
      AND started_at <= @staleBefore
  `,
  ).run({ timestamp, staleBefore });
};

const finishContestJob = (db: Db, id: number): void => {
  const timestamp = now();
  db.prepare(
    `
    UPDATE contest_sync_jobs
    SET status = 'done',
      finished_at = @finishedAt,
      updated_at = @finishedAt,
      last_error = NULL
    WHERE id = @id
  `,
  ).run({ id, finishedAt: timestamp });
};

const failContestJob = (db: Db, job: ContestJob, error: unknown): void => {
  const timestamp = now();
  const delayMinutes = Math.min(60, Math.max(1, job.attempts) * 5);
  const availableAt = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();
  const message = error instanceof Error ? error.message : String(error);
  db.prepare(
    `
    UPDATE contest_sync_jobs
    SET status = 'failed',
      available_at = @availableAt,
      finished_at = @finishedAt,
      updated_at = @finishedAt,
      last_error = @message
    WHERE id = @id
  `,
  ).run({ id: job.id, availableAt, finishedAt: timestamp, message });
};

export const runContestSyncQueue = async (
  db: Db,
  client = new CodeforcesClient(),
  options: { maxJobs?: number } = {},
): Promise<number> => {
  if (syncState.contestQueueRunning) return 0;

  syncState.contestQueueRunning = true;
  let processed = 0;
  try {
    resetStaleContestJobs(db);
    while (options.maxJobs === undefined || processed < options.maxJobs) {
      const job = claimContestJob(db);
      if (!job) break;

      try {
        await hydrateUserContestResult(db, job.user_id, job.cf_handle, job.contest_id, client);
        finishContestJob(db, job.id);
      } catch (error) {
        failContestJob(db, job, error);
        console.error(`Contest sync job ${job.id} failed:`, error);
      }
      processed += 1;
    }
  } finally {
    syncState.contestQueueRunning = false;
  }

  return processed;
};

export const kickContestSyncQueue = (db: Db, client = new CodeforcesClient()): void => {
  void runContestSyncQueue(db, client, { maxJobs: MAX_CONTEST_JOBS_PER_KICK }).catch((error) => {
    console.error("Contest sync queue failed:", error);
  });
};
