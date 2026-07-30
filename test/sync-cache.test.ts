import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CodeforcesClient } from "../src/cf/client.js";
import { runContestSyncQueue, syncState, syncUserStatus } from "../src/cf/sync.js";
import { enqueueContestHydrationJobs } from "../src/cf/sync/contest-queue.js";
import type { CfContest, CfProblemset, CfRatingChange, CfStandings, CfSubmission } from "../src/cf/types.js";
import { migrate } from "../src/db/migrate.js";

const recentCatalogSyncAt = new Date(Date.now() - 60_000).toISOString();
const userId = "user-1";
const cfHandle = "inj";

test("contestStandings requests contestId without extra parameters", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({
      status: "OK",
      result: {
        contest: { id: 100, name: "Round 100" },
        problems: [],
        rows: [],
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    await new CodeforcesClient(0).contestStandings(100);
    const url = new URL(requestedUrl);
    assert.equal(url.pathname, "/api/contest.standings");
    assert.equal(url.searchParams.get("contestId"), "100");
    assert.equal([...url.searchParams.keys()].sort().join(","), "contestId");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

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

  async contestStandings(_contestId = 100): Promise<CfStandings> {
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

class OmittedAcceptedProblemClient extends FakeClient {
  async problemset(): Promise<CfProblemset> {
    return {
      problems: [
        { contestId: 100, index: "A", name: "A", tags: [] },
      ],
      problemStatistics: [
        { contestId: 100, index: "A", solvedCount: 100 },
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

  async contestStandings(_contestId = 100): Promise<CfStandings> {
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
      rows: [],
    };
  }
}

class SharedDivisionClient extends SubmissionOnlyClient {
  async contests(): Promise<CfContest[]> {
    return [
      {
        id: 201,
        name: "Codeforces Round 201 (Div. 1)",
        phase: "FINISHED",
        startTimeSeconds: 1000,
        durationSeconds: 7200,
      },
      {
        id: 202,
        name: "Codeforces Round 201 (Div. 2)",
        phase: "FINISHED",
        startTimeSeconds: 1000,
        durationSeconds: 7200,
      },
    ];
  }

  async problemset(): Promise<CfProblemset> {
    return {
      problems: [
        { contestId: 202, index: "C", name: "Shared Task", tags: [] },
        { contestId: 202, index: "D", name: "Different Task", tags: [] },
      ],
      problemStatistics: [
        { contestId: 202, index: "C", solvedCount: 100 },
        { contestId: 202, index: "D", solvedCount: 50 },
      ],
    };
  }

  async userStatus(): Promise<CfSubmission[]> {
    return [
      {
        id: 1,
        contestId: 201,
        creationTimeSeconds: 1200,
        verdict: "OK",
        problem: { contestId: 201, index: "A", name: "Shared Task", tags: [] },
      },
    ];
  }

  async contestStandings(contestId = 201): Promise<CfStandings> {
    this.standingsCalls += 1;
    const isDiv1 = contestId === 201;
    return {
      contest: {
        id: contestId,
        name: `Codeforces Round 201 (${isDiv1 ? "Div. 1" : "Div. 2"})`,
        startTimeSeconds: 1000,
        durationSeconds: 7200,
      },
      problems: isDiv1
        ? [{ contestId: 201, index: "A", name: "Shared Task", tags: [] }]
        : [
            { contestId: 202, index: "C", name: "Shared Task", tags: [] },
            { contestId: 202, index: "D", name: "Different Task", tags: [] },
          ],
      rows: [],
    };
  }
}

class StandingsDiscoveredSharedDivisionClient extends SharedDivisionClient {
  constructor(private readonly acceptedAt = 1200) {
    super();
  }

  async problemset(): Promise<CfProblemset> {
    return {
      problems: [
        { contestId: 201, index: "A", name: "Shared Task", tags: [] },
        { contestId: 202, index: "D", name: "Different Task", tags: [] },
      ],
      problemStatistics: [
        { contestId: 201, index: "A", solvedCount: 100 },
        { contestId: 202, index: "D", solvedCount: 50 },
      ],
    };
  }

  async userStatus(): Promise<CfSubmission[]> {
    const [submission] = await super.userStatus();
    return [{ ...submission!, creationTimeSeconds: this.acceptedAt }];
  }
}

class UnsharedPairedDivisionClient extends StandingsDiscoveredSharedDivisionClient {
  async contestStandings(contestId = 201): Promise<CfStandings> {
    if (contestId === 201) return super.contestStandings(contestId);
    this.standingsCalls += 1;
    return {
      contest: {
        id: 202,
        name: "Codeforces Round 201 (Div. 2)",
        startTimeSeconds: 1000,
        durationSeconds: 7200,
      },
      problems: [
        { contestId: 202, index: "D", name: "Different Task", tags: [] },
      ],
      rows: [],
    };
  }
}

class UpsolveOnlyClient extends FakeClient {
  async userStatus(): Promise<CfSubmission[]> {
    return [
      {
        id: 1,
        contestId: 100,
        creationTimeSeconds: 9000,
        verdict: "OK",
        problem: { contestId: 100, index: "B", name: "B", tags: [] },
      },
    ];
  }

  async userRating(): Promise<CfRatingChange[]> {
    return [];
  }

  async contestRatingChanges(): Promise<CfRatingChange[]> {
    throw new Error("rating changes should not be fetched");
  }

  async contestStandings(_contestId = 100): Promise<CfStandings> {
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
      rows: [],
    };
  }
}

class CatalogCatchUpClient extends FakeClient {
  contestsCalls = 0;

  async contests(): Promise<CfContest[]> {
    this.contestsCalls += 1;
    return [
      {
        id: 100,
        name: "Codeforces Round 100 (Div. 2)",
        phase: "FINISHED",
        startTimeSeconds: 1000,
        durationSeconds: 7200,
      },
      {
        id: 200,
        name: "Codeforces Round 200 (Div. 2)",
        phase: "FINISHED",
        startTimeSeconds: 2_000_000,
        durationSeconds: 7200,
      },
    ];
  }

  async problemset(): Promise<CfProblemset> {
    return {
      problems: [
        { contestId: 100, index: "A", name: "A", tags: [] },
        { contestId: 200, index: "A", name: "Problem 200A", tags: [] },
      ],
      problemStatistics: [
        { contestId: 100, index: "A", solvedCount: 100 },
        { contestId: 200, index: "A", solvedCount: 50 },
      ],
    };
  }

  async userRating(): Promise<CfRatingChange[]> {
    return [
      {
        contestId: 200,
        contestName: "Codeforces Round 200 (Div. 2)",
        handle: cfHandle,
        rank: 10,
        ratingUpdateTimeSeconds: 2_000_000,
        oldRating: 1500,
        newRating: 1510,
      },
    ];
  }

  async userStatus(): Promise<CfSubmission[]> {
    return [];
  }

  async contestRatingChanges(): Promise<CfRatingChange[]> {
    throw new Error("contest hydration should not run in catalog catch-up test");
  }

  async contestStandings(): Promise<CfStandings> {
    throw new Error("contest hydration should not run in catalog catch-up test");
  }
}

class StaleCatalogClient extends FakeClient {
  contestsCalls = 0;

  async contests(): Promise<CfContest[]> {
    this.contestsCalls += 1;
    return [];
  }

  async problemset(): Promise<CfProblemset> {
    return { problems: [], problemStatistics: [] };
  }

  async userRating(): Promise<CfRatingChange[]> {
    return [
      {
        contestId: 200,
        contestName: "Codeforces Round 200 (Div. 2)",
        handle: cfHandle,
        rank: 10,
        ratingUpdateTimeSeconds: 2_000_000,
        oldRating: 1500,
        newRating: 1510,
      },
    ];
  }

  async userStatus(): Promise<CfSubmission[]> {
    return [];
  }

  async contestRatingChanges(): Promise<CfRatingChange[]> {
    throw new Error("contest hydration should not run in stale catalog test");
  }

  async contestStandings(): Promise<CfStandings> {
    throw new Error("contest hydration should not run in stale catalog test");
  }
}

class NoopHydrationClient extends FakeClient {
  async userStatus(): Promise<CfSubmission[]> {
    return [
      {
        id: 1,
        contestId: 100,
        creationTimeSeconds: 1200,
        verdict: "WRONG_ANSWER",
        problem: { contestId: 100, index: "A", name: "A", tags: [] },
      },
    ];
  }

  async userRating(): Promise<CfRatingChange[]> {
    return [];
  }

  async contestRatingChanges(): Promise<CfRatingChange[]> {
    throw new Error("rating changes should not be fetched");
  }

  async contestStandings(_contestId = 100): Promise<CfStandings> {
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
      ],
      rows: [],
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

test("failed in-contest submissions do not create contest rows or hydration jobs", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  insertUser(db);
  syncState.catalogRunning = false;
  syncState.userRunning.clear();
  syncState.contestQueueRunning = false;

  try {
    const client = new NoopHydrationClient();
    await syncUserStatus(db, userId, cfHandle, client as unknown as CodeforcesClient);

    const contestRows = db.prepare("SELECT COUNT(*) AS count FROM user_contest_results").get() as { count: number };
    const jobRows = db.prepare("SELECT COUNT(*) AS count FROM contest_sync_jobs").get() as { count: number };

    assert.equal(contestRows.count, 0);
    assert.equal(jobRows.count, 0);
    assert.equal(client.standingsCalls, 0);
  } finally {
    db.close();
    syncState.userRunning.clear();
    syncState.contestQueueRunning = false;
  }
});

test("contest queue finishes noop hydration jobs instead of requeuing forever", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  insertUser(db);
  syncState.catalogRunning = false;
  syncState.userRunning.clear();
  syncState.contestQueueRunning = false;

  try {
    const client = new NoopHydrationClient();
    await syncUserStatus(db, userId, cfHandle, client as unknown as CodeforcesClient);
    enqueueContestHydrationJobs(db, userId, cfHandle, [{ contestId: 100, priority: 0 }]);
    await runContestSyncQueue(db, client as unknown as CodeforcesClient);

    const job = db
      .prepare("SELECT status, attempts FROM contest_sync_jobs WHERE contest_id = 100")
      .get() as { status: string; attempts: number };
    const problemRows = db.prepare("SELECT COUNT(*) AS count FROM user_contest_problem_results").get() as { count: number };

    assert.deepEqual({ ...job }, { status: "done", attempts: 1 });
    assert.equal(problemRows.count, 0);
    assert.equal(client.standingsCalls, 1);
  } finally {
    db.close();
    syncState.userRunning.clear();
    syncState.contestQueueRunning = false;
  }
});

test("user sync re-enqueues recent contests with done job but no problem pills", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  insertUser(db);
  db.prepare(
    `
    INSERT INTO contests (id, name, start_time_seconds, duration_seconds, raw_json, updated_at)
    VALUES (100, 'Codeforces Round 100 (Div. 2)', 1000, 7200, '{}', '2026-01-01T00:00:00.000Z')
  `,
  ).run();
  db.prepare(
    `
    INSERT INTO sync_runs (started_at, finished_at, status, source, message)
    VALUES (@finishedAt, @finishedAt, 'success', 'codeforces:catalog', 'fresh')
  `,
  ).run({ finishedAt: recentCatalogSyncAt });
  db.prepare(
    `
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
      last_checked_at
    ) VALUES (
      @userId,
      100,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      '2026-01-01T00:00:00.000Z'
    )
  `,
  ).run({ userId });
  db.prepare(
    `
    INSERT INTO contest_sync_jobs (
      user_id,
      cf_handle,
      contest_id,
      priority,
      status,
      attempts,
      available_at,
      created_at,
      updated_at
    ) VALUES (
      @userId,
      @cfHandle,
      100,
      0,
      'done',
      1,
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z'
    )
  `,
  ).run({ userId, cfHandle });
  syncState.catalogRunning = false;
  syncState.userRunning.clear();
  syncState.contestQueueRunning = false;

  try {
    const client = new UpsolveOnlyClient();
    await syncUserStatus(db, userId, cfHandle, client as unknown as CodeforcesClient);

    const job = db
      .prepare("SELECT status FROM contest_sync_jobs WHERE contest_id = 100")
      .get() as { status: string };
    assert.equal(job.status, "done");

    const problemRows = db
      .prepare("SELECT COUNT(*) AS count FROM user_contest_problem_results")
      .get() as { count: number };
    const upsolved = db
      .prepare("SELECT upsolved FROM user_contest_problem_results WHERE problem_index = 'B'")
      .get() as { upsolved: number };

    assert.equal(problemRows.count, 2);
    assert.equal(upsolved.upsolved, 1);
  } finally {
    db.close();
    syncState.userRunning.clear();
    syncState.contestQueueRunning = false;
  }
});

test("user sync keeps completed contest jobs done unless hydration is incomplete", async () => {
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
    await runContestSyncQueue(db, client as unknown as CodeforcesClient);
    const hydratedAt = db
      .prepare("SELECT standings_checked_at FROM user_contest_results WHERE contest_id = 100")
      .get() as { standings_checked_at: string };
    await syncUserStatus(db, userId, cfHandle, client as unknown as CodeforcesClient);

    const job = db
      .prepare("SELECT status FROM contest_sync_jobs WHERE contest_id = 100")
      .get() as { status: string };
    const afterBasicSync = db
      .prepare("SELECT standings_checked_at FROM user_contest_results WHERE contest_id = 100")
      .get() as { standings_checked_at: string };
    assert.equal(job.status, "done");
    assert.equal(client.standingsCalls, 1);
    assert.equal(afterBasicSync.standings_checked_at, hydratedAt.standings_checked_at);
  } finally {
    db.close();
    syncState.userRunning.clear();
    syncState.contestQueueRunning = false;
  }
});

test("user sync forces catalog refresh when user data references missing contests", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  insertUser(db);
  db.prepare(
    `
    INSERT INTO contests (id, name, raw_json, updated_at)
    VALUES (100, 'Old contest', '{}', '2026-01-01T00:00:00.000Z')
  `,
  ).run();
  db.prepare(
    `
    INSERT INTO problems (
      contest_id,
      problem_index,
      name,
      rating,
      solved_count,
      tags_json,
      url,
      raw_json,
      updated_at,
      canonical_id
    ) VALUES (
      100,
      'A',
      'A',
      800,
      1,
      '[]',
      'https://codeforces.com/contest/100/problem/A',
      '{}',
      '2026-01-01T00:00:00.000Z',
      @canonicalId
    )
  `,
  ).run({ canonicalId: randomUUID() });
  db.prepare(
    `
    INSERT INTO sync_runs (started_at, finished_at, status, source, message)
    VALUES (@finishedAt, @finishedAt, 'success', 'codeforces:catalog', 'fresh')
  `,
  ).run({ finishedAt: recentCatalogSyncAt });
  syncState.catalogRunning = false;
  syncState.userRunning.clear();
  syncState.contestQueueRunning = false;

  try {
    const client = new CatalogCatchUpClient();
    await syncUserStatus(db, userId, cfHandle, client as unknown as CodeforcesClient);

    const contest = db
      .prepare("SELECT id, name, derived_family, duration_seconds FROM contests WHERE id = 200")
      .get() as { id: number; name: string; derived_family: string | null; duration_seconds: number | null };
    const contestRows = db.prepare("SELECT COUNT(*) AS count FROM user_contest_results").get() as { count: number };
    const problemRows = db.prepare("SELECT COUNT(*) AS count FROM problems WHERE contest_id = 200").get() as { count: number };

    assert.equal(client.contestsCalls, 1);
    assert.equal(contest.id, 200);
    assert.equal(contest.name, "Codeforces Round 200 (Div. 2)");
    assert.equal(contest.derived_family, "Codeforces Round");
    assert.equal(contest.duration_seconds, 7200);
    assert.equal(contestRows.count, 1);
    assert.equal(problemRows.count, 1);
  } finally {
    db.close();
    syncState.userRunning.clear();
    syncState.contestQueueRunning = false;
  }
});

test("user sync falls back to contest stubs when catalog refresh still misses a contest", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  insertUser(db);
  db.prepare(
    `
    INSERT INTO contests (id, name, raw_json, updated_at)
    VALUES (100, 'Old contest', '{}', '2026-01-01T00:00:00.000Z')
  `,
  ).run();
  db.prepare(
    `
    INSERT INTO problems (
      contest_id,
      problem_index,
      name,
      rating,
      solved_count,
      tags_json,
      url,
      raw_json,
      updated_at,
      canonical_id
    ) VALUES (
      100,
      'A',
      'A',
      800,
      1,
      '[]',
      'https://codeforces.com/contest/100/problem/A',
      '{}',
      '2026-01-01T00:00:00.000Z',
      @canonicalId
    )
  `,
  ).run({ canonicalId: randomUUID() });
  db.prepare(
    `
    INSERT INTO sync_runs (started_at, finished_at, status, source, message)
    VALUES (@finishedAt, @finishedAt, 'success', 'codeforces:catalog', 'fresh')
  `,
  ).run({ finishedAt: recentCatalogSyncAt });
  syncState.catalogRunning = false;
  syncState.userRunning.clear();
  syncState.contestQueueRunning = false;

  try {
    const client = new StaleCatalogClient();
    await syncUserStatus(db, userId, cfHandle, client as unknown as CodeforcesClient);

    const contest = db
      .prepare("SELECT id, name FROM contests WHERE id = 200")
      .get() as { id: number; name: string };
    const contestRows = db.prepare("SELECT COUNT(*) AS count FROM user_contest_results").get() as { count: number };

    assert.equal(contest.id, 200);
    assert.equal(contest.name, "Codeforces Round 200 (Div. 2)");
    assert.equal(client.contestsCalls, 1);
    assert.equal(contestRows.count, 1);
  } finally {
    db.close();
    syncState.userRunning.clear();
    syncState.contestQueueRunning = false;
  }
});

test("user sync includes upsolve-only contests discovered from accepted submissions", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  insertUser(db);
  syncState.catalogRunning = false;
  syncState.userRunning.clear();
  syncState.contestQueueRunning = false;

  try {
    const client = new UpsolveOnlyClient();
    await syncUserStatus(db, userId, cfHandle, client as unknown as CodeforcesClient);
    await runContestSyncQueue(db, client as unknown as CodeforcesClient);

    const contestRows = db.prepare("SELECT COUNT(*) AS count FROM user_contest_results").get() as { count: number };
    const upsolved = db
      .prepare("SELECT upsolved FROM user_contest_problem_results WHERE problem_index = 'B'")
      .get() as { upsolved: number };

    assert.equal(contestRows.count, 1);
    assert.equal(upsolved.upsolved, 1);
  } finally {
    db.close();
    syncState.userRunning.clear();
    syncState.contestQueueRunning = false;
  }
});

