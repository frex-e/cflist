import "../load-env.js";
import { createAuth } from "../auth.js";
import { buildAuthTrustedOrigins, config } from "../config.js";
import { openDb } from "../db/connection.js";
import { migrate } from "../db/migrate.js";

// Idempotent seed for a shared CFList test user (a throwaway login for local /
// cloud-agent dev, not a production credential). Defaults are hardcoded so every
// environment has the same known login with no setup; TEST_USER_EMAIL /
// TEST_USER_PASSWORD can still override them. The Codeforces handle is fixed.
// Re-running is a no-op when the user already matches, and self-heals
// (recreates) when the password or handle drifts.
const CF_HANDLE = "inj";
const NAME = "CFList Test User";
const DEFAULT_EMAIL = "test@cflist.local";
const DEFAULT_PASSWORD = "cflist-test-password";

const email = (process.env.TEST_USER_EMAIL?.trim() || DEFAULT_EMAIL);
const password = (process.env.TEST_USER_PASSWORD || DEFAULT_PASSWORD);

if (password.length < 8) {
  console.error("[seed-user] TEST_USER_PASSWORD must be at least 8 characters (Better Auth minimum).");
  process.exit(1);
}

const db = openDb(config.dbPath);
migrate(db);

// Seed through Better Auth directly (server-side API) so password hashing and
// account rows match the running app exactly. Force email/password on regardless
// of AUTH_GITHUB_ONLY so seeding works in any configuration.
const auth = createAuth(db, {
  baseURL: config.authBaseUrl,
  secret: config.authSecret,
  trustedOrigins: buildAuthTrustedOrigins(config.port),
  githubOnly: false,
});

const findUser = (): { id: string; cfHandle: string } | undefined =>
  db.prepare(`SELECT id, cfHandle FROM "user" WHERE email = @email`).get({ email }) as
    | { id: string; cfHandle: string }
    | undefined;

const passwordWorks = async (): Promise<boolean> => {
  try {
    await auth.api.signInEmail({ body: { email, password } });
    return true;
  } catch {
    return false;
  }
};

const createUser = async (): Promise<void> => {
  await auth.api.signUpEmail({
    body: { name: NAME, email, password, cfHandle: CF_HANDLE },
  });
  // Normalize the handle defensively in case the additional field default won.
  db.prepare(`UPDATE "user" SET cfHandle = @cfHandle, updatedAt = @now WHERE email = @email`).run({
    cfHandle: CF_HANDLE,
    now: new Date().toISOString(),
    email,
  });
};

const existing = findUser();
if (existing) {
  const healthy = existing.cfHandle === CF_HANDLE && (await passwordWorks());
  if (healthy) {
    console.log(`[seed-user] Test user already configured (${email}, handle "${CF_HANDLE}").`);
  } else {
    // Cascades to sessions/accounts and per-user app data; sync_runs.user_id is set null.
    db.prepare(`DELETE FROM "user" WHERE email = @email`).run({ email });
    await createUser();
    console.log(`[seed-user] Recreated test user (${email}, handle "${CF_HANDLE}").`);
  }
} else {
  await createUser();
  console.log(`[seed-user] Created test user (${email}, handle "${CF_HANDLE}").`);
}

const final = findUser();
console.log(`[seed-user] Done. user id=${final?.id} email=${email} cfHandle=${final?.cfHandle}`);

db.close();
