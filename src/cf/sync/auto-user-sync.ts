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

/** Max user syncs started per hourly auto-sync tick (shared across daily + post-contest). */
export const AUTO_USER_SYNC_BATCH_LIMIT = 3;

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

const startEligibleUsers = (
  db: Db,
  users: AutoSyncUser[],
  limit: number,
): number => {
  let started = 0;
  for (const user of users) {
    if (started >= limit) break;
    // Eligibility already enforced by the listing query; only gate on handle + in-flight.
    if (maybeStartUserSync(db, user, 0)) started += 1;
  }
  return started;
};

const dailySyncIntervalMs = (): number =>
  Math.max(1, config.dailyUserSyncHours) * 60 * 60 * 1000;

const activeUserWindowMs = (): number =>
  Math.max(1, config.activeUserDays) * 24 * 60 * 60 * 1000;

const postContestLookbackMs = (): number =>
  Math.max(1, config.postContestSyncLookbackHours) * 60 * 60 * 1000;

export const syncDueActiveUsers = (
  db: Db,
  nowMs: number = Date.now(),
  limit: number = AUTO_USER_SYNC_BATCH_LIMIT,
): number => {
  if (limit <= 0) return 0;

  const users = listActiveUsersDueForDailySync(db, {
    activeWithinMs: activeUserWindowMs(),
    minSyncAgeMs: dailySyncIntervalMs(),
    nowMs,
    limit,
  });

  return startEligibleUsers(db, users, limit);
};

export const syncUsersForRecentlyEndedContests = (
  db: Db,
  nowMs: number = Date.now(),
  limit: number = AUTO_USER_SYNC_BATCH_LIMIT,
): number => {
  if (limit <= 0) return 0;

  const users = listUsersNeedingPostContestSync(db, {
    lookbackMs: postContestLookbackMs(),
    nowMs,
    limit,
  });

  return startEligibleUsers(db, users, limit);
};

/** Hourly tick: post-contest first (time-sensitive), then daily, under one batch cap. */
export const runAutoUserSyncTick = (
  db: Db,
  nowMs: number = Date.now(),
  limit: number = AUTO_USER_SYNC_BATCH_LIMIT,
): { postContest: number; daily: number } => {
  const postContest = syncUsersForRecentlyEndedContests(db, nowMs, limit);
  const daily = syncDueActiveUsers(db, nowMs, limit - postContest);
  return { postContest, daily };
};
