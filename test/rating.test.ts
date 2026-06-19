import assert from "node:assert/strict";
import test from "node:test";
import {
  bootstrapAdjustedDelta,
  bootstrapOffsetBeforeContest,
  CF_BOOTSTRAP_BONUSES,
  estimateContestPerformance,
  internalRatingBeforeContest,
} from "../src/cf/rating.js";
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
  const estimate = estimateContestPerformance(changes, "middle", 10);

  assert.equal(estimate?.adjustment, 0);
  assert.equal(estimate?.performance, 1497);
});

test("treats rank one as unbounded performance", () => {
  assert.deepEqual(estimateContestPerformance(changes, "winner", 10), {
    performance: null,
    adjustment: 0,
  });
});

test("returns undefined when the handle is absent from rating changes", () => {
  assert.equal(estimateContestPerformance(changes, "missing", 1), undefined);
});

test("maps bootstrap offsets for the first six rated contests", () => {
  assert.equal(bootstrapOffsetBeforeContest(1), 1400);
  assert.equal(bootstrapOffsetBeforeContest(2), 900);
  assert.equal(bootstrapOffsetBeforeContest(3), 550);
  assert.equal(bootstrapOffsetBeforeContest(6), 50);
  assert.equal(bootstrapOffsetBeforeContest(7), 0);
});

test("derives internal ratings and deltas from Codeforces display values", () => {
  assert.equal(internalRatingBeforeContest(0, 1), 1400);
  assert.equal(internalRatingBeforeContest(394, 2), 1294);
  assert.equal(bootstrapAdjustedDelta(0, 394, 1), -106);
  assert.equal(
    bootstrapAdjustedDelta(394, 812, 2),
    812 - 394 - CF_BOOTSTRAP_BONUSES[1],
  );
});

test("estimates bootstrap first contests below the default rating baseline", () => {
  const contestChanges: CfRatingChange[] = [];
  for (let rank = 1; rank <= 150; rank += 1) {
    contestChanges.push({
      contestId: 796,
      contestName: "Codeforces Round 796 (Div. 2)",
      handle: `p${rank}`,
      rank,
      ratingUpdateTimeSeconds: 1,
      oldRating: rank === 102 ? 0 : 1000 + (rank % 1500),
      newRating: rank === 102 ? 394 : 1000 + (rank % 1500) + (rank % 2 === 0 ? 50 : -50),
    });
  }

  const estimate = estimateContestPerformance(contestChanges, "p102", 1);

  assert.ok(estimate);
  assert.ok(estimate.performance !== null && estimate.performance < 1400);
  assert.ok(estimate.performance !== null && estimate.performance > -500);
});
