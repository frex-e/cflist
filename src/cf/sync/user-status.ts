import { transaction, type Db } from "../../db/connection.js";
import { finishSyncRun, startSyncRun } from "../../db/writes/sync-runs.js";
import { shouldRefreshProblemMetadata, shouldSyncCatalog } from "../../db/queries/catalog-sync.js";
import {
  acceptedProblemsFromSubmissions,
  expandAcceptedProblemsByCanonicalId,
  problemKey,
  type AcceptedProblem,
} from "../accepted-problems.js";
import { CodeforcesClient } from "../client.js";
import { getCodeforcesClient } from "../shared-client.js";
import type { CfRatingChange, CfContest, CfSubmission } from "../types.js";
import { upsertProblemWithTags } from "../../db/writes/problems.js";
import { backfillUserContestPerformances } from "./cache.js";
import { collectContestsNeedingRefresh, invalidateContestCachesForContests } from "./contest-corrections.js";
import { refreshProblemMetadata, syncCatalog } from "./catalog.js";
import { getPairedContestId } from "./canonical-problems.js";
import { drainContestSyncJobs, enqueueContestHydrationJobs } from "./contest-queue.js";
import { recomputeExistingUpsolvesForUser } from "./contest-hydration.js";
import { codeforcesProblemUrl, contestSortValue, ensureContestsExist, loadContestsById, missingContestIds, now } from "./helpers.js";
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

const ensureAcceptedProblemsExist = (
  db: Db,
  submissions: CfSubmission[],
  accepted: Map<string, AcceptedProblem>,
  checkedAt: string,
): void => {
  const acceptedProblems = new Map<string, CfSubmission["problem"]>();
  for (const submission of submissions) {
    const contestId = submission.problem.contestId;
    if (submission.verdict !== "OK" || typeof contestId !== "number") continue;
    const key = problemKey(contestId, submission.problem.index);
    if (accepted.has(key)) acceptedProblems.set(key, submission.problem);
  }

  const problemExists = db.prepare(`
    SELECT 1
    FROM problems
    WHERE contest_id = @contestId AND problem_index = @problemIndex
  `);

  transaction(db, () => {
    for (const item of accepted.values()) {
      if (problemExists.get({ contestId: item.contestId, problemIndex: item.problemIndex })) continue;

      const problem = acceptedProblems.get(problemKey(item.contestId, item.problemIndex));
      if (!problem) {
        throw new Error(`Accepted problem ${item.contestId}${item.problemIndex} was not found in submissions`);
      }

      upsertProblemWithTags(db, {
        contestId: item.contestId,
        problemIndex: item.problemIndex,
        name: problem.name,
        type: problem.type ?? null,
        points: problem.points ?? null,
        rating: problem.rating ?? null,
        tags: problem.tags,
        url: codeforcesProblemUrl(item.contestId, item.problemIndex),
        rawJson: JSON.stringify(problem),
        updatedAt: checkedAt,
        problemsetName: problem.problemsetName ?? null,
      }, "standings");
    }
  });
};

const writeBasicContestResults = (
  db: Db,
  userId: string,
  contestIds: number[],
  ratingsByContestId: Map<number, CfRatingChange>,
  checkedAt: string,
): void => {
  const upsertRated = db.prepare(`
    INSERT INTO user_contest_results (
      user_id,
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
      rank = excluded.rank,
      old_rating = excluded.old_rating,
      new_rating = excluded.new_rating,
      rating_delta = excluded.rating_delta,
      performance = CASE
        WHEN excluded.old_rating IS NOT user_contest_results.old_rating
          OR excluded.new_rating IS NOT user_contest_results.new_rating
        THEN NULL
        ELSE user_contest_results.performance
      END,
      last_checked_at = excluded.last_checked_at
  `);
  const upsertUnrated = db.prepare(`
    INSERT INTO user_contest_results (
      user_id,
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
      @contestId,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      @checkedAt
    )
    ON CONFLICT(user_id, contest_id) DO UPDATE SET
      last_checked_at = excluded.last_checked_at
  `);

  transaction(db, () => {
    for (const contestId of contestIds) {
      const ratingChange = ratingsByContestId.get(contestId);
      if (ratingChange) {
        upsertRated.run({
          userId,
          contestId,
          rank: ratingChange.rank,
          oldRating: ratingChange.oldRating,
          newRating: ratingChange.newRating,
          ratingDelta: ratingChange.newRating - ratingChange.oldRating,
          checkedAt,
        });
      } else {
        upsertUnrated.run({ userId, contestId, checkedAt });
      }
    }
  });
};

