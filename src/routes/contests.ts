import type { Context, Hono } from "hono";
import type { AuthUser, AuthSession } from "../auth.js";
import type { Db } from "../db/connection.js";
import { getContestSyncJobsByContest, listUserContestResults } from "../db/queries.js";
import type { ContestResultRow } from "../db/queries.js";
import type { ContestSyncJobRow } from "../db/queries.js";
import { buildSyncPanelOptions } from "../http/sync-panel.js";
import { contestsPage, contestsTableFragment } from "../views/contests.js";
import { filterContestTableRows, parseContestTableFilters } from "../views/contests/filters.js";

type AppVariables = {
  user: AuthUser | null;
  session: AuthSession | null;
};

type AppContext = Context<{ Variables: AppVariables }>;

type ContestsRouteDeps = {
  db: Db;
  requireUser: (c: AppContext) => AuthUser | Response;
  maybeStartInitialSync: (user: AuthUser) => boolean;
};

const MAX_CONTEST_JOB_ATTEMPTS = 3;

const hydrationFromJob = (job: ContestSyncJobRow | undefined): Pick<ContestResultRow, "hydration_status" | "hydration_error"> => {
  if (!job) return {};

  if (job.status === "queued" || job.status === "running") {
    return { hydration_status: job.status };
  }

  if (job.status === "failed") {
    if (job.attempts >= MAX_CONTEST_JOB_ATTEMPTS) {
      return { hydration_status: "failed", hydration_error: job.last_error };
    }
    return { hydration_status: "queued" };
  }

  return {};
};

const contestsOptionsFor = (db: Db, user: AuthUser, searchParams: URLSearchParams, autoSyncStarted = false) => {
  const jobs = getContestSyncJobsByContest(db, user.id);
  const rows = listUserContestResults(db, user.id).map((row) => ({
    ...row,
    ...hydrationFromJob(jobs.get(row.contest_id)),
  }));
  const filters = parseContestTableFilters(searchParams);

  return {
    rows,
    tableRows: filterContestTableRows(rows, filters),
    filters,
    syncPanel: buildSyncPanelOptions(db, user, "/contests", "contests", undefined, autoSyncStarted),
    user,
  };
};

export const registerContestsRoutes = (
  app: Hono<{ Variables: AppVariables }>,
  deps: ContestsRouteDeps,
): void => {
  const { db, requireUser, maybeStartInitialSync } = deps;

  app.get("/contests", (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;
    const autoSyncStarted = maybeStartInitialSync(user);

    const searchParams = new URL(c.req.url).searchParams;
    return c.html(contestsPage(contestsOptionsFor(db, user, searchParams, autoSyncStarted)));
  });

  app.get("/contests/fragment", (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;

    const searchParams = new URL(c.req.url).searchParams;
    return c.html(contestsTableFragment(contestsOptionsFor(db, user, searchParams)));
  });
};
