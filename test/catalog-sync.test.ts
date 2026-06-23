import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { CodeforcesClient } from "../src/cf/client.js";
import { refreshProblemMetadata } from "../src/cf/sync/catalog.js";
import {
  countProblemsNeedingMetadata,
  shouldRefreshProblemMetadata,
  shouldSyncCatalog,
} from "../src/db/queries/catalog-sync.js";
import { finishSyncRun, startSyncRun } from "../src/db/writes/sync-runs.js";
import type { CfProblemset } from "../src/cf/types.js";
import { createTestDb } from "./helpers.js";

const recentFinishedAt = new Date(Date.now() - 60_000).toISOString();
const staleFinishedAt = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

const insertProblem = (
  db: ReturnType<typeof createTestDb>,
  input: {
    contestId: number;
    problemIndex: string;
    name?: string;
    rating?: number | null;
    tagsJson?: string;
  },
): void => {
  db.prepare(
    `
    INSERT OR IGNORE INTO contests (id, name, raw_json, updated_at)
    VALUES (@contestId, @contestName, '{}', '2026-01-01T00:00:00.000Z')
  `,
  ).run({
    contestId: input.contestId,
    contestName: `Contest ${input.contestId}`,
  });

  db.prepare(
    `
    INSERT INTO problems (
      contest_id, problem_index, name, rating, tags_json, url, raw_json, updated_at, canonical_id
    ) VALUES (
      @contestId, @problemIndex, @name, @rating, @tagsJson,
      @url, '{}', '2026-01-01T00:00:00.000Z', @canonicalId
    )
  `,
  ).run({
    contestId: input.contestId,
    problemIndex: input.problemIndex,
    name: input.name ?? `Problem ${input.problemIndex}`,
    rating: input.rating ?? null,
    tagsJson: input.tagsJson ?? "[]",
    url: `https://codeforces.com/contest/${input.contestId}/problem/${input.problemIndex}`,
    canonicalId: randomUUID(),
  });
};

const seedSuccessfulCatalogSync = (
  db: ReturnType<typeof createTestDb>,
  finishedAt = recentFinishedAt,
): void => {
  const syncRunId = startSyncRun(db, "codeforces:catalog", finishedAt);
  finishSyncRun(db, syncRunId, "success", "catalog ok", finishedAt);
};

const seedSuccessfulMetadataRefresh = (
  db: ReturnType<typeof createTestDb>,
  finishedAt = recentFinishedAt,
): void => {
  const syncRunId = startSyncRun(db, "codeforces:catalog-metadata", finishedAt);
  finishSyncRun(db, syncRunId, "success", "metadata ok", finishedAt);
};

class MetadataRefreshClient {
  private readonly response: CfProblemset;

  constructor(response: CfProblemset) {
    this.response = response;
  }

  async problemset(): Promise<CfProblemset> {
    return this.response;
  }
}

test("shouldSyncCatalog retries after failed catalog sync even when problems exist", () => {
  const db = createTestDb();
  try {
    insertProblem(db, { contestId: 1, problemIndex: "A" });

    const syncRunId = startSyncRun(db, "codeforces:catalog", "2026-01-01T00:00:00.000Z");
    finishSyncRun(db, syncRunId, "failed", "problemset fetch failed", "2026-01-01T00:00:01.000Z");

    assert.equal(shouldSyncCatalog(db), true);
  } finally {
    db.close();
  }
});

test("countProblemsNeedingMetadata counts unrated and untagged problems", () => {
  const db = createTestDb();
  try {
    insertProblem(db, { contestId: 1, problemIndex: "A", rating: null, tagsJson: "[]" });
    insertProblem(db, { contestId: 1, problemIndex: "B", rating: 1500, tagsJson: "[]" });
    insertProblem(db, { contestId: 1, problemIndex: "C", rating: 1600, tagsJson: '["math"]' });
    db.prepare(
      `INSERT INTO problem_tags (contest_id, problem_index, tag) VALUES (1, 'C', 'math')`,
    ).run();

    assert.equal(countProblemsNeedingMetadata(db), 2);
  } finally {
    db.close();
  }
});

test("shouldRefreshProblemMetadata is false when no eligible problems exist", () => {
  const db = createTestDb();
  try {
    insertProblem(db, { contestId: 1, problemIndex: "A", rating: 1500, tagsJson: '["math"]' });
    db.prepare(
      `INSERT INTO problem_tags (contest_id, problem_index, tag) VALUES (1, 'A', 'math')`,
    ).run();
    seedSuccessfulCatalogSync(db);

    assert.equal(shouldRefreshProblemMetadata(db), false);
  } finally {
    db.close();
  }
});