test("user sync marks shared Div. 1 and Div. 2 placements solved", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  insertUser(db);
  syncState.catalogRunning = false;
  syncState.userRunning.clear();
  syncState.contestQueueRunning = false;

  try {
    const client = new SharedDivisionClient();
    await syncUserStatus(db, userId, cfHandle, client as unknown as CodeforcesClient);

    const exactStatuses = db
      .prepare(`SELECT contest_id, problem_index FROM user_problem_status ORDER BY contest_id`)
      .all() as { contest_id: number; problem_index: string }[];
    const contestResults = db
      .prepare(
        `
        SELECT contest_id, problem_index, solved_in_contest, upsolved
        FROM user_contest_problem_results
        WHERE solved_in_contest = 1 OR upsolved = 1
        ORDER BY contest_id
      `,
      )
      .all() as {
        contest_id: number;
        problem_index: string;
        solved_in_contest: number;
        upsolved: number;
      }[];

    assert.deepEqual(exactStatuses.map((row) => ({ ...row })), [
      { contest_id: 201, problem_index: "A" },
    ]);
    assert.deepEqual(contestResults.map((row) => ({ ...row })), [
      { contest_id: 201, problem_index: "A", solved_in_contest: 1, upsolved: 0 },
      { contest_id: 202, problem_index: "C", solved_in_contest: 1, upsolved: 0 },
    ]);
  } finally {
    db.close();
    syncState.userRunning.clear();
    syncState.contestQueueRunning = false;
  }
});

