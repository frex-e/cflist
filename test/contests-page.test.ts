import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createApp } from "../src/app.js";
import { migrate } from "../src/db/migrate.js";

const seedCatalog = (db: DatabaseSync): void => {
  db.prepare(
    `
    INSERT INTO contests (
      id,
      name,
      start_time_seconds,
      duration_seconds,
      derived_family,
      derived_division,
      derived_label,
      raw_json,
      updated_at
    ) VALUES
      (1099, 'Codeforces Round 1099 (Div. 2)', 1750000000, 7200, 'Codeforces Round', 'Div. 2', 'Codeforces Round (Div. 2)', '{}', '2026-01-01T00:00:00.000Z'),
      (1100, 'Codeforces Round 1100 (Div. 2)', 1760000000, 7200, 'Codeforces Round', 'Div. 2', 'Codeforces Round (Div. 2)', '{}', '2026-01-01T00:00:00.000Z')
  `,
  ).run();

  for (const index of ["A", "B", "C"]) {
    db.prepare(
      `
      INSERT INTO problems (
        contest_id,
        problem_index,
        name,
        tags_json,
        url,
        raw_json,
        updated_at
      ) VALUES (1100, @index, @name, '[]', @url, '{}', '2026-01-01T00:00:00.000Z')
    `,
    ).run({
      index,
      name: `Problem ${index}`,
      url: `https://codeforces.com/contest/1100/problem/${index}`,
    });
  }
};

const withApp = async (fn: (app: ReturnType<typeof createApp>, db: DatabaseSync) => Promise<void>): Promise<void> => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  seedCatalog(db);

  try {
    const app = createApp(db, {
      publicRoot: "src/public",
      authBaseURL: "http://localhost",
      authSecret: "test-secret-with-enough-length-32",
      authTrustedOrigins: ["http://localhost"],
    });
    await fn(app, db);
  } finally {
    db.close();
  }
};

const signUp = async (app: ReturnType<typeof createApp>): Promise<string> => {
  const response = await app.request("/sign-up", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      name: "Test User",
      email: "user@example.com",
      password: "password123",
      cfHandle: "inj",
    }).toString(),
  });

  assert.equal(response.status, 303);
  return response.headers.get("set-cookie") ?? "";
};

test("contests page renders rating, performance, and problem outcome pills", async () => {
  await withApp(async (app, db) => {
    const cookie = await signUp(app);
    const user = db.prepare(`SELECT id FROM "user" WHERE email = 'user@example.com'`).get() as { id: string };

    db.prepare(
      `
      INSERT INTO user_contest_results (
        user_id,
        cf_handle,
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
      ) VALUES (@userId, 'inj', 1100, 42, 3, 180, 'CONTESTANT', 1900, 1950, 50, 2075, '2026-01-01T00:00:00.000Z')
    `,
    ).run({ userId: user.id });

    db.prepare(
      `
      INSERT INTO user_contest_results (
        user_id,
        cf_handle,
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
      ) VALUES (@userId, 'inj', 1099, 80, 2, 240, 'CONTESTANT', 1850, 1900, 50, 1980, '2026-01-01T00:00:00.000Z')
    `,
    ).run({ userId: user.id });

    for (const row of [
      { index: "A", solved: 1, upsolved: 0 },
      { index: "B", solved: 0, upsolved: 1 },
      { index: "C", solved: 0, upsolved: 0 },
    ]) {
      db.prepare(
        `
        INSERT INTO user_contest_problem_results (
          user_id,
          contest_id,
          problem_index,
          solved_in_contest,
          upsolved
        ) VALUES (@userId, 1100, @index, @solved, @upsolved)
      `,
      ).run({ userId: user.id, index: row.index, solved: row.solved, upsolved: row.upsolved });
    }

    const response = await app.request("/contests", { headers: { cookie } });
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /Codeforces Round 1100 \(Div\. 2\)/);
    assert.match(html, /class="rating-charts"/);
    assert.match(html, /aria-label="Rating chart"/);
    assert.match(html, /aria-label="Performance chart"/);
    assert.match(html, /chart-band-candidate-master/);
    assert.match(html, /<td class="num">42<\/td>/);
    assert.match(html, /<td class="num delta-positive">\+50<\/td>/);
    assert.match(html, /rating-value rating-candidate-master/);
    assert.match(html, />1,950<\/span>/);
    assert.match(html, />2,075<\/span>/);
    assert.match(html, /contest-problem-pill contest-solved/);
    assert.match(html, /contest-problem-pill upsolved/);
    assert.match(html, /contest-problem-pill unsolved/);
  });
});
