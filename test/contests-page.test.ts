import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createApp } from "../src/app.js";
import { setVerifyHandleForTests } from "../src/cf/verify-handle.js";
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
      (1100, 'Codeforces Round 1100 (Div. 2)', 1760000000, 7200, 'Codeforces Round', 'Div. 2', 'Codeforces Round (Div. 2)', '{}', '2026-01-01T00:00:00.000Z'),
      (1098, 'Upsolve Round (Div. 2)', 1740000000, 7200, 'Codeforces Round', 'Div. 2', 'Codeforces Round (Div. 2)', '{}', '2026-01-01T00:00:00.000Z')
  `,
  ).run();

  for (const row of [
    { index: "A", name: "Problem A", rating: 800 },
    { index: "B", name: "Problem B", rating: 1200 },
    { index: "C", name: "Problem C", rating: 1600 },
  ]) {
    db.prepare(
      `
      INSERT INTO problems (
        contest_id,
        problem_index,
        name,
        rating,
        tags_json,
        url,
        raw_json,
        updated_at,
        canonical_id
      ) VALUES (1100, @index, @name, @rating, '[]', @url, '{}', '2026-01-01T00:00:00.000Z', @canonicalId)
    `,
    ).run({
      index: row.index,
      name: row.name,
      rating: row.rating,
      url: `https://codeforces.com/contest/1100/problem/${row.index}`,
      canonicalId: randomUUID(),
    });
  }

  for (const contestId of [1098, 1099]) {
    db.prepare(
      `
      INSERT INTO problems (
        contest_id,
        problem_index,
        name,
        tags_json,
        url,
        raw_json,
        updated_at,
        canonical_id
      ) VALUES (@contestId, 'A', 'Problem A', '[]', @url, '{}', '2026-01-01T00:00:00.000Z', @canonicalId)
    `,
    ).run({
      contestId,
      url: `https://codeforces.com/contest/${contestId}/problem/A`,
      canonicalId: randomUUID(),
    });
  }
};

const withApp = async (fn: (app: ReturnType<typeof createApp>, db: DatabaseSync) => Promise<void>): Promise<void> => {
  setVerifyHandleForTests(async () => true);
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
      skipInitialSync: true,
    });
    await fn(app, db);
  } finally {
    setVerifyHandleForTests(undefined);
    db.close();
  }
};

const signUp = async (app: ReturnType<typeof createApp>, db: DatabaseSync): Promise<string> => {
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

  const user = db.prepare(`SELECT id FROM "user" WHERE email = 'user@example.com'`).get() as { id: string };
  db.prepare(
    `
    INSERT INTO sync_runs (started_at, finished_at, status, source, user_id, cf_handle, message)
    VALUES ('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'success', 'codeforces:user', @userId, 'inj', 'test')
  `,
  ).run({ userId: user.id });

  return response.headers.get("set-cookie") ?? "";
};