for (const scenario of [
  { label: "solved", acceptedAt: 1200, solvedInContest: 1, upsolved: 0 },
  { label: "upsolved", acceptedAt: 9000, solvedInContest: 0, upsolved: 1 },
]) {
  test(`first user sync marks standings-discovered shared placements ${scenario.label}`, async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
    insertUser(db);
    syncState.catalogRunning = false;
    syncState.userRunning.clear();
    syncState.contestQueueRunning = false;

    try {
      const client = new StandingsDiscoveredSharedDivisionClient(scenario.acceptedAt);
      await syncUserStatus(db, userId, cfHandle, client as unknown as CodeforcesClient);

      const exactStatuses = db
        .prepare(`SELECT contest_id, problem_index FROM user_problem_status`)
        .all() as { contest_id: number; problem_index: string }[];
      const contestResults = db
        .prepare(
          `
          SELECT contest_id, problem_index, solved_in_contest, upsolved
          FROM user_contest_problem_results
          ORDER BY contest_id, problem_index
        `,
        )
        .all() as {
          contest_id: number;
          problem_index: string;
          solved_in_contest: number;
          upsolved: number;
        }[];

      assert.deepEqual(exactStatuses.map((row) => ({ ...row })), [
        { contest_id: 201, problem_index: "A" },
      ]);
      assert.deepEqual(contestResults.map((row) => ({ ...row })), [
        {
          contest_id: 201,
          problem_index: "A",
          solved_in_contest: scenario.solvedInContest,
          upsolved: scenario.upsolved,
        },
        { contest_id: 202, problem_index: "C", solved_in_contest: scenario.solvedInContest, upsolved: scenario.upsolved },
        { contest_id: 202, problem_index: "D", solved_in_contest: 0, upsolved: 0 },
      ]);
    } finally {
      db.close();
      syncState.userRunning.clear();
      syncState.contestQueueRunning = false;
    }
  });
}

