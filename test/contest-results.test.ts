import assert from "node:assert/strict";
import test from "node:test";
import { deriveContestProblemResult, isUpsolved } from "../src/cf/contest-results.js";
import type { CfContest, CfProblem, CfStandingsRow } from "../src/cf/types.js";

const contest: CfContest = {
  id: 100,
  name: "Round",
  startTimeSeconds: 1_000_000,
  durationSeconds: 7200,
};

const problem: CfProblem = {
  contestId: 100,
  index: "A",
  name: "A",
  tags: [],
};

const standingsRow: CfStandingsRow = {
  party: { members: [{ handle: "tourist" }], participantType: "CONTESTANT" },
  rank: 1,
  points: 100,
  penalty: 0,
  problemResults: [
    {
      points: 100,
      rejectedAttemptCount: 0,
      bestSubmissionTimeSeconds: 120,
    },
  ],
};

test("deriveContestProblemResult marks in-contest solve from standings", () => {
  const result = deriveContestProblemResult(problem, standingsRow, 0, undefined, contest);
  assert.equal(result.solvedInContest, 1);
  assert.equal(result.upsolved, 0);
  assert.equal(result.bestSubmissionTimeSeconds, 120);
});

test("deriveContestProblemResult marks upsolve from accepted after contest end", () => {
  const endTime = contest.startTimeSeconds! + contest.durationSeconds!;
  const result = deriveContestProblemResult(
    problem,
    undefined,
    0,
    {
      contestId: 100,
      problemIndex: "A",
      firstSubmissionId: 1,
      firstAcceptedAtSeconds: endTime + 60,
      acceptedCount: 1,
    },
    contest,
  );
  assert.equal(result.solvedInContest, 0);
  assert.equal(result.upsolved, 1);
});

test("isUpsolved respects solved-in-contest flag", () => {
  const endTime = contest.startTimeSeconds! + contest.durationSeconds!;
  assert.equal(
    isUpsolved(true, {
      contestId: 100,
      problemIndex: "A",
      firstSubmissionId: 1,
      firstAcceptedAtSeconds: endTime + 60,
      acceptedCount: 1,
    }, endTime),
    false,
  );
});
