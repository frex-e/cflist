import type { Context, Hono } from "hono";
import type { AuthUser, AuthSession } from "../auth.js";
import type { Db } from "../db/connection.js";
import { requeueFailedContestJobsForUser, syncState } from "../cf/sync.js";
import { config } from "../config.js";
import { getManualUserSyncCooldown } from "../db/queries.js";
import { firstString } from "../http/forms.js";
import { safeReturnTo } from "../http/return-to.js";
import { buildSyncPanelOptions } from "../http/sync-panel.js";
import { syncPanelHtml, syncPanelResponseHeaders } from "../views/sync-panel.js";

type AppVariables = {
  user: AuthUser | null;
  session: AuthSession | null;
};

type AppContext = Context<{ Variables: AppVariables }>;

type SyncRouteDeps = {
  db: Db;
  requireUser: (c: AppContext) => AuthUser | Response;
  runSyncInBackground: (user: AuthUser) => boolean;
};

const refreshPageFrom = (value: string | undefined): "problems" | "contests" => {
  return value === "contests" ? "contests" : "problems";
};

const isHtmx = (c: AppContext): boolean => c.req.header("hx-request") === "true";

export const registerSyncRoutes = (
  app: Hono<{ Variables: AppVariables }>,
  deps: SyncRouteDeps,
): void => {
  const { db, requireUser, runSyncInBackground } = deps;

  app.get("/admin/sync/panel", (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;

    const returnTo = safeReturnTo(c.req.query("returnTo")) ?? "/problems";
    const refreshPage = refreshPageFrom(c.req.query("refreshPage"));
    if (!isHtmx(c)) return c.redirect(returnTo);
    const options = buildSyncPanelOptions(db, user, returnTo, refreshPage);
    return c.html(syncPanelHtml(options), 200, syncPanelResponseHeaders(options));
  });

  app.post("/admin/sync", async (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;

    const form = await c.req.parseBody();
    const returnTo = safeReturnTo(firstString(form.returnTo)) ?? "/problems";
    const refreshPage = refreshPageFrom(firstString(form.refreshPage));
    const alreadyRunning = syncState.userRunning.has(user.id);
    requeueFailedContestJobsForUser(db, user.id);

    const intervalMs = Math.max(0, config.userSyncIntervalMinutes) * 60 * 1000;
    const cooldown = getManualUserSyncCooldown(db, user.id, intervalMs);
    const rateLimited = !alreadyRunning && !cooldown.allowed;
    const started = alreadyRunning || rateLimited ? false : runSyncInBackground(user);
    if (!isHtmx(c)) return c.redirect(returnTo);

    const notice = alreadyRunning
      ? "already-running"
      : rateLimited || !started
        ? rateLimited
          ? "rate-limited"
          : "already-running"
        : undefined;

    const options = buildSyncPanelOptions(db, user, returnTo, refreshPage, notice);
    return c.html(syncPanelHtml(options), 200, syncPanelResponseHeaders(options));
  });
};