test("paired-contest probing does not create a blank contest result", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  insertUser(db);
  syncState.catalogRunning = false;
  syncState.userRunning.clear();
  syncState.contestQueueRunning = false;

  try {
    const client = new UnsharedPairedDivisionClient();
    await syncUserStatus(db, userId, cfHandle, client as unknown as CodeforcesClient);

    const counterpart = db
      .prepare("SELECT contest_id FROM user_contest_results WHERE contest_id = 202")
      .get();
    const counterpartPills = db
      .prepare("SELECT COUNT(*) AS count FROM user_contest_problem_results WHERE contest_id = 202")
      .get() as { count: number };

    assert.equal(counterpart, undefined);
    assert.equal(counterpartPills.count, 0);
  } finally {
    db.close();
    syncState.userRunning.clear();
    syncState.contestQueueRunning = false;
  }
});

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
    assert.equal(client.standingsCalls, 1);
    await syncUserStatus(db, userId, cfHandle, client as unknown as CodeforcesClient);

    const contestRows = db.prepare("SELECT COUNT(*) AS count FROM user_contest_results").get() as { count: number };
    const problemRows = db.prepare("SELECT COUNT(*) AS count FROM user_contest_problem_results").get() as { count: number };
    const catalogProblemRows = db.prepare("SELECT COUNT(*) AS count FROM problems").get() as { count: number };
    const contestPerformance = db
      .prepare("SELECT performance FROM user_contest_results WHERE contest_id = 100")
      .get() as { performance: number | null };
    const standingsOnlyProblem = db
      .prepare("SELECT name, rating, solved_count, tags_json FROM problems WHERE contest_id = 100 AND problem_index = 'Z'")
      .get() as { name: string; rating: number; solved_count: number | null; tags_json: string };
    const problemsetProblem = db
      .prepare("SELECT solved_count FROM problems WHERE contest_id = 100 AND problem_index = 'B'")
      .get() as { solved_count: number };
    const upsolved = db
      .prepare("SELECT upsolved FROM user_contest_problem_results WHERE problem_index = 'B'")
      .get() as { upsolved: number };
    const cachedRatingChanges = db
      .prepare("SELECT raw_json FROM contest_rating_changes_cache WHERE contest_id = 100")
      .get() as { raw_json: string };

    assert.equal(client.ratingChangesCalls, 1);
    assert.equal(client.standingsCalls, 1);
    assert.equal(contestRows.count, 1);
    assert.equal(contestPerformance.performance, 1867);
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
    assert.deepEqual(
      (JSON.parse(cachedRatingChanges.raw_json) as CfRatingChange[]).map((change) => change.handle),
      ["winner", cfHandle],
    );
  } finally {
    db.close();
    syncState.userRunning.clear();
    syncState.contestQueueRunning = false;
  }
});

