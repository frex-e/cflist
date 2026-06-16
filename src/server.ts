import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { createApp } from "./app.js";
import { openDb } from "./db/connection.js";
import { migrate } from "./db/migrate.js";
import { latestSuccessfulSyncAgeMs, problemCount } from "./db/queries.js";
import { syncCatalog } from "./cf/sync.js";

const db = openDb(config.dbPath);
migrate(db);

const publicRoot = process.env.PUBLIC_ROOT ?? "./src";
const app = createApp(db, {
  publicRoot,
  authBaseURL: config.authBaseUrl,
  authSecret: config.authSecret,
  authTrustedOrigins: [
    ...config.authTrustedOrigins,
    `http://localhost:${config.port}`,
    `http://127.0.0.1:${config.port}`,
  ],
});

const maybeSync = (): void => {
  const maxAgeMs = config.syncIntervalMinutes * 60 * 1000;
  const age = latestSuccessfulSyncAgeMs(db);
  const shouldSync = problemCount(db) === 0 || age === undefined || age > maxAgeMs;
  if (!shouldSync) return;

  void syncCatalog(db).catch((error) => {
    console.error("Initial/background catalog sync failed:", error);
  });
};

maybeSync();
setInterval(maybeSync, Math.max(1, config.syncIntervalMinutes) * 60 * 1000);

serve(
  {
    fetch: app.fetch,
    port: config.port,
    hostname: config.host,
  },
  (info) => {
    console.log(`CFList listening on http://${config.host}:${info.port}`);
  },
);
