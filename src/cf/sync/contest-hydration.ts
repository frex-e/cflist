import { transaction, type Db } from "../../db/connection.js";
import { upsertProblemWithTags } from "../../db/writes/problems.js";
import {
  acceptedProblemsFromDb,
  isRegularOfficialProblem,
  problemKey,
  type AcceptedProblem,
} from "../accepted-problems.js";
import { CodeforcesClient } from "../client.js";
import type { CfContest, CfRatingChange } from "../types.js";
import {
  contestEndTime,
  deriveContestProblemResult,
  isUpsolved,
  type ContestProblemResult,
} from "../contest-results.js";
import {
  getCachedStandings,
  getOrCalculatePerformance,
  getOrFetchStandings,
} from "./cache.js";
import { codeforcesProblemUrl, hasHandle, loadContestsById, now } from "./helpers.js";

const recomputeExistingUpsolves = (
  db: Db,
  userId: string,
  contestId: number,
  contest: CfContest | undefined,
  accepted: Map<string, AcceptedProblem>,
): void => {
  const endTime = contest ? contestEndTime(contest) : undefined;
  const rows = db
    .prepare(
      `
      SELECT problem_index, solved_in_contest
      FROM user_contest_problem_results
      WHERE user_id = @userId AND contest_id = @contestId
    `,
    )
    .all({ userId, contestId }) as {
      problem_index: string;
      solved_in_contest: number;
    }[];
  const update = db.prepare(`
    UPDATE user_contest_problem_results
    SET upsolved = @upsolved
    WHERE user_id = @userId
      AND contest_id = @contestId
      AND problem_index = @problemIndex
  `);

  for (const row of rows) {
    const firstAccepted = accepted.get(problemKey(contestId, row.problem_index));
    const upsolved = isUpsolved(row.solved_in_contest !== 0, firstAccepted, endTime);
    update.run({
      userId,
      contestId,
      problemIndex: row.problem_index,
      upsolved: upsolved ? 1 : 0,
    });
  }
};

const shouldSkipFullHydration = async (
  db: Db,
  client: CodeforcesClient,
  userId: string,
  cfHandle: string,
  contestId: number,
  existing: {
    rank: number | null;
    old_rating: number | null;
    new_rating: number | null;
    rating_delta: number | null;
    performance: number | null;
    problem_count: number;
  },
  contestsById: Map<number, CfContest>,
  accepted: Map<string, AcceptedProblem>,
): Promise<boolean> => {
  const cachedStandings = getCachedStandings(db, contestId);
  const standingsProblemCount = cachedStandings?.problems.length ?? 0;
  if (!cachedStandings || existing.problem_count < standingsProblemCount) return false;

  const checkedAt = now();
  const needsPerformance = existing.old_rating !== null && existing.new_rating !== null && existing.performance === null && existing.rank !== 1;
  const performance = needsPerformance
    ? await getOrCalculatePerformance(db, client, contestId, cfHandle)
    : existing.performance;

  db.prepare(
    `
    UPDATE user_contest_results
    SET
      cf_handle = @cfHandle,
      performance = @performance,
      last_checked_at = @checkedAt
    WHERE user_id = @userId AND contest_id = @contestId
  `,
  ).run({
    userId,
    cfHandle,
    contestId,
    performance,
    checkedAt,
  });
  recomputeExistingUpsolves(db, userId, contestId, contestsById.get(contestId), accepted);
  return true;
};

const importStandingsProblems = (
  db: Db,
  contestId: number,
  standings: { problems: import("../types.js").CfProblem[] },
  contestsById: Map<number, CfContest>,
  checkedAt: string,
  knownProblems: Set<string>,
): void => {
  transaction(db, () => {
    for (const problem of standings.problems) {
      if (!isRegularOfficialProblem(problem, contestsById)) continue;
      if (problem.contestId !== contestId) continue;

      upsertProblemWithTags(db, {
        contestId,
        problemIndex: problem.index,
        name: problem.name,
        type: problem.type ?? null,
        points: problem.points ?? null,
        rating: problem.rating ?? null,
        tags: problem.tags,
        url: codeforcesProblemUrl(contestId, problem.index),
        rawJson: JSON.stringify(problem),
        updatedAt: checkedAt,
      }, "standings");
      knownProblems.add(problemKey(contestId, problem.index));
    }
  });
};

const computeProblemResults = (
  contestId: number,
  standings: import("../types.js").CfStandings,
  row: import("../types.js").CfStandingsRow | undefined,
  knownProblems: Set<string>,
  accepted: Map<string, AcceptedProblem>,
  contest: CfContest | undefined,
): ContestProblemResult[] => {
  return standings.problems
    .map((problem, index): ContestProblemResult | undefined => {
      if (!knownProblems.has(problemKey(contestId, problem.index))) return undefined;
      return deriveContestProblemResult(
        problem,
        row,
        index,
        accepted.get(problemKey(contestId, problem.index)),
        contest,
      );
    })
    .filter((problem): problem is ContestProblemResult => problem !== undefined);
};