test("first user sync imports accepted problems omitted from the problemset catalog", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  insertUser(db);
  syncState.catalogRunning = false;
  syncState.userRunning.clear();

  try {
    const client = new OmittedAcceptedProblemClient();
    await syncUserStatus(db, userId, cfHandle, client as unknown as CodeforcesClient);

    const status = db
      .prepare(`
        SELECT ups.contest_id, ups.problem_index, p.name
        FROM user_problem_status ups
        JOIN problems p
          ON p.contest_id = ups.contest_id
          AND p.problem_index = ups.problem_index
        WHERE ups.contest_id = 100 AND ups.problem_index = 'B'
      `)
      .get() as { contest_id: number; problem_index: string; name: string };

    assert.deepEqual({ ...status }, {
      contest_id: 100,
      problem_index: "B",
      name: "B",
    });
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

test("user sync enqueues all older unsynced contests on refresh", async () => {
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
    let doneRows = db.prepare("SELECT COUNT(*) AS count FROM contest_sync_jobs WHERE status = 'done'").get() as { count: number };
    let queuedRows = db.prepare("SELECT COUNT(*) AS count FROM contest_sync_jobs WHERE status = 'queued'").get() as { count: number };
    assert.equal(contestRows.count, 35);
    assert.equal(doneRows.count, 30);
    assert.equal(queuedRows.count, 5);
    assert.deepEqual(client.standingsCalls.slice().sort((a, b) => b - a), [
      35, 34, 33, 32, 31, 30, 29, 28, 27, 26,
      25, 24, 23, 22, 21, 20, 19, 18, 17, 16,
      15, 14, 13, 12, 11, 10, 9, 8, 7, 6,
    ]);

    const priorityRows = db
      .prepare("SELECT contest_id, priority FROM contest_sync_jobs ORDER BY priority ASC")
      .all() as { contest_id: number; priority: number }[];
    assert.equal(priorityRows[0]?.contest_id, 35);
    assert.equal(priorityRows[0]?.priority, 0);
    assert.equal(priorityRows.at(-1)?.contest_id, 1);
    assert.equal(priorityRows.at(-1)?.priority, 34);

    await runContestSyncQueue(db, client as unknown as CodeforcesClient);
    assert.deepEqual(client.standingsCalls.slice().sort((a, b) => b - a), [
      35, 34, 33, 32, 31, 30, 29, 28, 27, 26,
      25, 24, 23, 22, 21, 20, 19, 18, 17, 16,
      15, 14, 13, 12, 11, 10, 9, 8, 7, 6,
      5, 4, 3, 2, 1,
    ]);

    await syncUserStatus(db, userId, cfHandle, client as unknown as CodeforcesClient);

    contestRows = db.prepare("SELECT COUNT(*) AS count FROM user_contest_results").get() as { count: number };
    queuedRows = db.prepare("SELECT COUNT(*) AS count FROM contest_sync_jobs WHERE status = 'queued'").get() as { count: number };
    assert.equal(contestRows.count, 35);
    assert.equal(queuedRows.count, 0);
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