test("contests page renders rating, performance, and problem outcome pills", async () => {
  await withApp(async (app, db) => {
    const cookie = await signUp(app, db);
    const user = db.prepare(`SELECT id FROM "user" WHERE email = 'user@example.com'`).get() as { id: string };

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
      ) VALUES (@userId, 1100, 42, 3, 180, 'CONTESTANT', 1900, 1950, 50, 2075, '2026-01-01T00:00:00.000Z')
    `,
    ).run({ userId: user.id });

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
      ) VALUES (@userId, 1099, 80, 2, 240, 'CONTESTANT', 1850, 1900, 50, 1980, '2026-01-01T00:00:00.000Z')
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
    assert.match(html, /contest-problem-rating-stripe rank-newbie/);
    assert.match(html, /contest-problem-rating-stripe rank-pupil/);
    assert.match(html, /contest-problem-rating-stripe rank-expert/);
    assert.match(html, /contest-name-cell/);
    assert.match(html, /contest-name-link/);
    assert.match(html, /stripe = problem rating/);
    assert.match(html, />Contest history</);
    assert.match(html, /Showing 1-3 of 3/);
    assert.match(html, /3 catalog contests \(2 synced, 2 rated\) for inj/);
    assert.match(html, /id="contest-rows"/);
    assert.doesNotMatch(html, /Contest history \(/);
    assert.match(html, /data-contest-show="all"/);
    assert.match(html, /data-contest-show="upsolved"/);
    assert.match(html, /data-contest-show="participated"/);
    assert.match(html, /data-contest-show="rated"/);
  });
});

test("contests page shows yellow skipped pills without overriding CF solved states", async () => {
  await withApp(async (app, db) => {
    const cookie = await signUp(app, db);
    const user = db.prepare(`SELECT id FROM "user" WHERE email = 'user@example.com'`).get() as { id: string };

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
      ) VALUES (@userId, 1100, 42, 3, 180, 'CONTESTANT', 1900, 1950, 50, 2075, '2026-01-01T00:00:00.000Z')
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

    for (const index of ["A", "C"]) {
      const problem = db
        .prepare(
          `
          SELECT canonical_id AS canonicalId
          FROM problems
          WHERE contest_id = 1100 AND problem_index = @index
        `,
        )
        .get({ index }) as { canonicalId: string };
      db.prepare(
        `
        INSERT INTO user_problem_overrides (
          user_id,
          canonical_id,
          solved_override,
          skipped,
          note,
          updated_at
        ) VALUES (@userId, @canonicalId, NULL, 1, NULL, '2026-01-01T00:00:00.000Z')
      `,
      ).run({ userId: user.id, canonicalId: problem.canonicalId });
    }

    const response = await app.request("/contests", { headers: { cookie } });
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /contest-problem-pill contest-solved/);
    assert.match(html, /contest-problem-pill upsolved/);
    assert.match(html, /contest-problem-pill skipped/);
    assert.match(html, /title="C — Problem C \(1600\): skipped"/);
    // Skipped must not replace CF contest-solved / upsolved fills.
    assert.match(html, /title="A — Problem A \(800\): solved in contest"/);
    assert.match(html, /title="B — Problem B \(1200\): upsolved after contest"/);
  });
});

test("contests page show filter keeps mutually exclusive table modes", async () => {
  await withApp(async (app, db) => {
    const cookie = await signUp(app, db);
    const user = db.prepare(`SELECT id FROM "user" WHERE email = 'user@example.com'`).get() as { id: string };

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
      ) VALUES (@userId, 1100, 42, 3, 180, 'CONTESTANT', 1900, 1950, 50, 2075, '2026-01-01T00:00:00.000Z')
    `,
    ).run({ userId: user.id });

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
      ) VALUES (@userId, 1099, 80, 2, 240, 'CONTESTANT', NULL, NULL, NULL, NULL, '2026-01-01T00:00:00.000Z')
    `,
    ).run({ userId: user.id });

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
      ) VALUES (@userId, 1098, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2026-01-01T00:00:00.000Z')
    `,
    ).run({ userId: user.id });

    db.prepare(
      `
      INSERT INTO problems (
        contest_id,
        problem_index,
        name,
        tags_json,
        url,
        raw_json,
        updated_at,
        canonical_id
      ) VALUES (1098, 'B', 'Problem B', '[]', 'https://codeforces.com/contest/1098/problem/B', '{}', '2026-01-01T00:00:00.000Z', @canonicalId)
    `,
    ).run({ canonicalId: randomUUID() });

    db.prepare(
      `
      INSERT INTO user_contest_problem_results (
        user_id,
        contest_id,
        problem_index,
        solved_in_contest,
        upsolved
      ) VALUES (@userId, 1098, 'B', 0, 1)
    `,
    ).run({ userId: user.id });

    const upsolved = await app.request("/contests?show=upsolved", { headers: { cookie } });
    const upsolvedHtml = await upsolved.text();
    assert.equal(upsolved.status, 200);
    assert.match(upsolvedHtml, /Codeforces Round 1100 \(Div\. 2\)/);
    assert.match(upsolvedHtml, /Codeforces Round 1099 \(Div\. 2\)/);
    assert.match(upsolvedHtml, /Upsolve Round \(Div\. 2\)/);
    assert.match(upsolvedHtml, /Showing 1-3 of 3/);
    assert.match(upsolvedHtml, /data-contest-show="upsolved"[^>]*aria-pressed="true"/);

    const participated = await app.request("/contests?show=participated", { headers: { cookie } });
    const participatedHtml = await participated.text();
    assert.equal(participated.status, 200);
    assert.match(participatedHtml, /Codeforces Round 1100 \(Div\. 2\)/);
    assert.match(participatedHtml, /Codeforces Round 1099 \(Div\. 2\)/);
    assert.doesNotMatch(participatedHtml, /Upsolve Round \(Div\. 2\)/);
    assert.match(participatedHtml, />Contest history</);
    assert.match(participatedHtml, /Showing 1-2 of 2/);
    assert.match(participatedHtml, /data-contest-show="participated"[^>]*aria-pressed="true"/);

    const rated = await app.request("/contests?show=rated", { headers: { cookie } });
    const ratedHtml = await rated.text();
    assert.equal(rated.status, 200);
    assert.match(ratedHtml, /Codeforces Round 1100 \(Div\. 2\)/);
    assert.doesNotMatch(ratedHtml, /Codeforces Round 1099 \(Div\. 2\)/);
    assert.match(ratedHtml, /Showing 1-1 of 1/);
    assert.match(ratedHtml, /data-contest-show="rated"[^>]*aria-pressed="true"/);
  });
});