const persistContestHydration = (
  db: Db,
  userId: string,
  cfHandle: string,
  contestId: number,
  row: import("../types.js").CfStandingsRow | undefined,
  existingRatingChange: { rank: number | null; oldRating: number; newRating: number } | undefined,
  performance: number | null,
  problemResults: ContestProblemResult[],
  checkedAt: string,
): void => {
  const upsertContestResult = db.prepare(`
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
      @points,
      @penalty,
      @participantType,
      @oldRating,
      @newRating,
      @ratingDelta,
      @performance,
      @checkedAt
    )
    ON CONFLICT(user_id, contest_id) DO UPDATE SET
      cf_handle = excluded.cf_handle,
      rank = excluded.rank,
      points = excluded.points,
      penalty = excluded.penalty,
      participant_type = excluded.participant_type,
      old_rating = excluded.old_rating,
      new_rating = excluded.new_rating,
      rating_delta = excluded.rating_delta,
      performance = excluded.performance,
      last_checked_at = excluded.last_checked_at
  `);
  const deleteContestProblemResults = db.prepare(`
    DELETE FROM user_contest_problem_results
    WHERE user_id = @userId AND contest_id = @contestId
  `);
  const upsertContestProblemResult = db.prepare(`
    INSERT INTO user_contest_problem_results (
      user_id,
      contest_id,
      problem_index,
      points,
      penalty,
      rejected_attempt_count,
      best_submission_time_seconds,
      solved_in_contest,
      upsolved
    ) VALUES (
      @userId,
      @contestId,
      @problemIndex,
      @points,
      @penalty,
      @rejectedAttemptCount,
      @bestSubmissionTimeSeconds,
      @solvedInContest,
      @upsolved
    )
    ON CONFLICT(user_id, contest_id, problem_index) DO UPDATE SET
      points = excluded.points,
      penalty = excluded.penalty,
      rejected_attempt_count = excluded.rejected_attempt_count,
      best_submission_time_seconds = excluded.best_submission_time_seconds,
      solved_in_contest = excluded.solved_in_contest,
      upsolved = excluded.upsolved
  `);

  transaction(db, () => {
    upsertContestResult.run({
      userId,
      cfHandle,
      contestId,
      rank: row?.rank ?? existingRatingChange?.rank ?? null,
      points: row?.points ?? null,
      penalty: row?.penalty ?? null,
      participantType: row?.party.participantType ?? null,
      oldRating: existingRatingChange?.oldRating ?? null,
      newRating: existingRatingChange?.newRating ?? null,
      ratingDelta: existingRatingChange ? existingRatingChange.newRating - existingRatingChange.oldRating : null,
      performance,
      checkedAt,
    });
    deleteContestProblemResults.run({ userId, contestId });
    for (const problem of problemResults) {
      upsertContestProblemResult.run({
        userId,
        contestId,
        problemIndex: problem.problemIndex,
        points: problem.points,
        penalty: problem.penalty,
        rejectedAttemptCount: problem.rejectedAttemptCount,
        bestSubmissionTimeSeconds: problem.bestSubmissionTimeSeconds,
        solvedInContest: problem.solvedInContest,
        upsolved: problem.upsolved,
      });
    }
  });
};

export const hydrateUserContestResult = async (
  db: Db,
  userId: string,
  cfHandle: string,
  contestId: number,
  client = new CodeforcesClient(),
): Promise<boolean> => {
  const contestsById = loadContestsById(db);
  const accepted = acceptedProblemsFromDb(db, userId);
  const checkedAt = now();

  const existing = db
    .prepare(
      `
      SELECT
        rank,
        old_rating,
        new_rating,
        rating_delta,
        performance,
        (
          SELECT COUNT(*)
          FROM user_contest_problem_results ucpr
          WHERE ucpr.user_id = ucr.user_id
            AND ucpr.contest_id = ucr.contest_id
        ) AS problem_count
      FROM user_contest_results ucr
      WHERE user_id = @userId AND contest_id = @contestId
    `,
    )
    .get({ userId, contestId }) as {
      rank: number | null;
      old_rating: number | null;
      new_rating: number | null;
      rating_delta: number | null;
      performance: number | null;
      problem_count: number;
    } | undefined;

  if (existing && existing.problem_count > 0) {
    const skipped = await shouldSkipFullHydration(
      db,
      client,
      userId,
      cfHandle,
      contestId,
      existing,
      contestsById,
      accepted,
    );
    if (skipped) return true;
  }

  const existingRatingChange = existing && existing.old_rating !== null && existing.new_rating !== null
    ? {
        rank: existing.rank,
        oldRating: existing.old_rating,
        newRating: existing.new_rating,
      }
    : undefined;
  const performance = existingRatingChange && existingRatingChange.rank !== 1
    ? await getOrCalculatePerformance(db, client, contestId, cfHandle)
    : null;
  const standings = await getOrFetchStandings(db, client, contestId);
  const knownProblemRows = db
    .prepare(
      `
      SELECT contest_id, problem_index
      FROM problems
      WHERE contest_id = @contestId
    `,
    )
    .all({ contestId }) as { contest_id: number; problem_index: string }[];
  const knownProblems = new Set(knownProblemRows.map((row) => problemKey(row.contest_id, row.problem_index)));

  importStandingsProblems(db, contestId, standings, contestsById, checkedAt, knownProblems);

  const row = standings.rows.find((standingsRow) => hasHandle(standingsRow, cfHandle));
  const contest = contestsById.get(contestId);
  const problemResults = computeProblemResults(contestId, standings, row, knownProblems, accepted, contest);

  if (!row && !existingRatingChange && problemResults.every((problem) => !problem.solvedInContest && !problem.upsolved)) {
    return false;
  }

  persistContestHydration(
    db,
    userId,
    cfHandle,
    contestId,
    row,
    existingRatingChange,
    performance,
    problemResults,
    checkedAt,
  );
  return true;
};

export const recomputeExistingUpsolvesForUser = recomputeExistingUpsolves;
