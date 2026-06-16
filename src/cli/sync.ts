import { config } from "../config.js";
import { openDb } from "../db/connection.js";
import { migrate } from "../db/migrate.js";
import { syncCodeforces } from "../cf/sync.js";

const db = openDb(config.dbPath);
migrate(db);

await syncCodeforces(db, config.cfHandle);
console.log(`Synced Codeforces data for ${config.cfHandle}`);

