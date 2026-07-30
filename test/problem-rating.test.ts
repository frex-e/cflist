import assert from "node:assert/strict";
import test from "node:test";
import {
  countContestSolves,
  estimateProblemRating,
  isContestEligibleForProblemRatingEstimate,
} from "../src/cf/problem-rating.js";
import type { CfContest, CfStandings } from "../src/cf/types.js";

test("estimateProblemRating matches blog intuition for a flat 2000 field", () => {
  const field = Array.from({ length: 10 }, () => 2000);

  assert.equal(estimateProblemRating(field, 5), 2000);
  assert.ok(Math.abs(estimateProblemRating(field, 7) - 1852) <= 2);
  assert.ok(Math.abs(estimateProblemRating(field, 9) - 1618) <= 2);
});

test("estimateProblemRating clamps all-solved and none-solved", () => {
  const field = [1200, 1400, 1600];
  assert.equal(estimateProblemRating(field, 0), 3500);
  assert.equal(estimateProblemRating(field, 3), 0);
  assert.equal(estimateProblemRating([], 1), 3500);
});

test("estimateProblemRating respects an explicit max rating cap", () => {
  const field = [1200, 1400, 1600];
  assert.equal(estimateProblemRating(field, 0, 2400), 2400);
  assert.equal(estimateProblemRating([], 1, 3000), 3000);
  assert.ok(estimateProblemRating(field, 1, 2000) <= 2000);
});

test("isContestEligibleForProblemRatingEstimate waits until after contest", () => {
  const now = 1_700_000_000;
  const live: CfContest = {
    id: 1,
    name: "Live",
    phase: "CODING",
    startTimeSeconds: now - 600,
    durationSeconds: 7200,
  };
  assert.equal(isContestEligibleForProblemRatingEstimate(live, now), false);

  const pending: CfContest = {
    id: 2,
    name: "Pending",
    phase: "PENDING_SYSTEM_TEST",
    startTimeSeconds: now - 8000,
    durationSeconds: 7200,
  };
  assert.equal(isContestEligibleForProblemRatingEstimate(pending, now), false);

  const finished: CfContest = {
    id: 3,
    name: "Finished",
    phase: "FINISHED",
    startTimeSeconds: now - 8000,
    durationSeconds: 7200,
  };
  assert.equal(isContestEligibleForProblemRatingEstimate(finished, now), true);

  const endedNoPhase: CfContest = {
    id: 4,
    name: "Ended",
    startTimeSeconds: now - 8000,
    durationSeconds: 7200,
  };
  assert.equal(isContestEligibleForProblemRatingEstimate(endedNoPhase, now), true);

  const missingDuration: CfContest = {
    id: 5,
    name: "Stub",
    phase: "FINISHED",
    startTimeSeconds: now - 8000,
  };
  assert.equal(isContestEligibleForProblemRatingEstimate(missingDuration, now), false);
});

test("countContestSolves counts CONTESTANT solves only", () => {
  const standings: CfStandings = {
    contest: { id: 1, name: "X", phase: "FINISHED" },
    problems: [
      { index: "A", name: "A", tags: [] },
      { index: "B", name: "B", tags: [] },
    ],
    rows: [
      {
        party: { members: [{ handle: "a" }], participantType: "CONTESTANT" },
        rank: 1,
        points: 1,
        penalty: 0,
        problemResults: [
          { points: 1, bestSubmissionTimeSeconds: 10 },
          { points: 0 },
        ],
      },
      {
        party: { members: [{ handle: "b" }], participantType: "CONTESTANT" },
        rank: 2,
        points: 2,
        penalty: 0,
        problemResults: [
          { points: 1, bestSubmissionTimeSeconds: 20 },
          { points: 1, bestSubmissionTimeSeconds: 30 },
        ],
      },
      {
        party: { members: [{ handle: "c" }], participantType: "PRACTICE" },
        rank: 0,
        points: 2,
        penalty: 0,
        problemResults: [
          { points: 1, bestSubmissionTimeSeconds: 40 },
          { points: 1, bestSubmissionTimeSeconds: 50 },
        ],
      },
    ],
  };

  const counts = countContestSolves(standings);
  assert.equal(counts.get("A"), 2);
  assert.equal(counts.get("B"), 1);
});
