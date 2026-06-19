import { transaction, type Db } from "../../db/connection.js";
import { finishSyncRun, startSyncRun } from "../../db/writes/sync-runs.js";
import { latestSuccessfulSyncAgeMs, problemCount } from "../../db/queries.js";
import { config } from "../../config.js";
import {
  acceptedProblemsFromSubmissions,
} from "../accepted-problems.js";
import { CodeforcesClient } from "../client.js";
import type { CfRatingChange } from "../types.js";
import { getCachedStandings } from "./cache.js";
import { syncCatalog } from "./catalog.js";
import { enqueueContestHydrationJobs } from "./contest-queue.js";
import { recomputeExistingUpsolvesForUser } from "./contest-hydration.js";
import { contestSortValue, ensureContestsExist, loadContestsById, now } from "./helpers.js";
import { syncState } from "./state.js";

const MAX_CONTEST_RESULTS_ENQUEUE = 30;
const MAX_CONTEST_RESULTS_BACKFILL_ENQUEUE = 3;

const maybeSyncCatalog = async (db: Db, client: CodeforcesClient): Promise<void> => {
  const maxAgeMs = config.syncIntervalMinutes * 60 * 1000;
  const age = latestSuccessfulSyncAgeMs(db);
  const shouldSync = problemCount(db) === 0 || age === undefined || age > maxAgeMs;
  if (!shouldSync) return;
  await syncCatalog(db, client);
};

const writeBasicContestResults = (
  db: Db,
  userId: string,
  cfHandle: string,
  contestIds: number[],
  ratingsByContestId: Map<number, CfRatingChange>,
  checkedAt: string,
): void => {
  const upsert = db.prepare(`
    INSERT INTO user_contest_results (
      user_id,
      cf_handle,
      contest_id,
      rank,
      points,
      penalty,
      participant_type,
      old_rating,
      new_rating,
      rating_delta,
      performance,
      last_checked_at
    ) VALUES (
      @userId,
      @cfHandle,
      @contestId,
      @rank,
      NULL,
      NULL,
      NULL,
      @oldRating,
      @newRating,
      @ratingDelta,
      NULL,
      @checkedAt
    )
    ON CONFLICT(user_id, contest_id) DO UPDATE SET
      cf_handle = excluded.cf_handle,
      rank = COALESCE(excluded.rank, user_contest_results.rank),
      old_rating = COALESCE(excluded.old_rating, user_contest_results.old_rating),
      new_rating = COALESCE(excluded.new_rating, user_contest_results.new_rating),
      rating_delta = COALESCE(excluded.rating_delta, user_contest_results.rating_delta),
      last_checked_at = excluded.last_checked_at
  `);

  transaction(db, () => {
    for (const contestId of contestIds) {
      const ratingChange = ratingsByContestId.get(contestId);
      upsert.run({
        userId,
        cfHandle,
        contestId,
        rank: ratingChange?.rank ?? null,
        oldRating: ratingChange?.oldRating ?? null,
        newRating: ratingChange?.newRating ?? null,
        ratingDelta: ratingChange ? ratingChange.newRating - ratingChange.oldRating : null,
        checkedAt,
      });
    }
  });
};

const completedContestProblemCounts = (db: Db, userId: string): Map<number, number> => {
  const rows = db.prepare(`
    SELECT
      ucr.contest_id,
      COUNT(ucpr.problem_index) AS problem_count
    FROM user_contest_results ucr
    LEFT JOIN user_contest_problem_results ucpr
      ON ucpr.user_id = ucr.user_id
      AND ucpr.contest_id = ucr.contest_id
    WHERE ucr.user_id = @userId
    GROUP BY ucr.contest_id
  `).all({ userId }) as { contest_id: number; problem_count: number }[];

  return new Map(rows.map((row) => [row.contest_id, row.problem_count]));
};

