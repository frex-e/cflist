import { transaction, type Db } from "../../db/connection.js";
import { CodeforcesClient } from "../client.js";
import { getCodeforcesClient } from "../shared-client.js";
import { now } from "./helpers.js";
import { hydrateUserContestResult } from "./contest-hydration.js";
import { syncState } from "./state.js";

const MAX_CONTEST_JOB_ATTEMPTS = 3;
const MAX_CONTEST_JOBS_PER_KICK = 3;
const STALE_CONTEST_JOB_MINUTES = 30;
const PERMANENT_FAILED_RETRY_HOURS = 24;

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
  const existingJob = db.prepare(`
    SELECT status, priority
    FROM contest_sync_jobs
    WHERE user_id = @userId AND contest_id = @contestId
  `);
  const bumpPriority = db.prepare(`
    UPDATE contest_sync_jobs
    SET priority = @priority,
      cf_handle = @cfHandle,
      updated_at = @updatedAt
    WHERE user_id = @userId
      AND contest_id = @contestId
      AND priority > @priority
  `);
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
      const existing = existingJob.get({ userId, contestId: job.contestId }) as
        | { status: string; priority: number }
        | undefined;
      // Already pending — keep it in flight; only tighten priority if needed.
      if (existing?.status === "queued" || existing?.status === "running") {
        bumpPriority.run({
          userId,
          cfHandle,
          contestId: job.contestId,
          priority: job.priority,
          updatedAt: timestamp,
        });
        continue;
      }

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

const requeuePermanentFailedContestJobs = (db: Db): void => {
  const timestamp = now();
  const retryBefore = new Date(Date.now() - PERMANENT_FAILED_RETRY_HOURS * 60 * 60 * 1000).toISOString();
  db.prepare(
    `
    UPDATE contest_sync_jobs
    SET status = 'queued',
      attempts = 0,
      available_at = @timestamp,
      updated_at = @timestamp,
      finished_at = NULL,
      last_error = 'Requeued permanently failed contest sync job for retry'
    WHERE status = 'failed'
      AND attempts >= @maxAttempts
      AND finished_at IS NOT NULL
      AND finished_at <= @retryBefore
  `,
  ).run({ timestamp, retryBefore, maxAttempts: MAX_CONTEST_JOB_ATTEMPTS });
};

export const requeueFailedContestJobsForUser = (db: Db, userId: string): number => {
  const timestamp = now();
  const result = db.prepare(
    `
    UPDATE contest_sync_jobs
    SET status = 'queued',
      attempts = 0,
      available_at = @timestamp,
      updated_at = @timestamp,
      finished_at = NULL,
      last_error = 'Requeued failed contest sync job after manual sync'
    WHERE user_id = @userId
      AND status = 'failed'
  `,
  ).run({ userId, timestamp });
  return Number(result.changes);
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
  client: CodeforcesClient = getCodeforcesClient(),
  options: { maxJobs?: number } = {},
): Promise<number> => {
  if (syncState.contestQueueRunning) return 0;

  syncState.contestQueueRunning = true;
  let processed = 0;
  try {
    resetStaleContestJobs(db);
    requeuePermanentFailedContestJobs(db);
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

export const drainContestSyncJobs = async (
  db: Db,
  client: CodeforcesClient,
  maxJobs: number,
): Promise<number> => {
  let total = 0;
  let remaining = maxJobs;
  while (remaining > 0) {
    const processed = await runContestSyncQueue(db, client, { maxJobs: remaining });
    if (processed === 0) break;
    total += processed;
    remaining -= processed;
  }
  return total;
};

export const kickContestSyncQueue = (db: Db, client: CodeforcesClient = getCodeforcesClient()): void => {
  void runContestSyncQueue(db, client, { maxJobs: MAX_CONTEST_JOBS_PER_KICK }).catch((error) => {
    console.error("Contest sync queue failed:", error);
  });
};