const seedManyContestResults = (db: DatabaseSync, userId: string, count: number): void => {
  for (let index = 0; index < count; index += 1) {
    const contestId = 2000 + index;
    const startTime = 1_700_000_000 - index * 86_400;
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
      ) VALUES (@contestId, @name, @startTime, 7200, 'Codeforces Round', 'Div. 2', 'Codeforces Round (Div. 2)', '{}', '2026-01-01T00:00:00.000Z')
    `,
    ).run({
      contestId,
      name: `Contest ${contestId}`,
      startTime,
    });

    db.prepare(
      `
      INSERT INTO problems (
        contest_id,
        problem_index,
        name,
        tags_json,
        url,
        raw_json,
        updated_at,
        canonical_id
      ) VALUES (@contestId, 'A', 'Problem A', '[]', @url, '{}', '2026-01-01T00:00:00.000Z', @canonicalId)
    `,
    ).run({
      contestId,
      url: `https://codeforces.com/contest/${contestId}/problem/A`,
      canonicalId: randomUUID(),
    });

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
      ) VALUES (@userId, @contestId, @rank, 1, 0, 'CONTESTANT', 1500, 1510, 10, 1520, '2026-01-01T00:00:00.000Z')
    `,
    ).run({ userId, contestId, rank: index + 1 });
  }
};

test("contests page paginates table rows and appends more via fragment", async () => {
  await withApp(async (app, db) => {
    const cookie = await signUp(app, db);
    const user = db.prepare(`SELECT id FROM "user" WHERE email = 'user@example.com'`).get() as { id: string };
    seedManyContestResults(db, user.id, 55);

    const response = await app.request("/contests", { headers: { cookie } });
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /Showing 1-50 of 58/);
    assert.match(html, /id="load-more"/);
    assert.match(html, /hx-get="\/contests\/fragment\?page=2&amp;append=1"/);
    assert.match(html, /href="https:\/\/codeforces.com\/contest\/1100"/);
    assert.match(html, /href="https:\/\/codeforces.com\/contest\/2046"/);
    assert.doesNotMatch(html, /href="https:\/\/codeforces.com\/contest\/2047"/);

    const append = await app.request("/contests/fragment?append=1&page=2", { headers: { cookie } });
    const appendHtml = await append.text();
    assert.equal(append.status, 200);
    assert.match(appendHtml, /hx-swap-oob="beforeend:#contest-rows"/);
    assert.match(appendHtml, /href="https:\/\/codeforces.com\/contest\/2050"/);
    assert.match(appendHtml, /Showing 1-58 of 58/);
  });
});

test("contests page show filter paginates filtered totals from SQL", async () => {
  await withApp(async (app, db) => {
    const cookie = await signUp(app, db);
    const user = db.prepare(`SELECT id FROM "user" WHERE email = 'user@example.com'`).get() as { id: string };

    for (let index = 0; index < 55; index += 1) {
      const contestId = 3000 + index;
      const startTime = 1_800_000_000 - index * 86_400;
      const rated = index % 2 === 0;
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
        ) VALUES (@contestId, @name, @startTime, 7200, 'Codeforces Round', 'Div. 2', 'Codeforces Round (Div. 2)', '{}', '2026-01-01T00:00:00.000Z')
      `,
      ).run({
        contestId,
        name: `Rated Contest ${contestId}`,
        startTime,
      });

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
          @contestId,
          10,
          1,
          0,
          'CONTESTANT',
          @oldRating,
          @newRating,
          @delta,
          @performance,
          '2026-01-01T00:00:00.000Z'
        )
      `,
      ).run({
        userId: user.id,
        contestId,
        oldRating: rated ? 1500 : null,
        newRating: rated ? 1510 : null,
        delta: rated ? 10 : null,
        performance: rated ? 1520 : null,
      });
    }

    const response = await app.request("/contests?show=rated", { headers: { cookie } });
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /class="rating-charts"/);
    assert.match(html, />28 rated contests</);
    assert.match(html, /Showing 1-28 of 28/);
    assert.doesNotMatch(html, /hx-get="\/contests\/fragment\?show=rated&amp;page=2&amp;append=1"/);
  });
});

test("contests page all filter shows catalog-only contests with unsolved pills", async () => {
  await withApp(async (app, db) => {
    const cookie = await signUp(app, db);
    const user = db.prepare(`SELECT id FROM "user" WHERE email = 'user@example.com'`).get() as { id: string };

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
      ) VALUES (@userId, 1100, 42, 3, 180, 'CONTESTANT', 1900, 1950, 50, 2075, '2026-01-01T00:00:00.000Z')
    `,
    ).run({ userId: user.id });

    const response = await app.request("/contests", { headers: { cookie } });
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /Showing 1-3 of 3/);
    assert.match(html, /Codeforces Round 1099 \(Div\. 2\)/);
    assert.match(html, /href="https:\/\/codeforces.com\/contest\/1099\/problem\/A"/);
    assert.match(html, /contest-problem-pill unsolved/);
    assert.match(html, /contest\/1099"[\s\S]*?<td class="num"><\/td><td class="num"><\/td>/);
  });
});

