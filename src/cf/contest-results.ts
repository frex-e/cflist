import type { AcceptedProblem } from "./accepted-problems.js";
import type { CfContest, CfProblem, CfStandingsRow } from "./types.js";

export type ContestProblemResult = {
  problemIndex: string;
  points: number | null;
  penalty: number | null;
  rejectedAttemptCount: number | null;
  bestSubmissionTimeSeconds: number | null;
  solvedInContest: 0 | 1;
  upsolved: 0 | 1;
};

export const contestEndTime = (contest: CfContest): number | undefined => {
  if (contest.startTimeSeconds === undefined || contest.durationSeconds === undefined) return undefined;
  return contest.startTimeSeconds + contest.durationSeconds;
};

export const isUpsolved = (
  solvedInContest: boolean | 0 | 1,
  firstAccepted: AcceptedProblem | undefined,
  endTime: number | undefined,
): boolean => {
  if (solvedInContest) return false;
  if (!firstAccepted) return false;
  return endTime === undefined || firstAccepted.firstAcceptedAtSeconds > endTime;
};

export const deriveContestProblemResult = (
  problem: CfProblem,
  standingsRow: CfStandingsRow | undefined,
  problemResultIndex: number,
  firstAccepted: AcceptedProblem | undefined,
  contest: CfContest | undefined,
): ContestProblemResult => {
  const result = standingsRow?.problemResults[problemResultIndex];
  const endTime = contest ? contestEndTime(contest) : undefined;
  const acceptedDuringContest =
    firstAccepted !== undefined
    && contest?.startTimeSeconds !== undefined
    && endTime !== undefined
    && firstAccepted.firstAcceptedAtSeconds >= contest.startTimeSeconds
    && firstAccepted.firstAcceptedAtSeconds <= endTime;
  const solvedInContest = result?.bestSubmissionTimeSeconds !== undefined && result.points > 0;
  const fallbackBestSubmissionTime = acceptedDuringContest && contest?.startTimeSeconds !== undefined
    ? firstAccepted.firstAcceptedAtSeconds - contest.startTimeSeconds
    : null;
  const acceptedAfterContest = isUpsolved(solvedInContest, firstAccepted, endTime);

  return {
    problemIndex: problem.index,
    points: result?.points ?? null,
    penalty: result?.penalty ?? null,
    rejectedAttemptCount: result?.rejectedAttemptCount ?? null,
    bestSubmissionTimeSeconds: result?.bestSubmissionTimeSeconds ?? fallbackBestSubmissionTime,
    solvedInContest: solvedInContest || acceptedDuringContest ? 1 : 0,
    upsolved: acceptedAfterContest ? 1 : 0,
  };
};
