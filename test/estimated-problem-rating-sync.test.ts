import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { hydrateUserContestResult } from "../src/cf/sync/contest-hydration.js";
import { estimateMissingProblemRatings } from "../src/cf/sync/estimate-problem-ratings.js";
import { upsertProblemWithTags } from "../src/db/writes/problems.js";
import type { CfContest, CfRatingChange, CfStandings } from "../src/cf/types.js";
import { createTestDb } from "./helpers.js";

const nowSeconds = Math.floor(Date.now() / 1000);

const seedFinishedContest = (
  db: ReturnType<typeof createTestDb>,
  contestId: number,
  phase: string,
  ended: boolean,
): void => {
  db.prepare(
    `
    INSERT INTO contests (
      id, name, phase, duration_seconds, start_time_seconds, raw_json, updated_at
    ) VALUES (
      @id, @name, @phase, @duration, @start, '{}', '2026-01-01T00:00:00.000Z'
    )
  `,
  ).run({
    id: contestId,
    name: `Contest ${contestId}`,
    phase,
    duration: 7200,
    start: ended ? nowSeconds - 10_000 : nowSeconds - 600,
  });
};

const seedUser = (db: ReturnType<typeof createTestDb>, userId: string, handle: string): void => {
  db.prepare(
    `
    INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, cfHandle)
    VALUES (@id, 'T', @email, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', @handle)
  `,
  ).run({ id: userId, email: `${userId}@example.com`, handle });
};

const seedUnratedProblem = (
  db: ReturnType<typeof createTestDb>,
  contestId: number,
  index: string,
  solvedCount: number | null = null,
): void => {
  upsertProblemWithTags(
    db,
    {
      contestId,
      problemIndex: index,
      name: `Problem ${index}`,
      type: "PROGRAMMING",
      points: null,
      rating: null,
      tags: [],
      url: `https://codeforces.com/contest/${contestId}/problem/${index}`,
      rawJson: "{}",
      updatedAt: "2026-01-01T00:00:00.000Z",
      solvedCount,
    },
    "catalog",
  );
};

const ratingChanges = (contestId: number): CfRatingChange[] =>
  Array.from({ length: 10 }, (_, i) => ({
    contestId,
    contestName: `Contest ${contestId}`,
    handle: `user${i}`,
    rank: i + 1,
    ratingUpdateTimeSeconds: nowSeconds - 1000,
    oldRating: 2000,
    newRating: 2000,
  }));

const standingsFor = (contest: CfContest, solvesA: number): CfStandings => ({
  contest,
  problems: [
    { contestId: contest.id, index: "A", name: "Problem A", tags: [] },
    { contestId: contest.id, index: "B", name: "Problem B", tags: [] },
  ],
  rows: Array.from({ length: 10 }, (_, i) => ({
    party: { members: [{ handle: `user${i}` }], participantType: "CONTESTANT" as const },
    rank: i + 1,
    points: i < solvesA ? 1 : 0,
    penalty: 0,
    problemResults: [
      i < solvesA
        ? { points: 1, bestSubmissionTimeSeconds: 10 }
        : { points: 0 },
      { points: 0 },
    ],
  })),
});

class FakeClient {
  ratingChangesCalls = 0;
  standingsCalls = 0;
  failRatingChanges = false;
  contestPhase: string = "FINISHED";
  contestEnded = true;
  solvesA = 5;

  async contestRatingChanges(contestId: number): Promise<CfRatingChange[]> {
    this.ratingChangesCalls += 1;
    if (this.failRatingChanges) throw new Error("rating changes unavailable");
    return ratingChanges(contestId);
  }

  async contestStandings(contestId: number): Promise<CfStandings> {
    this.standingsCalls += 1;
    const contest: CfContest = {
      id: contestId,
      name: `Contest ${contestId}`,
      phase: this.contestPhase,
      startTimeSeconds: this.contestEnded ? nowSeconds - 10_000 : nowSeconds - 600,
      durationSeconds: 7200,
    };
    return standingsFor(contest, this.solvesA);
  }
}

test("hydration estimates ratings after contest when rating changes exist", async () => {
  const db = createTestDb();
  const userId = randomUUID();
  seedUser(db, userId, "user0");
  seedFinishedContest(db, 100, "FINISHED", true);
  seedUnratedProblem(db, 100, "A");
  seedUnratedProblem(db, 100, "B");

  db.prepare(
    `
    INSERT INTO user_contest_results (
      user_id, contest_id, rank, old_rating, new_rating, rating_delta, last_checked_at
    ) VALUES (@userId, 100, 1, 2000, 2000, 0, '2026-01-01T00:00:00.000Z')
  `,
  ).run({ userId });

  const client = new FakeClient();
  await hydrateUserContestResult(db, userId, "user0", 100, client as never);

  const rowA = db
    .prepare("SELECT rating, estimated_rating FROM problems WHERE contest_id = 100 AND problem_index = 'A'")
    .get() as { rating: number | null; estimated_rating: number | null };
  const rowB = db
    .prepare("SELECT rating, estimated_rating FROM problems WHERE contest_id = 100 AND problem_index = 'B'")
    .get() as { rating: number | null; estimated_rating: number | null };

  assert.equal(rowA.rating, null);
  assert.equal(rowA.estimated_rating, 2000);
  assert.equal(rowB.rating, null);
  assert.equal(rowB.estimated_rating, 5000);
  db.close();
});