test("contests page keeps catalog pills visible while contest hydration is loading", async () => {
  await withApp(async (app, db) => {
    const cookie = await signUp(app, db);
    const user = db.prepare(`SELECT id FROM "user" WHERE email = 'user@example.com'`).get() as { id: string };

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
        'inj',
        1099,
        0,
        'queued',
        0,
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      )
    `,
    ).run({ userId: user.id });

    const response = await app.request("/contests", { headers: { cookie } });
    const html = await response.text();
    const row = html.match(/<tr>[\s\S]*?contest\/1099"[\s\S]*?<\/tr>/)?.[0] ?? "";

    assert.equal(response.status, 200);
    assert.match(row, /contest-problem-pill unsolved/);
    assert.match(row, /contest-hydration-spinner/);
    assert.match(row, /Loading…/);
  });
});

test("contests page all filter paginates full catalog without user rows", async () => {
  await withApp(async (app, db) => {
    const cookie = await signUp(app, db);
    const now = Math.floor(Date.now() / 1000);

    for (let index = 0; index < 55; index += 1) {
      const contestId = 4000 + index;
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
        ) VALUES (@contestId, @name, @startTime, 7200, 'Codeforces Round', 'Div. 2', 'Codeforces Round (Div. 2)', '{}', '2026-01-01T00:00:00.000Z')
      `,
      ).run({
        contestId,
        name: `Catalog Contest ${contestId}`,
        startTime: now - (index + 1) * 86_400,
      });

      db.prepare(
        `
        INSERT INTO problems (
          contest_id,
          problem_index,
          name,
          tags_json,
          url,
          raw_json,
          updated_at,
          canonical_id
        ) VALUES (@contestId, 'A', 'Problem A', '[]', @url, '{}', '2026-01-01T00:00:00.000Z', @canonicalId)
      `,
      ).run({
        contestId,
        url: `https://codeforces.com/contest/${contestId}/problem/A`,
        canonicalId: randomUUID(),
      });
    }

    const response = await app.request("/contests", { headers: { cookie } });
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /Showing 1-50 of 58/);
    assert.match(html, /<h1>Codeforces Contests<\/h1><p>58 catalog contests for inj<\/p>/);
  });
});
