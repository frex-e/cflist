import { DatabaseSync } from "node:sqlite";
import { createApp } from "../src/app.js";
import { migrate } from "../src/db/migrate.js";

export const createTestDb = (): DatabaseSync => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
};

export const createTestApp = (
  db: DatabaseSync,
  options: { github?: boolean } = {},
): ReturnType<typeof createApp> => {
  return createApp(db, {
    publicRoot: "src/public",
    authBaseURL: "http://localhost",
    authSecret: "test-secret-with-enough-length-32",
    authTrustedOrigins: ["http://localhost"],
    skipInitialSync: true,
    ...(options.github
      ? {
          githubClientId: "test-github-client-id",
          githubClientSecret: "test-github-client-secret",
        }
      : {}),
  });
};

export const signUp = async (
  app: ReturnType<typeof createApp>,
  db?: DatabaseSync,
  email = "user@example.com",
  cfHandle = "tourist",
): Promise<string> => {
  const response = await app.request("/sign-up", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      name: "Test User",
      email,
      password: "password123",
      cfHandle,
    }).toString(),
  });

  if (response.status !== 303) {
    throw new Error(`Sign up failed with status ${response.status}`);
  }

  if (db) {
    const user = db.prepare(`SELECT id FROM "user" WHERE email = @email`).get({ email }) as { id: string };
    db.prepare(
      `
      INSERT INTO sync_runs (started_at, finished_at, status, source, user_id, cf_handle, message)
      VALUES ('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'success', 'codeforces:user', @userId, @cfHandle, 'test')
    `,
    ).run({ userId: user.id, cfHandle });
  }

  return response.headers.get("set-cookie") ?? "";
};

export const seedContest = (
  db: DatabaseSync,
  contest: {
    id: number;
    name: string;
    family?: string;
    division?: string;
    label?: string;
  },
): void => {
  db.prepare(
    `
    INSERT INTO contests (
      id,
      name,
      derived_family,
      derived_division,
      derived_label,
      raw_json,
      updated_at
    ) VALUES (@id, @name, @family, @division, @label, '{}', '2026-01-01T00:00:00.000Z')
  `,
  ).run({
    id: contest.id,
    name: contest.name,
    family: contest.family ?? "Codeforces Round",
    division: contest.division ?? "Div. 2",
    label: contest.label ?? contest.name,
  });
};

export const seedProblem = (
  db: DatabaseSync,
  problem: {
    contestId: number;
    index: string;
    name?: string;
    rating?: number;
    url?: string;
  },
): void => {
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
      updated_at
    ) VALUES (@contestId, @index, @name, @rating, 10, '[]', @url, '{}', '2026-01-01T00:00:00.000Z')
  `,
  ).run({
    contestId: problem.contestId,
    index: problem.index,
    name: problem.name ?? "Test Problem",
    rating: problem.rating ?? 800,
    url: problem.url ?? `https://codeforces.com/problemset/problem/${problem.contestId}/${problem.index}`,
  });
};

export const withTestApp = async (
  fn: (app: ReturnType<typeof createApp>, db: DatabaseSync) => Promise<void>,
): Promise<void> => {
  const db = createTestDb();
  try {
    await fn(createTestApp(db), db);
  } finally {
    db.close();
  }
};

export const withSeededApp = async (
  fn: (app: ReturnType<typeof createApp>, db: DatabaseSync) => Promise<void>,
  seed?: (db: DatabaseSync) => void,
): Promise<void> => {
  await withTestApp(async (app, db) => {
    seed?.(db);
    await fn(app, db);
  });
};
