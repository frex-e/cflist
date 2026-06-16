import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { createApp } from "./app.js";
import { openDb } from "./db/connection.js";
import { migrate } from "./db/migrate.js";
import { latestSuccessfulSyncAgeMs, problemCount } from "./db/queries.js";
import { syncCodeforces } from "./cf/sync.js";

const db = openDb(config.dbPath);
migrate(db);

const publicRoot = process.env.PUBLIC_ROOT ?? "./src";
const app = createApp(db, {
  handle: config.cfHandle,
  adminToken: config.adminToken,
  publicRoot,
});

const maybeSync = (): void => {
  const maxAgeMs = config.syncIntervalMinutes * 60 * 1000;
  const age = latestSuccessfulSyncAgeMs(db);
  const shouldSync = problemCount(db) === 0 || age === undefined || age > maxAgeMs;
  if (!shouldSync) return;

  void syncCodeforces(db, config.cfHandle).catch((error) => {
    console.error("Initial/background sync failed:", error);
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
