import type { Db } from "../connection.js";

export const clearUserCfData = (db: Db, userId: string): void => {
  db.exec("BEGIN");
  try {
    db.prepare(`DELETE FROM user_problem_status WHERE user_id = @userId`).run({ userId });
    db.prepare(`DELETE FROM user_problem_overrides WHERE user_id = @userId`).run({ userId });
    db.prepare(`DELETE FROM user_contest_results WHERE user_id = @userId`).run({ userId });
    db.prepare(`DELETE FROM user_contest_problem_results WHERE user_id = @userId`).run({ userId });
    db.prepare(`DELETE FROM contest_performance_cache WHERE user_id = @userId`).run({ userId });
    db.prepare(`DELETE FROM contest_sync_jobs WHERE user_id = @userId`).run({ userId });
    db.prepare(`DELETE FROM sync_runs WHERE user_id = @userId`).run({ userId });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
};

export const deleteUserAccount = (db: Db, userId: string): void => {
  db.prepare(`DELETE FROM "user" WHERE id = @userId`).run({ userId });
};
