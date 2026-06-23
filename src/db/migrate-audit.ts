import type { Db } from "./connection.js";

export const cleanupOrphanRows = (db: Db): void => {
  const tableExists = (name: string): boolean => {
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = @name`)
      .get({ name }) as { name: string } | undefined;
    return row !== undefined;
  };

  if (tableExists("sync_runs")) {
    db.exec(`
      UPDATE sync_runs
      SET user_id = NULL
      WHERE user_id IS NOT NULL
        AND user_id NOT IN (SELECT id FROM "user")
    `);
  }

  if (tableExists("problems") && tableExists("contests")) {
    db.exec(`
      INSERT INTO contests (id, name, raw_json, updated_at)
      SELECT DISTINCT
        p.contest_id,
        'Contest ' || p.contest_id,
        '{}',
        datetime('now')
      FROM problems p
      WHERE NOT EXISTS (SELECT 1 FROM contests c WHERE c.id = p.contest_id)
    `);
  }

  if (tableExists("user_problem_status") && tableExists("problems")) {
    db.exec(`
      DELETE FROM user_problem_status
      WHERE NOT EXISTS (
        SELECT 1 FROM problems p
        WHERE p.contest_id = user_problem_status.contest_id
          AND p.problem_index = user_problem_status.problem_index
      )
    `);
  }

  if (tableExists("user_contest_problem_results") && tableExists("problems")) {
    db.exec(`
      DELETE FROM user_contest_problem_results
      WHERE NOT EXISTS (
        SELECT 1 FROM problems p
        WHERE p.contest_id = user_contest_problem_results.contest_id
          AND p.problem_index = user_contest_problem_results.problem_index
      )
    `);
  }
};
