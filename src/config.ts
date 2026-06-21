import path from "node:path";

const intFromEnv = (name: string, fallback: number): number => {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const boolFromEnv = (name: string, fallback = false): boolean => {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return value === "1" || value === "true" || value === "yes";
};

export const DEV_AUTH_SECRET = "development-only-change-me-32-chars-min";

export const config = {
  port: intFromEnv("PORT", 3000),
  host: process.env.HOST ?? "127.0.0.1",
  dbPath: process.env.DB_PATH ?? path.join(process.cwd(), "data", "cflist.sqlite"),
  syncIntervalMinutes: intFromEnv("SYNC_INTERVAL_MINUTES", 360),
  syncUnratedIntervalMinutes: intFromEnv("SYNC_UNRATED_INTERVAL_MINUTES", 60),
  authSecret:
    process.env.BETTER_AUTH_SECRET ??
    process.env.AUTH_SECRET ??
    DEV_AUTH_SECRET,
  authBaseUrl:
    process.env.BETTER_AUTH_URL ??
    process.env.AUTH_BASE_URL ??
    `http://${process.env.HOST ?? "127.0.0.1"}:${intFromEnv("PORT", 3000)}`,
  authTrustedOrigins: (process.env.AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  githubClientId: process.env.GITHUB_CLIENT_ID,
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET,
  authGitHubOnly: boolFromEnv("AUTH_GITHUB_ONLY"),
};

export const validateProductionConfig = (): void => {
  if (process.env.NODE_ENV !== "production") return;

  const secretFromEnv = process.env.BETTER_AUTH_SECRET ?? process.env.AUTH_SECRET;
  const authSecret =
    secretFromEnv ?? DEV_AUTH_SECRET;

  if (!secretFromEnv) {
    throw new Error("BETTER_AUTH_SECRET (or AUTH_SECRET) is required in production");
  }
  if (authSecret === DEV_AUTH_SECRET) {
    throw new Error("BETTER_AUTH_SECRET must not use the development default in production");
  }

  const baseUrl =
    process.env.BETTER_AUTH_URL ??
    process.env.AUTH_BASE_URL ??
    config.authBaseUrl;
  if (/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/i.test(baseUrl)) {
    throw new Error("BETTER_AUTH_URL must be set to the public HTTPS origin in production");
  }
};

export const buildAuthTrustedOrigins = (port: number): string[] => {
  const origins = [...config.authTrustedOrigins];
  if (process.env.NODE_ENV !== "production") {
    origins.push(`http://localhost:${port}`, `http://127.0.0.1:${port}`);
  }
  return origins;
};
