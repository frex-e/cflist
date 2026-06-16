import path from "node:path";

const intFromEnv = (name: string, fallback: number): number => {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  port: intFromEnv("PORT", 3000),
  host: process.env.HOST ?? "127.0.0.1",
  dbPath: process.env.DB_PATH ?? path.join(process.cwd(), "data", "cflist.sqlite"),
  cfHandle: process.env.CF_HANDLE ?? "inj",
  syncIntervalMinutes: intFromEnv("SYNC_INTERVAL_MINUTES", 360),
  adminToken: process.env.ADMIN_TOKEN ?? "",
};
