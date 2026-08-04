import type { Db } from "../../db/connection.js";
import { listUsersDueForAutomaticSync } from "../../db/queries/user.js";
import { kickContestSyncQueue } from "./contest-queue.js";
import { syncState } from "./state.js";
import { syncUserStatus } from "./user-status.js";

export const ACTIVE_USER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const AUTOMATIC_USER_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type SyncableUser = {
  id: string;
  cfHandle: string;
};

export const runUserSync = async (db: Db, user: SyncableUser): Promise<void> => {
  await syncUserStatus(db, user.id, user.cfHandle);
  kickContestSyncQueue(db);
};

export const startUserSyncInBackground = (db: Db, user: SyncableUser): boolean => {
  if (syncState.userRunning.has(user.id)) return false;

  void runUserSync(db, user).catch((error) => {
    console.error("Codeforces sync failed:", error);
  });

  return true;
};

export const syncActiveUsers = async (
  db: Db,
  nowMs: number = Date.now(),
  syncUser: (db: Db, user: SyncableUser) => Promise<void> = runUserSync,
): Promise<void> => {
  const users = listUsersDueForAutomaticSync(
    db,
    new Date(nowMs - ACTIVE_USER_WINDOW_MS).toISOString(),
    new Date(nowMs - AUTOMATIC_USER_SYNC_INTERVAL_MS).toISOString(),
  );

  for (const user of users) {
    if (syncState.userRunning.has(user.id)) continue;

    try {
      await syncUser(db, user);
    } catch (error) {
      console.error(`Daily Codeforces sync failed for user ${user.id}:`, error);
    }
  }
};
