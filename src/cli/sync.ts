import { config } from "../config.js";
import { openDb } from "../db/connection.js";
import { migrate } from "../db/migrate.js";
import { syncCatalog } from "../cf/sync.js";

const db = openDb(config.dbPath);
migrate(db);

await syncCatalog(db);
console.log("Synced Codeforces catalog data");
