import type { AuthUser } from "../auth.js";
import { syncState } from "../cf/sync.js";
import { config } from "../config.js";
import type { Db } from "../db/connection.js";
import { getLatestUserSyncRun, getManualUserSyncCooldown, hasSuccessfulUserSyncRun } from "../db/queries.js";
import { getContestSyncJobCounts } from "../db/queries/sync-jobs.js";
import type { SyncPanelOptions } from "../views/sync-panel.js";

export const buildSyncPanelOptions = (
  db: Db,
  user: AuthUser,
  returnTo: string,
  refreshPage: "problems" | "contests",
  notice?: string,
  autoSyncStarted = false,
): SyncPanelOptions => {
  const intervalMs = Math.max(0, config.userSyncIntervalMinutes) * 60 * 1000;
  const cooldown = getManualUserSyncCooldown(db, user.id, intervalMs);

  return {
    latestSync: getLatestUserSyncRun(db, user.id),
    syncRunning: syncState.userRunning.has(user.id),
    contestJobs: getContestSyncJobCounts(db, user.id),
    hasSuccessfulSync: hasSuccessfulUserSyncRun(db, user.id),
    cooldown,
    autoSyncStarted,
    returnTo,
    refreshPage,
    notice,
  };
};
