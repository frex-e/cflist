import type { Hono } from "hono";
import type { AuthUser, AuthSession } from "../auth.js";
import { needsCfHandle } from "../auth.js";
import { kickContestSyncQueue, refreshUserContestDetails, syncState } from "../cf/sync.js";
import { clearUserCfData, deleteUserAccount } from "../db/writes/user-data.js";
import { firstString } from "../http/forms.js";
import type { Db } from "../db/connection.js";
import { settingsPage } from "../views/settings.js";

type SettingsVariables = {
  user: AuthUser | null;
  session: AuthSession | null;
};

type SettingsRouteDeps = {
  db: Db;
  proxyAuthSignOut: (cookie: string | undefined) => Promise<Response>;
  redirectWithAuthCookies: (authResponse: Response, location: string) => Response;
  runSyncInBackground: (user: AuthUser) => boolean;
};

const confirmHandleMatches = (typed: string | undefined, handle: string): boolean =>
  typed?.trim().toLowerCase() === handle.trim().toLowerCase();

const redirectToSettings = (params: Record<string, string>): Response => {
  const query = new URLSearchParams(params);
  return new Response(null, {
    status: 303,
    headers: { location: `/settings?${query.toString()}` },
  });
};

export const registerSettingsRoutes = (
  app: Hono<{ Variables: SettingsVariables }>,
  deps: SettingsRouteDeps,
): void => {
  app.get("/settings", (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/sign-in?returnTo=%2Fsettings");
    if (needsCfHandle(user)) return c.redirect("/complete-profile?returnTo=%2Fsettings");

    return c.html(
      settingsPage({
        user,
        error: c.req.query("error"),
        success: c.req.query("success"),
      }),
    );
  });

  app.post("/settings/reset-cf-data", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/sign-in?returnTo=%2Fsettings");
    if (needsCfHandle(user)) return c.redirect("/complete-profile?returnTo=%2Fsettings");

    const form = await c.req.parseBody();
    if (!confirmHandleMatches(firstString(form.confirmHandle), user.cfHandle)) {
      return redirectToSettings({ error: "Confirmation handle did not match." });
    }

    if (syncState.userRunning.has(user.id)) {
      return redirectToSettings({ error: "A sync is already running. Wait for it to finish, then try again." });
    }

    clearUserCfData(deps.db, user.id);
    deps.runSyncInBackground(user);

    return redirectToSettings({ success: "Codeforces data cleared. A fresh sync has started." });
  });

  app.post("/settings/refresh-contest-details", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/sign-in?returnTo=%2Fsettings");
    if (needsCfHandle(user)) return c.redirect("/complete-profile?returnTo=%2Fsettings");

    const form = await c.req.parseBody();
    if (!confirmHandleMatches(firstString(form.confirmHandle), user.cfHandle)) {
      return redirectToSettings({ error: "Confirmation handle did not match." });
    }

    if (syncState.userRunning.has(user.id)) {
      return redirectToSettings({ error: "A sync is already running. Wait for it to finish, then try again." });
    }

    const contestCount = refreshUserContestDetails(deps.db, user.id, user.cfHandle);
    kickContestSyncQueue(deps.db);

    return redirectToSettings({
      success: contestCount > 0
        ? `Queued refresh for ${contestCount} contest${contestCount === 1 ? "" : "s"}. Details will update in the background.`
        : "No synced contests to refresh.",
    });
  });

  app.post("/settings/delete-account", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/sign-in");

    const form = await c.req.parseBody();
    if (!confirmHandleMatches(firstString(form.confirmHandle), user.cfHandle)) {
      return redirectToSettings({ error: "Confirmation handle did not match." });
    }

    if (syncState.userRunning.has(user.id)) {
      return redirectToSettings({ error: "A sync is already running. Wait for it to finish, then try again." });
    }

    deleteUserAccount(deps.db, user.id);
    syncState.userRunning.delete(user.id);

    const signOutResponse = await deps.proxyAuthSignOut(c.req.header("cookie"));
    return deps.redirectWithAuthCookies(signOutResponse, "/sign-in");
  });
};