test("hydration does not estimate during a live contest", async () => {
  const db = createTestDb();
  const userId = randomUUID();
  seedUser(db, userId, "user0");
  seedFinishedContest(db, 101, "CODING", false);
  seedUnratedProblem(db, 101, "A");

  const client = new FakeClient();
  client.contestPhase = "CODING";
  client.contestEnded = false;
  client.failRatingChanges = true;

  await hydrateUserContestResult(db, userId, "user0", 101, client as never);

  const row = db
    .prepare("SELECT estimated_rating FROM problems WHERE contest_id = 101 AND problem_index = 'A'")
    .get() as { estimated_rating: number | null };
  assert.equal(row.estimated_rating, null);
  db.close();
});

test("metadata estimate pass fills missing estimates from cached rating changes", async () => {
  const db = createTestDb();
  seedFinishedContest(db, 102, "FINISHED", true);
  seedUnratedProblem(db, 102, "A");

  db.prepare(
    `
    INSERT INTO contest_rating_changes_cache (contest_id, raw_json, fetched_at)
    VALUES (102, @rawJson, '2026-01-01T00:00:00.000Z')
  `,
  ).run({ rawJson: JSON.stringify(ratingChanges(102)) });

  const client = new FakeClient();
  const updated = await estimateMissingProblemRatings(db, client as never);
  assert.equal(updated, 1);
  assert.equal(client.standingsCalls, 1);

  const row = db
    .prepare("SELECT estimated_rating FROM problems WHERE contest_id = 102 AND problem_index = 'A'")
    .get() as { estimated_rating: number | null };
  assert.equal(row.estimated_rating, 2000);
  assert.equal(client.ratingChangesCalls, 0);
  db.close();
});

test("metadata estimate pass uses standings when DB contest phase is stale", async () => {
  const db = createTestDb();
  // Local row still says CODING / incomplete duration; standings report FINISHED.
  seedFinishedContest(db, 108, "CODING", true);
  db.prepare("UPDATE contests SET duration_seconds = NULL WHERE id = 108").run();
  seedUnratedProblem(db, 108, "A");

  db.prepare(
    `
    INSERT INTO contest_rating_changes_cache (contest_id, raw_json, fetched_at)
    VALUES (108, @rawJson, '2026-01-01T00:00:00.000Z')
  `,
  ).run({ rawJson: JSON.stringify(ratingChanges(108)) });

  const client = new FakeClient();
  client.contestPhase = "FINISHED";
  client.contestEnded = true;
  const updated = await estimateMissingProblemRatings(db, client as never);
  assert.equal(updated, 1);
  assert.equal(client.standingsCalls, 1);

  const row = db
    .prepare("SELECT estimated_rating FROM problems WHERE contest_id = 108 AND problem_index = 'A'")
    .get() as { estimated_rating: number | null };
  assert.equal(row.estimated_rating, 2000);
  db.close();
});

test("metadata estimate pass skips contests whose DB end time is still in the future", async () => {
  const db = createTestDb();
  seedFinishedContest(db, 109, "CODING", false);
  seedUnratedProblem(db, 109, "A");

  db.prepare(
    `
    INSERT INTO contest_rating_changes_cache (contest_id, raw_json, fetched_at)
    VALUES (109, @rawJson, '2026-01-01T00:00:00.000Z')
  `,
  ).run({ rawJson: JSON.stringify(ratingChanges(109)) });

  const client = new FakeClient();
  client.contestPhase = "FINISHED";
  client.contestEnded = true;
  const updated = await estimateMissingProblemRatings(db, client as never);
  assert.equal(updated, 0);
  assert.equal(client.standingsCalls, 0);
  db.close();
});

test("hydration prefers standings contest metadata over stale DB phase", async () => {
  const db = createTestDb();
  const userId = randomUUID();
  seedUser(db, userId, "user0");
  // Local row still looks live / incomplete, but standings report FINISHED.
  seedFinishedContest(db, 105, "CODING", false);
  db.prepare("UPDATE contests SET duration_seconds = NULL WHERE id = 105").run();
  seedUnratedProblem(db, 105, "A");

  db.prepare(
    `
    INSERT INTO user_contest_results (
      user_id, contest_id, rank, old_rating, new_rating, rating_delta, last_checked_at
    ) VALUES (@userId, 105, 2, 2000, 2000, 0, '2026-01-01T00:00:00.000Z')
  `,
  ).run({ userId });

  const client = new FakeClient();
  client.contestPhase = "FINISHED";
  client.contestEnded = true;
  await hydrateUserContestResult(db, userId, "user0", 105, client as never);

  const row = db
    .prepare("SELECT estimated_rating FROM problems WHERE contest_id = 105 AND problem_index = 'A'")
    .get() as { estimated_rating: number | null };
  assert.equal(row.estimated_rating, 2000);
  db.close();
});

