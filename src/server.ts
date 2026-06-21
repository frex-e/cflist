import "./load-env.js";
import { serve } from "@hono/node-server";
import { buildAuthTrustedOrigins, config, validateProductionConfig } from "./config.js";
import { createApp } from "./app.js";
import { openDb } from "./db/connection.js";
import { migrate } from "./db/migrate.js";
import { shouldRefreshProblemMetadata, shouldSyncCatalog } from "./db/queries/catalog-sync.js";
import { resetStaleUserSyncRuns } from "./db/writes/sync-runs.js";
import { kickContestSyncQueue, refreshProblemMetadata, syncCatalog } from "./cf/sync.js";

validateProductionConfig();

const db = openDb(config.dbPath);
migrate(db);
resetStaleUserSyncRuns(db);

const publicRoot = process.env.PUBLIC_ROOT ?? "./src";
const app = createApp(db, {
  publicRoot,
  authBaseURL: config.authBaseUrl,
  authSecret: config.authSecret,
  authTrustedOrigins: buildAuthTrustedOrigins(config.port),
  githubClientId: config.githubClientId,
  githubClientSecret: config.githubClientSecret,
  authGitHubOnly: config.authGitHubOnly,
});

const maybeSync = (): void => {
  if (shouldSyncCatalog(db)) {
    void syncCatalog(db).catch((error) => {
      console.error("Initial/background catalog sync failed:", error);
    });
    return;
  }

  if (!shouldRefreshProblemMetadata(db)) return;

  void refreshProblemMetadata(db).catch((error) => {
    console.error("Initial/background problem metadata refresh failed:", error);
  });
};

maybeSync();
kickContestSyncQueue(db);

const syncIntervalMs = Math.max(1, config.syncIntervalMinutes) * 60 * 1000;
const unratedSyncIntervalMs = Math.max(1, config.syncUnratedIntervalMinutes) * 60 * 1000;
const backgroundIntervals = [
  setInterval(maybeSync, syncIntervalMs),
  setInterval(maybeSync, unratedSyncIntervalMs),
  setInterval(() => kickContestSyncQueue(db), 60 * 1000),
  setInterval(() => resetStaleUserSyncRuns(db), 5 * 60 * 1000),
];

const server = serve(
  {
    fetch: app.fetch,
    port: config.port,
    hostname: config.host,
  },
  (info) => {
    console.log(`CFList listening on http://${config.host}:${info.port}`);
  },
);

const shutdown = (signal: string): void => {
  console.log(`Received ${signal}, shutting down...`);
  for (const interval of backgroundIntervals) clearInterval(interval);

  server.close(() => {
    db.close();
    console.log("Shutdown complete");
    process.exit(0);
  });

  setTimeout(() => {
    console.error("Forced shutdown after timeout");
    process.exit(1);
  }, 10_000).unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
