import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { listProblems, type ProblemFilters } from "../src/db/queries.js";
import { migrate } from "../src/db/migrate.js";
import { ratingFilterSliderBounds } from "../src/views/rating.js";

const userId = "user-rating-filter";

const filters = (overrides: Partial<ProblemFilters> = {}): ProblemFilters => ({
  tags: [],
  tagMode: "any",
  divisions: [],
  solved: "all",
  showTags: false,
  sort: "contest",
  sortDirection: "desc",
  page: 1,
  pageSize: 50,
  userId,
  cfHandle: "tourist",
  ...overrides,
});

const insertProblem = (
  db: DatabaseSync,
  contestId: number,
  problemIndex: string,
  name: string,
  rating: number | null,
  estimatedRating: number | null,
): void => {
  db.prepare(
    `
    INSERT INTO problems (
      contest_id,
      problem_index,
      name,
      rating,
      estimated_rating,
      solved_count,
      tags_json,
      url,
      raw_json,
      updated_at,
      canonical_id
    ) VALUES (
      @contestId,
      @problemIndex,
      @name,
      @rating,
      @estimatedRating,
      100,
      '[]',
      @url,
      '{}',
      '2026-01-01T00:00:00.000Z',
      @canonicalId
    )
  `,
  ).run({
    contestId,
    problemIndex,
    name,
    rating,
    estimatedRating,
    url: `https://codeforces.com/contest/${contestId}/problem/${problemIndex}`,
    canonicalId: `${contestId}${problemIndex}`,
  });
};

const withDb = (fn: (db: DatabaseSync) => void): void => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);

  db.prepare(
    `
    INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, cfHandle)
    VALUES (@userId, 'Test User', 'rating-filter@example.com', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'tourist')
  `,
  ).run({ userId });

  db.prepare(
    `
    INSERT INTO contests (
      id,
      name,
      start_time_seconds,
      derived_family,
      derived_division,
      derived_label,
      raw_json,
      updated_at
    ) VALUES (
      100,
      'Test Round',
      1760000000,
      'Codeforces Round',
      'Div. 2',
      'Codeforces Round (Div. 2)',
      '{}',
      '2026-01-01T00:00:00.000Z'
    )
  `,
  ).run();

  insertProblem(db, 100, "A", "Official", 1200, null);
  insertProblem(db, 100, "B", "Estimated only", null, 1500);
  insertProblem(db, 100, "C", "No rating", null, null);
  insertProblem(db, 100, "D", "Hard official", 2400, null);
  insertProblem(db, 100, "E", "Low estimate", null, 218);

  try {
    fn(db);
  } finally {
    db.close();
  }
};

test("ratingFilterSliderBounds puts Any one step outside rounded catalog span", () => {
  const bounds = ratingFilterSliderBounds([800, 1500, 3500]);
  assert.equal(bounds.minBound, 800);
  assert.equal(bounds.maxBound, 3500);
  assert.equal(bounds.sliderMin, 700);
  assert.equal(bounds.sliderMax, 3600);
  assert.equal(bounds.step, 100);
});

test("ratingFilterSliderBounds snaps irregular estimates to 100-step track", () => {
  const bounds = ratingFilterSliderBounds([218, 732, 1893, 3500]);
  assert.equal(bounds.minBound, 200);
  assert.equal(bounds.maxBound, 3500);
  assert.equal(bounds.sliderMin, 100);
  assert.equal(bounds.sliderMax, 3600);
});

test("ratingFilterSliderBounds falls back when catalog is empty", () => {
  const bounds = ratingFilterSliderBounds([]);
  assert.equal(bounds.minBound, 800);
  assert.equal(bounds.maxBound, 3500);
  assert.equal(bounds.sliderMin, 700);
  assert.equal(bounds.sliderMax, 3600);
});

test("listProblems includes estimate-only rows in rating filters via COALESCE", () => {
  withDb((db) => {
    const mid = listProblems(db, filters({ minRating: 1400, maxRating: 1600 }));
    assert.deepEqual(
      mid.rows.map((row) => row.name).sort(),
      ["Estimated only"],
    );

    const withLowEstimate = listProblems(db, filters({ maxRating: 300 }));
    assert.deepEqual(
      withLowEstimate.rows.map((row) => row.name),
      ["Low estimate"],
    );
  });
});

test("listProblems excludes problems with no official rating and no estimate when a rating bound is set", () => {
  withDb((db) => {
    const all = listProblems(db, filters());
    assert.equal(all.total, 5);
    assert.ok(all.rows.some((row) => row.name === "No rating"));

    const minOnly = listProblems(db, filters({ minRating: 800 }));
    assert.ok(!minOnly.rows.some((row) => row.name === "No rating"));
    assert.ok(minOnly.rows.some((row) => row.name === "Official"));
    assert.ok(minOnly.rows.some((row) => row.name === "Estimated only"));

    const maxOnly = listProblems(db, filters({ maxRating: 3500 }));
    assert.ok(!maxOnly.rows.some((row) => row.name === "No rating"));
    assert.ok(maxOnly.rows.some((row) => row.name === "Hard official"));
    assert.ok(maxOnly.rows.some((row) => row.name === "Low estimate"));

    const fullRatedSpan = listProblems(db, filters({ minRating: 800, maxRating: 3500 }));
    assert.ok(!fullRatedSpan.rows.some((row) => row.name === "No rating"));
    assert.ok(!fullRatedSpan.rows.some((row) => row.name === "Low estimate"));
    assert.deepEqual(
      fullRatedSpan.rows.map((row) => row.name).sort(),
      ["Estimated only", "Hard official", "Official"],
    );
  });
});
