import { transaction, type Db } from "../../db/connection.js";
import { finishSyncRun, startSyncRun } from "../../db/writes/sync-runs.js";
import { shouldRefreshProblemMetadata, shouldSyncCatalog } from "../../db/queries/catalog-sync.js";
import { acceptedProblemsFromSubmissions, type AcceptedProblem } from "../accepted-problems.js";
import { CodeforcesClient } from "../client.js";
import { getCodeforcesClient } from "../shared-client.js";
import type { CfRatingChange, CfContest } from "../types.js";
import { getCachedStandings, backfillUserContestPerformances } from "./cache.js";
import { refreshProblemMetadata, syncCatalog } from "./catalog.js";
import { drainContestSyncJobs, enqueueContestHydrationJobs } from "./contest-queue.js";
import { recomputeExistingUpsolvesForUser } from "./contest-hydration.js";
import { contestSortValue, ensureContestsExist, loadContestsById, missingContestIds, now } from "./helpers.js";
import { syncState } from "./state.js";

const MAX_CONTEST_RESULTS_ENQUEUE = 30;

const maybeSyncCatalog = async (db: Db, client: CodeforcesClient): Promise<void> => {
  if (shouldSyncCatalog(db)) {
    await syncCatalog(db, client);
    return;
  }

  if (!shouldRefreshProblemMetadata(db)) return;
  await refreshProblemMetadata(db, client);
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

export const contestNeedsHydration = (
  db: Db,
  contestId: number,
  problemCount: number,
): boolean => {
  if (problemCount === 0) return true;
  const cachedStandings = getCachedStandings(db, contestId);
  return cachedStandings !== undefined && problemCount < cachedStandings.problems.length;
};

const contestIdsWithProblemPills = (db: Db, userId: string): number[] => {
  const rows = db.prepare(`
    SELECT DISTINCT contest_id
    FROM user_contest_problem_results
    WHERE user_id = @userId
  `).all({ userId }) as { contest_id: number }[];

  return rows.map((row) => row.contest_id);
};

const recomputeAllExistingUpsolves = (
  db: Db,
  userId: string,
  contestsById: Map<number, CfContest>,
  accepted: Map<string, AcceptedProblem>,
): void => {
  for (const contestId of contestIdsWithProblemPills(db, userId)) {
    recomputeExistingUpsolvesForUser(db, userId, contestId, contestsById.get(contestId), accepted);
  }
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
  client: CodeforcesClient = getCodeforcesClient(),
): Promise<void> => {
  if (syncState.userRunning.has(userId)) return;

  syncState.userRunning.add(userId);
  const startedAt = now();
  const syncRunId = startSyncRun(db, "codeforces:user", startedAt, userId, cfHandle);

  try {
    await maybeSyncCatalog(db, client);

    let contestsById = loadContestsById(db);
    const submissions = await client.userStatus(cfHandle);
    let accepted = acceptedProblemsFromSubmissions(submissions, contestsById);
    const ratingHistory = await client.userRating(cfHandle);
    const ratingsByContestId = new Map(ratingHistory.map((change) => [change.contestId, change]));
    const candidateContestIds = new Set(ratingHistory.map((change) => change.contestId));
    for (const item of accepted.values()) {
      candidateContestIds.add(item.contestId);
    }

    if (missingContestIds(candidateContestIds, contestsById).length > 0) {
      await syncCatalog(db, client);
      contestsById = loadContestsById(db);
      accepted = acceptedProblemsFromSubmissions(submissions, contestsById);
      for (const item of accepted.values()) {
        candidateContestIds.add(item.contestId);
      }
    }

    const checkedAt = now();
    ensureContestsExist(db, [...candidateContestIds], ratingsByContestId, contestsById, checkedAt);

    const sortedCandidateContestIds = [...candidateContestIds]
      .sort((a, b) => contestSortValue(contestsById.get(b), ratingsByContestId.get(b)) - contestSortValue(contestsById.get(a), ratingsByContestId.get(a)));
    const rankByContestId = new Map(sortedCandidateContestIds.map((contestId, rank) => [contestId, rank]));
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
      .filter((contestId) => !recentContestIdSet.has(contestId) && !completedContestIds.has(contestId));

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
    backfillUserContestPerformances(db, userId);

    const hydrateRecentContestIds = recentContestIds.filter((contestId) =>
      contestNeedsHydration(db, contestId, problemCountsByContestId.get(contestId) ?? 0),
    );
    const toHydrationJob = (contestId: number) => ({
      contestId,
      priority: rankByContestId.get(contestId)!,
    });
    const enqueuedRecent = enqueueContestHydrationJobs(
      db,
      userId,
      cfHandle,
      hydrateRecentContestIds.map(toHydrationJob),
    );
    const enqueuedBackfill = enqueueContestHydrationJobs(
      db,
      userId,
      cfHandle,
      backfillContestIds.map(toHydrationJob),
    );
    const enqueuedContestResults = enqueuedRecent + enqueuedBackfill;

    if (enqueuedRecent > 0) {
      await drainContestSyncJobs(db, client, enqueuedRecent);
    }

    recomputeAllExistingUpsolves(db, userId, contestsById, accepted);

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