export const syncUserStatus = async (
  db: Db,
  userId: string,
  cfHandle: string,
  client = new CodeforcesClient(),
): Promise<void> => {
  if (syncState.userRunning.has(userId)) return;

  syncState.userRunning.add(userId);
  const startedAt = now();
  const syncRunId = startSyncRun(db, "codeforces:user", startedAt, userId, cfHandle);

  try {
    await maybeSyncCatalog(db, client);

    const contestsById = loadContestsById(db);
    const submissions = await client.userStatus(cfHandle);
    const accepted = acceptedProblemsFromSubmissions(submissions, contestsById);
    const ratingHistory = await client.userRating(cfHandle);
    const ratingsByContestId = new Map(ratingHistory.map((change) => [change.contestId, change]));
    const candidateContestIds = new Set(ratingHistory.map((change) => change.contestId));
    for (const item of accepted.values()) {
      candidateContestIds.add(item.contestId);
    }

    const checkedAt = now();
    ensureContestsExist(db, [...candidateContestIds], ratingsByContestId, contestsById, checkedAt);

    const sortedCandidateContestIds = [...candidateContestIds]
      .sort((a, b) => contestSortValue(contestsById.get(b), ratingsByContestId.get(b)) - contestSortValue(contestsById.get(a), ratingsByContestId.get(a)));
    const problemCountsByContestId = completedContestProblemCounts(db, userId);
    const completedContestIds = new Set(
      [...problemCountsByContestId.entries()]
        .filter(([, problemCount]) => problemCount > 0)
        .map(([contestId]) => contestId),
    );
    const recentContestIds = sortedCandidateContestIds.slice(0, MAX_CONTEST_RESULTS_ENQUEUE);
    const recentContestIdSet = new Set(recentContestIds);
    const backfillContestIds = sortedCandidateContestIds
      .slice(MAX_CONTEST_RESULTS_ENQUEUE)
      .filter((contestId) => !recentContestIdSet.has(contestId) && !completedContestIds.has(contestId))
      .slice(0, MAX_CONTEST_RESULTS_BACKFILL_ENQUEUE);

    const clearStatus = db.prepare("DELETE FROM user_problem_status WHERE user_id = @userId");
    const insertStatus = db.prepare(`
      INSERT INTO user_problem_status (
        user_id,
        cf_handle,
        contest_id,
        problem_index,
        solved,
        first_accepted_submission_id,
        first_accepted_at_seconds,
        accepted_count,
        last_checked_at
      ) VALUES (
        @userId,
        @cfHandle,
        @contestId,
        @problemIndex,
        1,
        @firstSubmissionId,
        @firstAcceptedAtSeconds,
        @acceptedCount,
        @checkedAt
      )
    `);
    transaction(db, () => {
      clearStatus.run({ userId });
      for (const item of accepted.values()) {
        insertStatus.run({
          userId,
          cfHandle,
          contestId: item.contestId,
          problemIndex: item.problemIndex,
          firstSubmissionId: item.firstSubmissionId,
          firstAcceptedAtSeconds: item.firstAcceptedAtSeconds,
          acceptedCount: item.acceptedCount,
          checkedAt,
        });
      }
    });

    writeBasicContestResults(db, userId, cfHandle, sortedCandidateContestIds, ratingsByContestId, checkedAt);

    for (const contestId of completedContestIds) {
      recomputeExistingUpsolvesForUser(db, userId, contestId, contestsById.get(contestId), accepted);
    }

    const contestJobStatus = db.prepare(`
      SELECT status
      FROM contest_sync_jobs
      WHERE user_id = @userId AND contest_id = @contestId
    `);
    const hydrateRecentContestIds = recentContestIds.filter((contestId) => {
      const count = problemCountsByContestId.get(contestId) ?? 0;
      if (count > 0) {
        const cachedStandings = getCachedStandings(db, contestId);
        return cachedStandings !== undefined && count < cachedStandings.problems.length;
      }

      const job = contestJobStatus.get({ userId, contestId }) as { status: string } | undefined;
      return job?.status !== "done";
    });
    const enqueuedRecent = enqueueContestHydrationJobs(db, userId, cfHandle, hydrateRecentContestIds, 0);
    const enqueuedBackfill = enqueueContestHydrationJobs(db, userId, cfHandle, backfillContestIds, 1000);
    const enqueuedContestResults = enqueuedRecent + enqueuedBackfill;

    finishSyncRun(
      db,
      syncRunId,
      "success",
      `Synced ${accepted.size} solved problems and queued ${enqueuedContestResults} contest detail refreshes for ${cfHandle}.`,
      now(),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finishSyncRun(db, syncRunId, "failed", message, now());
    throw error;
  } finally {
    syncState.userRunning.delete(userId);
  }
};