test("shouldRefreshProblemMetadata is false when full catalog sync is due", () => {
  const db = createTestDb();
  try {
    insertProblem(db, { contestId: 1, problemIndex: "A", rating: null, tagsJson: "[]" });
    seedSuccessfulCatalogSync(db, staleFinishedAt);

    assert.equal(shouldSyncCatalog(db), true);
    assert.equal(shouldRefreshProblemMetadata(db), false);
  } finally {
    db.close();
  }
});

test("shouldRefreshProblemMetadata is true when unrated problems exist and refresh is stale", () => {
  const db = createTestDb();
  try {
    insertProblem(db, { contestId: 1, problemIndex: "A", rating: null, tagsJson: "[]" });
    seedSuccessfulCatalogSync(db);

    assert.equal(shouldSyncCatalog(db), false);
    assert.equal(shouldRefreshProblemMetadata(db), true);
  } finally {
    db.close();
  }
});

test("shouldRefreshProblemMetadata retries after failed metadata refresh", () => {
  const db = createTestDb();
  try {
    insertProblem(db, { contestId: 1, problemIndex: "A", rating: null, tagsJson: "[]" });
    seedSuccessfulCatalogSync(db);

    const syncRunId = startSyncRun(db, "codeforces:catalog-metadata", "2026-01-01T00:00:00.000Z");
    finishSyncRun(db, syncRunId, "failed", "problemset fetch failed", "2026-01-01T00:00:01.000Z");

    assert.equal(shouldRefreshProblemMetadata(db), true);
  } finally {
    db.close();
  }
});

test("shouldRefreshProblemMetadata is false after recent metadata refresh", () => {
  const db = createTestDb();
  try {
    insertProblem(db, { contestId: 1, problemIndex: "A", rating: null, tagsJson: "[]" });
    seedSuccessfulCatalogSync(db);
    seedSuccessfulMetadataRefresh(db);

    assert.equal(shouldRefreshProblemMetadata(db), false);
  } finally {
    db.close();
  }
});

test("refreshProblemMetadata updates a locally unrated problem when API returns a rating", async () => {
  const db = createTestDb();
  try {
    insertProblem(db, { contestId: 100, problemIndex: "A", rating: null, tagsJson: "[]" });

    const client = new MetadataRefreshClient({
      problems: [
        { contestId: 100, index: "A", name: "Rated A", rating: 1800, tags: [] },
      ],
      problemStatistics: [{ contestId: 100, index: "A", solvedCount: 42 }],
    });

    await refreshProblemMetadata(db, client as unknown as CodeforcesClient);

    const row = db
      .prepare("SELECT rating, solved_count FROM problems WHERE contest_id = 100 AND problem_index = 'A'")
      .get() as { rating: number; solved_count: number };

    assert.equal(row.rating, 1800);
    assert.equal(row.solved_count, 42);
    assert.equal(countProblemsNeedingMetadata(db), 1);
  } finally {
    db.close();
  }
});

test("refreshProblemMetadata updates a locally untagged problem when API returns tags", async () => {
  const db = createTestDb();
  try {
    insertProblem(db, { contestId: 100, problemIndex: "B", rating: 1500, tagsJson: "[]" });

    const client = new MetadataRefreshClient({
      problems: [
        { contestId: 100, index: "B", name: "Tagged B", rating: 1500, tags: ["math", "dp"] },
      ],
      problemStatistics: [{ contestId: 100, index: "B", solvedCount: 10 }],
    });

    await refreshProblemMetadata(db, client as unknown as CodeforcesClient);

    const row = db
      .prepare("SELECT tags_json FROM problems WHERE contest_id = 100 AND problem_index = 'B'")
      .get() as { tags_json: string };
    const tags = db
      .prepare("SELECT tag FROM problem_tags WHERE contest_id = 100 AND problem_index = 'B' ORDER BY tag ASC")
      .all()
      .map((entry) => (entry as { tag: string }).tag);

    assert.equal(row.tags_json, '["dp","math"]');
    assert.deepEqual(tags, ["dp", "math"]);
    assert.equal(countProblemsNeedingMetadata(db), 0);
  } finally {
    db.close();
  }
});

test("refreshProblemMetadata skips write when API still has no rating or tags", async () => {
  const db = createTestDb();
  try {
    insertProblem(db, { contestId: 100, problemIndex: "C", rating: null, tagsJson: "[]" });

    const client = new MetadataRefreshClient({
      problems: [{ contestId: 100, index: "C", name: "Still Unrated", tags: [] }],
      problemStatistics: [{ contestId: 100, index: "C", solvedCount: 5 }],
    });

    await refreshProblemMetadata(db, client as unknown as CodeforcesClient);

    const row = db
      .prepare("SELECT rating, solved_count, updated_at FROM problems WHERE contest_id = 100 AND problem_index = 'C'")
      .get() as { rating: number | null; solved_count: number | null; updated_at: string };

    assert.equal(row.rating, null);
    assert.equal(row.solved_count, null);
    assert.equal(row.updated_at, "2026-01-01T00:00:00.000Z");
  } finally {
    db.close();
  }
});
