import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { CodeforcesClient } from "../src/cf/client.js";
import { runContestSyncQueue, syncState, syncUserStatus } from "../src/cf/sync.js";
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
        { contestId: 100, index: "Z", name: "Standings Only", rating: 1800, tags: ["math"] },
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

class SubmissionOnlyClient extends FakeClient {
  async userRating(): Promise<CfRatingChange[]> {
    return [];
  }

  async contestRatingChanges(): Promise<CfRatingChange[]> {
    throw new Error("rating changes should not be fetched");
  }

  async contestStandings(): Promise<CfStandings> {
    this.standingsCalls += 1;
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
      ],
      rows: [
        {
          party: {
            contestId: 100,
            members: [{ handle: "someone-else" }],
            participantType: "CONTESTANT",
          },
          rank: 1,
          points: 2,
          penalty: 10,
          problemResults: [
            { points: 1, bestSubmissionTimeSeconds: 100, rejectedAttemptCount: 0 },
            { points: 1, bestSubmissionTimeSeconds: 200, rejectedAttemptCount: 0 },
          ],
        },
      ],
    };
  }
}

class BackfillClient {
  standingsCalls: number[] = [];

  private readonly contestIds = Array.from({ length: 35 }, (_, index) => index + 1);

  async contests(): Promise<CfContest[]> {
    return this.contestIds.map((id) => ({
      id,
      name: `Codeforces Round ${id} (Div. 2)`,
      phase: "FINISHED",
      startTimeSeconds: id * 1000,
      durationSeconds: 7200,
    }));
  }

  async problemset(): Promise<CfProblemset> {
    return {
      problems: this.contestIds.map((id) => ({
        contestId: id,
        index: "A",
        name: `Problem ${id}A`,
        tags: [],
      })),
      problemStatistics: this.contestIds.map((id) => ({
        contestId: id,
        index: "A",
        solvedCount: id,
      })),
    };
  }

  async userStatus(): Promise<CfSubmission[]> {
    return [];
  }

  async userRating(): Promise<CfRatingChange[]> {
    return this.contestIds.map((id) => ({
      contestId: id,
      contestName: `Codeforces Round ${id} (Div. 2)`,
      handle: cfHandle,
      rank: 2,
      ratingUpdateTimeSeconds: id * 1000 + 7200,
      oldRating: 1500,
      newRating: 1510,
    }));
  }

  async contestRatingChanges(contestId: number): Promise<CfRatingChange[]> {
    return [
      {
        contestId,
        contestName: `Codeforces Round ${contestId} (Div. 2)`,
        handle: "winner",
        rank: 1,
        ratingUpdateTimeSeconds: contestId * 1000 + 7200,
        oldRating: 1500,
        newRating: 1600,
      },
      {
        contestId,
        contestName: `Codeforces Round ${contestId} (Div. 2)`,
        handle: cfHandle,
        rank: 2,
        ratingUpdateTimeSeconds: contestId * 1000 + 7200,
        oldRating: 1500,
        newRating: 1510,
      },
    ];
  }

  async contestStandings(contestId: number): Promise<CfStandings> {
    this.standingsCalls.push(contestId);
    return {
      contest: {
        id: contestId,
        name: `Codeforces Round ${contestId} (Div. 2)`,
        startTimeSeconds: contestId * 1000,
        durationSeconds: 7200,
      },
      problems: [
        { contestId, index: "A", name: `Problem ${contestId}A`, tags: [] },
      ],
      rows: [
        {
          party: {
            contestId,
            members: [{ handle: cfHandle }],
            participantType: "CONTESTANT",
          },
          rank: 2,
          points: 1,
          penalty: 10,
          problemResults: [
            { points: 1, bestSubmissionTimeSeconds: 100, rejectedAttemptCount: 0 },
          ],
        },
      ],
    };
  }
}

