import type { Db } from "../../db/connection.js";
import { listUsersDueForAutomaticSync, type UserDueForAutomaticSync } from "../../db/queries/user.js";
import { runUserSync } from "./background.js";
import { syncState } from "./state.js";

export const ACTIVE_USER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const AUTOMATIC_USER_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

type UserSyncRunner = (db: Db, user: UserDueForAutomaticSync) => Promise<void>;

export const syncActiveUsers = async (
  db: Db,
  nowMs: number = Date.now(),
  syncUser: UserSyncRunner = runUserSync,
): Promise<void> => {
  const activeSince = new Date(nowMs - ACTIVE_USER_WINDOW_MS).toISOString();
  const syncBefore = new Date(nowMs - AUTOMATIC_USER_SYNC_INTERVAL_MS).toISOString();
  const users = listUsersDueForAutomaticSync(db, activeSince, syncBefore);

  for (const user of users) {
    if (syncState.userRunning.has(user.id)) continue;

    try {
      await syncUser(db, user);
    } catch (error) {
      console.error(`Daily Codeforces sync failed for user ${user.id}:`, error);
    }
  }
};