test("estimates do not copy across canonical aliases in paired contests", async () => {
  const db = createTestDb();
  const userId = randomUUID();
  const canonicalId = randomUUID();
  seedUser(db, userId, "user0");
  seedFinishedContest(db, 106, "FINISHED", true);
  seedFinishedContest(db, 107, "FINISHED", true);

  upsertProblemWithTags(
    db,
    {
      contestId: 106,
      problemIndex: "A",
      name: "Shared",
      type: "PROGRAMMING",
      points: null,
      rating: null,
      tags: [],
      url: "https://codeforces.com/contest/106/problem/A",
      rawJson: "{}",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    "catalog",
  );
  upsertProblemWithTags(
    db,
    {
      contestId: 107,
      problemIndex: "D",
      name: "Shared",
      type: "PROGRAMMING",
      points: null,
      rating: null,
      tags: [],
      url: "https://codeforces.com/contest/107/problem/D",
      rawJson: "{}",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    "catalog",
  );
  db.prepare("UPDATE problems SET canonical_id = @canonicalId").run({ canonicalId });

  db.prepare(
    `
    INSERT INTO user_contest_results (
      user_id, contest_id, rank, old_rating, new_rating, rating_delta, last_checked_at
    ) VALUES (@userId, 106, 2, 2000, 2000, 0, '2026-01-01T00:00:00.000Z')
  `,
  ).run({ userId });

  const client = new FakeClient();
  client.solvesA = 5;
  await hydrateUserContestResult(db, userId, "user0", 106, client as never);

  const div2 = db
    .prepare("SELECT estimated_rating FROM problems WHERE contest_id = 106 AND problem_index = 'A'")
    .get() as { estimated_rating: number | null };
  const div1 = db
    .prepare("SELECT estimated_rating FROM problems WHERE contest_id = 107 AND problem_index = 'D'")
    .get() as { estimated_rating: number | null };

  assert.equal(div2.estimated_rating, 2000);
  assert.equal(div1.estimated_rating, null);
  db.close();
});

test("official rating clears estimated rating on catalog upsert", () => {
  const db = createTestDb();
  seedFinishedContest(db, 103, "FINISHED", true);
  seedUnratedProblem(db, 103, "A", 5);
  db.prepare(
    `
    UPDATE problems
    SET estimated_rating = 2000, estimated_rating_at = '2026-01-01T00:00:00.000Z'
    WHERE contest_id = 103 AND problem_index = 'A'
  `,
  ).run();

  upsertProblemWithTags(
    db,
    {
      contestId: 103,
      problemIndex: "A",
      name: "Problem A",
      type: "PROGRAMMING",
      points: null,
      rating: 1600,
      tags: ["math"],
      url: "https://codeforces.com/contest/103/problem/A",
      rawJson: "{}",
      updatedAt: "2026-01-02T00:00:00.000Z",
      solvedCount: 5,
    },
    "catalog",
  );

  const row = db
    .prepare("SELECT rating, estimated_rating FROM problems WHERE contest_id = 103 AND problem_index = 'A'")
    .get() as { rating: number | null; estimated_rating: number | null };
  assert.equal(row.rating, 1600);
  assert.equal(row.estimated_rating, null);
  db.close();
});

test("standings upsert preserves estimate when standings omit rating", () => {
  const db = createTestDb();
  seedFinishedContest(db, 104, "FINISHED", true);
  seedUnratedProblem(db, 104, "A");
  db.prepare(
    `
    UPDATE problems
    SET estimated_rating = 1800, estimated_rating_at = '2026-01-01T00:00:00.000Z'
    WHERE contest_id = 104 AND problem_index = 'A'
  `,
  ).run();

  upsertProblemWithTags(
    db,
    {
      contestId: 104,
      problemIndex: "A",
      name: "Problem A",
      type: "PROGRAMMING",
      points: null,
      rating: null,
      tags: [],
      url: "https://codeforces.com/contest/104/problem/A",
      rawJson: "{}",
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
    "standings",
  );

  const row = db
    .prepare("SELECT rating, estimated_rating FROM problems WHERE contest_id = 104 AND problem_index = 'A'")
    .get() as { rating: number | null; estimated_rating: number | null };
  assert.equal(row.rating, null);
  assert.equal(row.estimated_rating, 1800);
  db.close();
});