test("user sync imports standings-only contest problems before writing contest results", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  insertUser(db);
  syncState.catalogRunning = false;
  syncState.userRunning.clear();

  try {
    const client = new FakeClient();
    await syncUserStatus(db, userId, cfHandle, client as unknown as CodeforcesClient);
    assert.equal(client.standingsCalls, 0);
    await runContestSyncQueue(db, client as unknown as CodeforcesClient);
    await syncUserStatus(db, userId, cfHandle, client as unknown as CodeforcesClient);

    const contestRows = db.prepare("SELECT COUNT(*) AS count FROM user_contest_results").get() as { count: number };
    const problemRows = db.prepare("SELECT COUNT(*) AS count FROM user_contest_problem_results").get() as { count: number };
    const catalogProblemRows = db.prepare("SELECT COUNT(*) AS count FROM problems").get() as { count: number };
    const standingsOnlyProblem = db
      .prepare("SELECT name, rating, solved_count, tags_json FROM problems WHERE contest_id = 100 AND problem_index = 'Z'")
      .get() as { name: string; rating: number; solved_count: number | null; tags_json: string };
    const problemsetProblem = db
      .prepare("SELECT solved_count FROM problems WHERE contest_id = 100 AND problem_index = 'B'")
      .get() as { solved_count: number };
    const upsolved = db
      .prepare("SELECT upsolved FROM user_contest_problem_results WHERE problem_index = 'B'")
      .get() as { upsolved: number };

    assert.equal(client.ratingChangesCalls, 1);
    assert.equal(client.standingsCalls, 1);
    assert.equal(contestRows.count, 1);
    assert.equal(problemRows.count, 3);
    assert.equal(catalogProblemRows.count, 3);
    assert.deepEqual({ ...standingsOnlyProblem }, {
      name: "Standings Only",
      rating: 1800,
      solved_count: null,
      tags_json: JSON.stringify(["math"]),
    });
    assert.equal(problemsetProblem.solved_count, 50);
    assert.equal(upsolved.upsolved, 1);
  } finally {
    db.close();
    syncState.userRunning.clear();
    syncState.contestQueueRunning = false;
  }
});

test("contest hydration falls back to accepted submissions when standings row is absent", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  insertUser(db);
  syncState.catalogRunning = false;
  syncState.userRunning.clear();

  try {
    const client = new SubmissionOnlyClient();
    await syncUserStatus(db, userId, cfHandle, client as unknown as CodeforcesClient);
    await runContestSyncQueue(db, client as unknown as CodeforcesClient);

    const contest = db
      .prepare("SELECT rank, points, old_rating, new_rating FROM user_contest_results WHERE contest_id = 100")
      .get() as { rank: number | null; points: number | null; old_rating: number | null; new_rating: number | null };
    const problems = db
      .prepare(
        `
        SELECT problem_index, solved_in_contest, upsolved, best_submission_time_seconds
        FROM user_contest_problem_results
        ORDER BY problem_index
      `,
      )
      .all() as { problem_index: string; solved_in_contest: number; upsolved: number; best_submission_time_seconds: number | null }[];

    assert.deepEqual({ ...contest }, { rank: null, points: null, old_rating: null, new_rating: null });
    assert.deepEqual(problems.map((problem) => ({ ...problem })), [
      { problem_index: "A", solved_in_contest: 1, upsolved: 0, best_submission_time_seconds: 200 },
      { problem_index: "B", solved_in_contest: 0, upsolved: 1, best_submission_time_seconds: null },
    ]);
  } finally {
    db.close();
    syncState.userRunning.clear();
    syncState.contestQueueRunning = false;
  }
});

