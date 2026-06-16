import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { CodeforcesClient } from "../src/cf/client.js";
import { syncState, syncUserStatus } from "../src/cf/sync.js";
import type { CfContest, CfProblemset, CfRatingChange, CfStandings, CfSubmission } from "../src/cf/types.js";
import { migrate } from "../src/db/migrate.js";

const userId = "user-1";
const cfHandle = "inj";

const insertUser = (db: DatabaseSync): void => {
  db.prepare(
    `
    INSERT INTO "user" (
      id,
      name,
      email,
      emailVerified,
      createdAt,
      updatedAt,
      cfHandle
    ) VALUES (
      @id,
      'Test User',
      'user@example.com',
      0,
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      @cfHandle
    )
  `,
  ).run({ id: userId, cfHandle });
};

class FakeClient {
  ratingChangesCalls = 0;
  standingsCalls = 0;
  failStandings = false;

  async contests(): Promise<CfContest[]> {
    return [
      {
        id: 100,
        name: "Codeforces Round 100 (Div. 2)",
        phase: "FINISHED",
        startTimeSeconds: 1000,
        durationSeconds: 7200,
      },
    ];
  }

  async problemset(): Promise<CfProblemset> {
    return {
      problems: [
        { contestId: 100, index: "A", name: "A", tags: [] },
        { contestId: 100, index: "B", name: "B", tags: [] },
      ],
      problemStatistics: [
        { contestId: 100, index: "A", solvedCount: 100 },
        { contestId: 100, index: "B", solvedCount: 50 },
      ],
    };
  }

  async userStatus(): Promise<CfSubmission[]> {
    return [
      {
        id: 1,
        contestId: 100,
        creationTimeSeconds: 1200,
        verdict: "OK",
        problem: { contestId: 100, index: "A", name: "A", tags: [] },
      },
      {
        id: 2,
        contestId: 100,
        creationTimeSeconds: 9000,
        verdict: "OK",
        problem: { contestId: 100, index: "B", name: "B", tags: [] },
      },
    ];
  }

  async userRating(): Promise<CfRatingChange[]> {
    return [
      {
        contestId: 100,
        contestName: "Codeforces Round 100 (Div. 2)",
        handle: cfHandle,
        rank: 2,
        ratingUpdateTimeSeconds: 9000,
        oldRating: 1500,
        newRating: 1510,
      },
    ];
  }

  async contestRatingChanges(): Promise<CfRatingChange[]> {
    this.ratingChangesCalls += 1;
    return [
      {
        contestId: 100,
        contestName: "Codeforces Round 100 (Div. 2)",
        handle: "winner",
        rank: 1,
        ratingUpdateTimeSeconds: 9000,
        oldRating: 1500,
        newRating: 1600,
      },
      {
        contestId: 100,
        contestName: "Codeforces Round 100 (Div. 2)",
        handle: cfHandle,
        rank: 2,
        ratingUpdateTimeSeconds: 9000,
        oldRating: 1500,
        newRating: 1510,
      },
    ];
  }

  async contestStandings(): Promise<CfStandings> {
    this.standingsCalls += 1;
    if (this.failStandings) throw new Error("standings failed");
    return {
      contest: {
        id: 100,
        name: "Codeforces Round 100 (Div. 2)",
        startTimeSeconds: 1000,
        durationSeconds: 7200,
      },
      problems: [
        { contestId: 100, index: "A", name: "A", tags: [] },
        { contestId: 100, index: "B", name: "B", tags: [] },
        { contestId: 100, index: "Z", name: "Not in local catalog", tags: [] },
      ],
      rows: [
        {
          party: {
            contestId: 100,
            members: [{ handle: cfHandle }],
            participantType: "CONTESTANT",
          },
          rank: 2,
          points: 1,
          penalty: 30,
          problemResults: [
            { points: 1, bestSubmissionTimeSeconds: 1200, rejectedAttemptCount: 0 },
            { points: 0, rejectedAttemptCount: 0 },
            { points: 0, rejectedAttemptCount: 0 },
          ],
        },
      ],
    };
  }
}

test("user sync caches contest API data and skips standings problems absent from local catalog", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  insertUser(db);
  syncState.catalogRunning = false;
  syncState.userRunning.clear();

  try {
    const client = new FakeClient();
    await syncUserStatus(db, userId, cfHandle, client as unknown as CodeforcesClient);
    await syncUserStatus(db, userId, cfHandle, client as unknown as CodeforcesClient);

    const contestRows = db.prepare("SELECT COUNT(*) AS count FROM user_contest_results").get() as { count: number };
    const problemRows = db.prepare("SELECT COUNT(*) AS count FROM user_contest_problem_results").get() as { count: number };
    const upsolved = db
      .prepare("SELECT upsolved FROM user_contest_problem_results WHERE problem_index = 'B'")
      .get() as { upsolved: number };

    assert.equal(client.ratingChangesCalls, 1);
    assert.equal(client.standingsCalls, 1);
    assert.equal(contestRows.count, 1);
    assert.equal(problemRows.count, 2);
    assert.equal(upsolved.upsolved, 1);
  } finally {
    db.close();
    syncState.userRunning.clear();
  }
});

test("user sync commits problem solved status before contest refresh work", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  insertUser(db);
  syncState.catalogRunning = false;
  syncState.userRunning.clear();

  try {
    const client = new FakeClient();
    client.failStandings = true;

    await assert.rejects(
      syncUserStatus(db, userId, cfHandle, client as unknown as CodeforcesClient),
      /standings failed/,
    );

    const solvedRows = db.prepare("SELECT COUNT(*) AS count FROM user_problem_status").get() as { count: number };
    const contestRows = db.prepare("SELECT COUNT(*) AS count FROM user_contest_results").get() as { count: number };
    const syncRun = db
      .prepare("SELECT status FROM sync_runs WHERE source = 'codeforces:user' ORDER BY id DESC LIMIT 1")
      .get() as { status: string };

    assert.equal(solvedRows.count, 2);
    assert.equal(contestRows.count, 0);
    assert.equal(syncRun.status, "failed");
  } finally {
    db.close();
    syncState.userRunning.clear();
  }
});
