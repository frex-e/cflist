import { transaction, type Db } from "../../db/connection.js";
import { upsertProblemWithTags } from "../../db/writes/problems.js";
import {
  acceptedProblemsFromDb,
  isRegularOfficialProblem,
  problemKey,
  type AcceptedProblem,
} from "../accepted-problems.js";
import { CodeforcesClient } from "../client.js";
import { getCodeforcesClient } from "../shared-client.js";
import type { CfContest } from "../types.js";
import {
  contestEndTime,
  deriveContestProblemResult,
  isUpsolved,
  type ContestProblemResult,
} from "../contest-results.js";
import { calculateAndPersistPerformance } from "./cache.js";
import { maybeEstimateProblemRatingsAfterHydration } from "./estimate-problem-ratings.js";
import { codeforcesProblemUrl, hasHandle, loadContestsById, now } from "./helpers.js";

const upsertContestMetadataFromStandings = (
  db: Db,
  standingsContest: CfContest,
  checkedAt: string,
  contestsById: Map<number, CfContest>,
): void => {
  db.prepare(
    `
    UPDATE contests
    SET
      name = COALESCE(@name, name),
      phase = COALESCE(@phase, phase),
      duration_seconds = COALESCE(@durationSeconds, duration_seconds),
      start_time_seconds = COALESCE(@startTimeSeconds, start_time_seconds),
      raw_json = @rawJson,
      updated_at = @checkedAt
    WHERE id = @contestId
  `,
  ).run({
    contestId: standingsContest.id,
    name: standingsContest.name ?? null,
    phase: standingsContest.phase ?? null,
    durationSeconds: standingsContest.durationSeconds ?? null,
    startTimeSeconds: standingsContest.startTimeSeconds ?? null,
    rawJson: JSON.stringify(standingsContest),
    checkedAt,
  });

  const existing = contestsById.get(standingsContest.id);
  contestsById.set(standingsContest.id, {
    ...existing,
    ...standingsContest,
    id: standingsContest.id,
    name: standingsContest.name ?? existing?.name ?? `Contest ${standingsContest.id}`,
  });
};

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
      SELECT problem_index, solved_in_contest, points
      FROM user_contest_problem_results
      WHERE user_id = @userId AND contest_id = @contestId
    `,
    )
    .all({ userId, contestId }) as {
      problem_index: string;
      solved_in_contest: number;
      points: number | null;
    }[];
  const updateUpsolvedOnly = db.prepare(`
    UPDATE user_contest_problem_results
    SET upsolved = @upsolved
    WHERE user_id = @userId
      AND contest_id = @contestId
      AND problem_index = @problemIndex
  `);
  const updateFromAccepted = db.prepare(`
    UPDATE user_contest_problem_results
    SET
      solved_in_contest = @solvedInContest,
      upsolved = @upsolved,
      best_submission_time_seconds = @bestSubmissionTimeSeconds
    WHERE user_id = @userId
      AND contest_id = @contestId
      AND problem_index = @problemIndex
  `);

  for (const row of rows) {
    const firstAccepted = accepted.get(problemKey(contestId, row.problem_index));
    // Standings-backed rows keep points > 0 from contest.standings; only refresh upsolve.
    // Submission-fallback rows (no standings points) must track accepted status as
    // system tests rewrite verdicts between OK, null, and definitive failure.
    if (row.points !== null && row.points > 0) {
      const upsolved = isUpsolved(row.solved_in_contest !== 0, firstAccepted, endTime);
      updateUpsolvedOnly.run({
        userId,
        contestId,
        problemIndex: row.problem_index,
        upsolved: upsolved ? 1 : 0,
      });
      continue;
    }

    const acceptedDuringContest =
      firstAccepted !== undefined
      && contest?.startTimeSeconds !== undefined
      && endTime !== undefined
      && firstAccepted.firstAcceptedAtSeconds >= contest.startTimeSeconds
      && firstAccepted.firstAcceptedAtSeconds <= endTime;
    const solvedInContest = acceptedDuringContest ? 1 : 0;
    const upsolved = isUpsolved(solvedInContest, firstAccepted, endTime);
    const bestSubmissionTimeSeconds = acceptedDuringContest && contest?.startTimeSeconds !== undefined
      ? firstAccepted!.firstAcceptedAtSeconds - contest.startTimeSeconds
      : null;
    updateFromAccepted.run({
      userId,
      contestId,
      problemIndex: row.problem_index,
      solvedInContest,
      upsolved: upsolved ? 1 : 0,
      bestSubmissionTimeSeconds,
    });
  }
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
      contest_id,
      rank,
      points,
      penalty,
      participant_type,
      old_rating,
      new_rating,
      rating_delta,
      performance,
      last_checked_at,
      standings_checked_at
    ) VALUES (
      @userId,
      @contestId,
      @rank,
      @points,
      @penalty,
      @participantType,
      @oldRating,
      @newRating,
      @ratingDelta,
      @performance,
      @checkedAt,
      @checkedAt
    )
    ON CONFLICT(user_id, contest_id) DO UPDATE SET
      rank = excluded.rank,
      points = excluded.points,
      penalty = excluded.penalty,
      participant_type = excluded.participant_type,
      old_rating = excluded.old_rating,
      new_rating = excluded.new_rating,
      rating_delta = excluded.rating_delta,
      performance = excluded.performance,
      last_checked_at = excluded.last_checked_at,
      standings_checked_at = excluded.standings_checked_at
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
  client: CodeforcesClient = getCodeforcesClient(),
  _options: { force?: boolean } = {},
): Promise<boolean> => {
  const contestsById = loadContestsById(db);
  const checkedAt = now();

  const existing = db
    .prepare(
      `
      SELECT
        rank,
        old_rating,
        new_rating,
        rating_delta
      FROM user_contest_results ucr
      WHERE user_id = @userId AND contest_id = @contestId
    `,
    )
    .get({ userId, contestId }) as {
      rank: number | null;
      old_rating: number | null;
      new_rating: number | null;
      rating_delta: number | null;
    } | undefined;

  const existingRatingChange = existing && existing.old_rating !== null && existing.new_rating !== null
    ? {
        rank: existing.rank,
        oldRating: existing.old_rating,
        newRating: existing.new_rating,
      }
    : undefined;
  const performance = existingRatingChange && existingRatingChange.rank !== 1
    ? await calculateAndPersistPerformance(db, client, userId, contestId, cfHandle)
    : null;
  const standings = await client.contestStandings(contestId);
  if (standings.contest) {
    upsertContestMetadataFromStandings(db, standings.contest, checkedAt, contestsById);
  }
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
  const contest = standings.contest ?? contestsById.get(contestId);
  const refreshedAccepted = acceptedProblemsFromDb(db, userId);
  const problemResults = computeProblemResults(
    contestId,
    standings,
    row,
    knownProblems,
    refreshedAccepted,
    contest,
  );

  if (!row && !existingRatingChange && problemResults.every((problem) => !problem.solvedInContest && !problem.upsolved)) {
    return false;
  }

  persistContestHydration(
    db,
    userId,
    contestId,
    row,
    existingRatingChange,
    performance,
    problemResults,
    checkedAt,
  );

  await maybeEstimateProblemRatingsAfterHydration(
    db,
    client,
    contestId,
    standings,
    // Prefer fresh standings contest metadata over a possibly stale DB row
    // (phase/duration may still say CODING after the round finished).
    standings.contest ?? contest,
  );

  return true;
};

export const recomputeExistingUpsolvesForUser = recomputeExistingUpsolves;