export const contestNeedsHydration = (
  db: Db,
  contestId: number,
  problemCount: number,
): boolean => {
  if (problemCount === 0) return true;
  const known = db
    .prepare("SELECT COUNT(*) AS count FROM problems WHERE contest_id = @contestId")
    .get({ contestId }) as { count: number };
  return problemCount < known.count;
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

export const refreshUserContestDetails = (
  db: Db,
  userId: string,
  cfHandle: string,
): number => {
  const contestRows = db
    .prepare(
      `
      SELECT contest_id
      FROM user_contest_results
      WHERE user_id = @userId
      ORDER BY contest_id DESC
    `,
    )
    .all({ userId }) as { contest_id: number }[];

  const contestIds = contestRows.map((row) => row.contest_id);
  invalidateContestCachesForContests(db, userId, contestIds);

  const jobs = contestIds.map((contestId, priority) => ({ contestId, priority }));
  enqueueContestHydrationJobs(db, userId, cfHandle, jobs);
  return contestIds.length;
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
    let exactAccepted = acceptedProblemsFromSubmissions(submissions, contestsById);
    let accepted = expandAcceptedProblemsByCanonicalId(db, exactAccepted);
    const ratingHistory = await client.userRating(cfHandle);
    const ratingsByContestId = new Map(ratingHistory.map((change) => [change.contestId, change]));
    const candidateContestIds = new Set(ratingHistory.map((change) => change.contestId));
    for (const item of accepted.values()) {
      candidateContestIds.add(item.contestId);
    }

    if (missingContestIds(candidateContestIds, contestsById).length > 0) {
      await syncCatalog(db, client);
      contestsById = loadContestsById(db);
      exactAccepted = acceptedProblemsFromSubmissions(submissions, contestsById);
      accepted = expandAcceptedProblemsByCanonicalId(db, exactAccepted);
      for (const item of accepted.values()) {
        candidateContestIds.add(item.contestId);
      }
    }

    const checkedAt = now();
    ensureContestsExist(db, [...candidateContestIds], ratingsByContestId, contestsById, checkedAt);
    ensureAcceptedProblemsExist(db, submissions, exactAccepted, checkedAt);
    accepted = expandAcceptedProblemsByCanonicalId(db, exactAccepted);
    for (const item of accepted.values()) {
      candidateContestIds.add(item.contestId);
    }

    const pairedContestProbes = new Map<number, number>();
    for (const item of exactAccepted.values()) {
      const pairedContestId = getPairedContestId(db, item.contestId);
      if (pairedContestId !== undefined && !candidateContestIds.has(pairedContestId)) {
        pairedContestProbes.set(pairedContestId, item.contestId);
      }
    }

    const sortedCandidateContestIds = [...candidateContestIds]
      .sort((a, b) => contestSortValue(contestsById.get(b), ratingsByContestId.get(b)) - contestSortValue(contestsById.get(a), ratingsByContestId.get(a)));
    const refreshContestIds = collectContestsNeedingRefresh(
      db,
      userId,
      ratingsByContestId,
      sortedCandidateContestIds,
    );
    invalidateContestCachesForContests(db, userId, refreshContestIds);
    const refreshContestIdSet = new Set(refreshContestIds);
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
        contest_id,
        problem_index,
        solved,
        first_accepted_submission_id,
        first_accepted_at_seconds,
        accepted_count,
        last_checked_at
      ) VALUES (
        @userId,
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
      for (const item of exactAccepted.values()) {
        insertStatus.run({
          userId,
          contestId: item.contestId,
          problemIndex: item.problemIndex,
          firstSubmissionId: item.firstSubmissionId,
          firstAcceptedAtSeconds: item.firstAcceptedAtSeconds,
          acceptedCount: item.acceptedCount,
          checkedAt,
        });
      }
    });

    writeBasicContestResults(db, userId, sortedCandidateContestIds, ratingsByContestId, checkedAt);
    backfillUserContestPerformances(db, userId);

    const needsContestHydration = (contestId: number): boolean =>
      refreshContestIdSet.has(contestId)
      || contestNeedsHydration(db, contestId, problemCountsByContestId.get(contestId) ?? 0);

    const hydrateRecentContestIds = recentContestIds.filter(needsContestHydration);
    const forceRefreshOlderContestIds = sortedCandidateContestIds
      .slice(MAX_CONTEST_RESULTS_ENQUEUE)
      .filter((contestId) => refreshContestIdSet.has(contestId));
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
      [
        ...backfillContestIds.map(toHydrationJob),
        ...forceRefreshOlderContestIds.map(toHydrationJob),
      ],
    );
    const enqueuedContestResults = enqueuedRecent + enqueuedBackfill;
    const enqueuedPairedProbes = enqueueContestHydrationJobs(
      db,
      userId,
      cfHandle,
      [...pairedContestProbes].map(([contestId, sourceContestId]) => ({
        contestId,
        priority: rankByContestId.get(sourceContestId) ?? 0,
      })),
    );

    if (enqueuedRecent + enqueuedPairedProbes > 0) {
      await drainContestSyncJobs(db, client, enqueuedRecent + enqueuedPairedProbes);
    }

    accepted = expandAcceptedProblemsByCanonicalId(db, exactAccepted);
    recomputeAllExistingUpsolves(db, userId, contestsById, accepted);

    const refreshNote = refreshContestIds.length > 0
      ? `; refreshed ${refreshContestIds.length} contest${refreshContestIds.length === 1 ? "" : "s"} after Codeforces updates`
      : "";

    finishSyncRun(
      db,
      syncRunId,
      "success",
      `Synced ${accepted.size} solved problems and queued ${enqueuedContestResults + enqueuedPairedProbes} contest detail refreshes for ${cfHandle}${refreshNote}.`,
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
