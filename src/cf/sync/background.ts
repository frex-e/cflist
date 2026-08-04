import type { Db } from "../../db/connection.js";
import { kickContestSyncQueue } from "./contest-queue.js";
import { syncState } from "./state.js";
import { syncUserStatus } from "./user-status.js";

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