test("user sync backfills a few older unsynced contests on each refresh", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  insertUser(db);
  syncState.catalogRunning = false;
  syncState.userRunning.clear();

  try {
    const client = new BackfillClient();
    await syncUserStatus(db, userId, cfHandle, client as unknown as CodeforcesClient);

    let contestRows = db.prepare("SELECT COUNT(*) AS count FROM user_contest_results").get() as { count: number };
    let queuedRows = db.prepare("SELECT COUNT(*) AS count FROM contest_sync_jobs WHERE status = 'queued'").get() as { count: number };
    assert.equal(contestRows.count, 35);
    assert.equal(queuedRows.count, 33);
    assert.deepEqual(client.standingsCalls, []);

    await runContestSyncQueue(db, client as unknown as CodeforcesClient);
    assert.deepEqual(client.standingsCalls.slice().sort((a, b) => b - a), [
      35, 34, 33, 32, 31, 30, 29, 28, 27, 26,
      25, 24, 23, 22, 21, 20, 19, 18, 17, 16,
      15, 14, 13, 12, 11, 10, 9, 8, 7, 6,
      5, 4, 3,
    ]);

    await syncUserStatus(db, userId, cfHandle, client as unknown as CodeforcesClient);

    contestRows = db.prepare("SELECT COUNT(*) AS count FROM user_contest_results").get() as { count: number };
    queuedRows = db.prepare("SELECT COUNT(*) AS count FROM contest_sync_jobs WHERE status = 'queued'").get() as { count: number };
    assert.equal(contestRows.count, 35);
    assert.equal(queuedRows.count, 2);
    await runContestSyncQueue(db, client as unknown as CodeforcesClient);
    assert.deepEqual(client.standingsCalls.slice().sort((a, b) => b - a), [
      35, 34, 33, 32, 31, 30, 29, 28, 27, 26,
      25, 24, 23, 22, 21, 20, 19, 18, 17, 16,
      15, 14, 13, 12, 11, 10, 9, 8, 7, 6,
      5, 4, 3, 2, 1,
    ]);
  } finally {
    db.close();
    syncState.userRunning.clear();
    syncState.contestQueueRunning = false;
  }
});

test("user sync commits problem solved status before queued contest refresh work", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  insertUser(db);
  syncState.catalogRunning = false;
  syncState.userRunning.clear();

  try {
    const client = new FakeClient();
    client.failStandings = true;

    await syncUserStatus(db, userId, cfHandle, client as unknown as CodeforcesClient);
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
      await runContestSyncQueue(db, client as unknown as CodeforcesClient);
    } finally {
      console.error = originalConsoleError;
    }

    const solvedRows = db.prepare("SELECT COUNT(*) AS count FROM user_problem_status").get() as { count: number };
    const contestRows = db.prepare("SELECT COUNT(*) AS count FROM user_contest_results").get() as { count: number };
    const contestProblemRows = db.prepare("SELECT COUNT(*) AS count FROM user_contest_problem_results").get() as { count: number };
    const syncRun = db
      .prepare("SELECT status FROM sync_runs WHERE source = 'codeforces:user' ORDER BY id DESC LIMIT 1")
      .get() as { status: string };
    const job = db
      .prepare("SELECT status, last_error FROM contest_sync_jobs ORDER BY id DESC LIMIT 1")
      .get() as { status: string; last_error: string };

    assert.equal(solvedRows.count, 2);
    assert.equal(contestRows.count, 1);
    assert.equal(contestProblemRows.count, 0);
    assert.equal(syncRun.status, "success");
    assert.equal(job.status, "failed");
    assert.match(job.last_error, /standings failed/);
  } finally {
    db.close();
    syncState.userRunning.clear();
    syncState.contestQueueRunning = false;
  }
});

test("contest queue reclaims stale running jobs after restart", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  insertUser(db);
  syncState.catalogRunning = false;
  syncState.userRunning.clear();
  syncState.contestQueueRunning = false;

  try {
    const client = new FakeClient();
    await syncUserStatus(db, userId, cfHandle, client as unknown as CodeforcesClient);

    const staleStartedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    db.prepare(
      `
      UPDATE contest_sync_jobs
      SET status = 'running', attempts = 1, started_at = @startedAt
    `,
    ).run({ startedAt: staleStartedAt });

    const processed = await runContestSyncQueue(db, client as unknown as CodeforcesClient);
    const job = db
      .prepare("SELECT status, attempts FROM contest_sync_jobs ORDER BY id DESC LIMIT 1")
      .get() as { status: string; attempts: number };
    const problemRows = db.prepare("SELECT COUNT(*) AS count FROM user_contest_problem_results").get() as { count: number };

    assert.equal(processed, 1);
    assert.deepEqual({ ...job }, { status: "done", attempts: 2 });
    assert.equal(problemRows.count, 3);
  } finally {
    db.close();
    syncState.userRunning.clear();
    syncState.contestQueueRunning = false;
  }
});
