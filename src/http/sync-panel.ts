import type { AuthUser } from "../auth.js";
import { syncState } from "../cf/sync.js";
import type { Db } from "../db/connection.js";
import { getLatestUserSyncRun, hasSuccessfulUserSyncRun } from "../db/queries.js";
import { getContestSyncJobCounts } from "../db/queries/sync-jobs.js";
import type { SyncPanelOptions } from "../views/sync-panel.js";

export const buildSyncPanelOptions = (
  db: Db,
  user: AuthUser,
  returnTo: string,
  refreshPage: "problems" | "contests",
  notice?: string,
  autoSyncStarted = false,
): SyncPanelOptions => ({
  latestSync: getLatestUserSyncRun(db, user.id),
  syncRunning: syncState.userRunning.has(user.id),
  contestJobs: getContestSyncJobCounts(db, user.id),
  hasSuccessfulSync: hasSuccessfulUserSyncRun(db, user.id),
  autoSyncStarted,
  returnTo,
  refreshPage,
  notice,
});
