import { config } from "../../config.js";
import type { Db } from "../../db/connection.js";
import {
  getManualUserSyncCooldown,
  listActiveUsersDueForDailySync,
  listUsersNeedingPostContestSync,
  type AutoSyncUser,
} from "../../db/queries.js";
import { kickContestSyncQueue } from "./contest-queue.js";
import { syncState } from "./state.js";
import { syncUserStatus } from "./user-status.js";

export type SyncableUser = Pick<AutoSyncUser, "id" | "cfHandle">;

export const maybeStartUserSync = (
  db: Db,
  user: SyncableUser,
  intervalMs: number,
): boolean => {
  const cfHandle = user.cfHandle?.trim();
  if (!cfHandle) return false;
  if (syncState.userRunning.has(user.id)) return false;

  const cooldown = getManualUserSyncCooldown(db, user.id, intervalMs);
  if (!cooldown.allowed) return false;

  void syncUserStatus(db, user.id, cfHandle)
    .then(() => kickContestSyncQueue(db))
    .catch((error) => {
      console.error("Codeforces sync failed:", error);
    });

  return true;
};

const userSyncIntervalMs = (): number =>
  Math.max(0, config.userSyncIntervalMinutes) * 60 * 1000;

const dailySyncIntervalMs = (): number =>
  Math.max(1, config.dailyUserSyncHours) * 60 * 60 * 1000;

const activeUserWindowMs = (): number =>
  Math.max(1, config.activeUserDays) * 24 * 60 * 60 * 1000;

const postContestLookbackMs = (): number =>
  Math.max(1, config.postContestSyncLookbackHours) * 60 * 60 * 1000;

export const syncDueActiveUsers = (db: Db, nowMs: number = Date.now()): number => {
  const users = listActiveUsersDueForDailySync(db, {
    activeWithinMs: activeUserWindowMs(),
    minSyncAgeMs: dailySyncIntervalMs(),
    nowMs,
  });

  let started = 0;
  for (const user of users) {
    if (maybeStartUserSync(db, user, dailySyncIntervalMs())) started += 1;
  }
  return started;
};

export const syncUsersForRecentlyEndedContests = (
  db: Db,
  nowMs: number = Date.now(),
): number => {
  const users = listUsersNeedingPostContestSync(db, {
    lookbackMs: postContestLookbackMs(),
    nowMs,
  });

  let started = 0;
  const intervalMs = userSyncIntervalMs();
  for (const user of users) {
    if (maybeStartUserSync(db, user, intervalMs)) started += 1;
  }
  return started;
};
