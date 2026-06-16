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
  syncIntervalMinutes: intFromEnv("SYNC_INTERVAL_MINUTES", 360),
  authSecret:
    process.env.BETTER_AUTH_SECRET ??
    process.env.AUTH_SECRET ??
    "development-only-change-me-32-chars-min",
  authBaseUrl:
    process.env.BETTER_AUTH_URL ??
    process.env.AUTH_BASE_URL ??
    `http://${process.env.HOST ?? "127.0.0.1"}:${intFromEnv("PORT", 3000)}`,
  authTrustedOrigins: (process.env.AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
};
