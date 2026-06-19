import type { Context, Hono } from "hono";
import type { AuthUser, AuthSession } from "../auth.js";
import type { Db } from "../db/connection.js";
import { getLatestUserSyncRun, listUserContestResults } from "../db/queries.js";
import { syncState } from "../cf/sync.js";
import { contestsPage } from "../views/contests.js";

type AppVariables = {
  user: AuthUser | null;
  session: AuthSession | null;
};

type AppContext = Context<{ Variables: AppVariables }>;

type ContestsRouteDeps = {
  db: Db;
  requireUser: (c: AppContext) => AuthUser | Response;
};

export const registerContestsRoutes = (
  app: Hono<{ Variables: AppVariables }>,
  deps: ContestsRouteDeps,
): void => {
  const { db, requireUser } = deps;

  app.get("/contests", (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;

    return c.html(contestsPage({
      rows: listUserContestResults(db, user.id),
      latestSync: getLatestUserSyncRun(db, user.id),
      syncRunning: syncState.userRunning.has(user.id),
      user,
    }));
  });
};
