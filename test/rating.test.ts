import assert from "node:assert/strict";
import test from "node:test";
import { estimateContestPerformance } from "../src/cf/rating.js";
import type { CfRatingChange } from "../src/cf/types.js";

const changes: CfRatingChange[] = [
  {
    contestId: 1,
    contestName: "Codeforces Round 1",
    handle: "winner",
    rank: 1,
    ratingUpdateTimeSeconds: 1,
    oldRating: 1500,
    newRating: 1600,
  },
  {
    contestId: 1,
    contestName: "Codeforces Round 1",
    handle: "middle",
    rank: 2,
    ratingUpdateTimeSeconds: 1,
    oldRating: 1500,
    newRating: 1500,
  },
  {
    contestId: 1,
    contestName: "Codeforces Round 1",
    handle: "lower",
    rank: 3,
    ratingUpdateTimeSeconds: 1,
    oldRating: 1500,
    newRating: 1400,
  },
];

test("estimates performance as the rating where adjusted delta reaches zero", () => {
  const estimate = estimateContestPerformance(changes, "middle");

  assert.equal(estimate?.adjustment, 0);
  assert.equal(estimate?.performance, 1497);
});

test("treats rank one as unbounded performance", () => {
  assert.deepEqual(estimateContestPerformance(changes, "winner"), {
    performance: null,
    adjustment: 0,
  });
});

test("returns undefined when the handle is absent from rating changes", () => {
  assert.equal(estimateContestPerformance(changes, "missing"), undefined);
});
