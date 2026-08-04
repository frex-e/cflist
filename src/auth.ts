import { betterAuth } from "better-auth";
import type { Db } from "./db/connection.js";

export type AuthUser = {
  id: string;
  name: string;
  email: string;
  cfHandle: string;
};

export type AuthSession = {
  id: string;
  userId: string;
  token: string;
  expiresAt: Date;
};

export type AuthConfig = {
  baseURL: string;
  secret: string;
  trustedOrigins: string[];
  githubClientId?: string;
  githubClientSecret?: string;
  githubOnly?: boolean;
  onSessionCreated?: (userId: string) => void | Promise<void>;
};

export const needsCfHandle = (user: AuthUser): boolean => !user.cfHandle?.trim();

export const githubAuthEnabled = (config: Pick<AuthConfig, "githubClientId" | "githubClientSecret">): boolean =>
  Boolean(config.githubClientId && config.githubClientSecret);

export const emailAuthEnabled = (config: Pick<AuthConfig, "githubOnly">): boolean => !config.githubOnly;

export const createAuth = (db: Db, config: AuthConfig) => {
  const githubEnabled = githubAuthEnabled(config);
  const emailEnabled = emailAuthEnabled(config);

  if (config.githubOnly && !githubEnabled) {
    throw new Error("GitHub-only auth requires GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET");
  }

  return betterAuth({
    database: db,
    baseURL: config.baseURL,
    secret: config.secret,
    trustedOrigins: config.trustedOrigins,
    emailAndPassword: emailEnabled
      ? {
          enabled: true,
          minPasswordLength: 8,
        }
      : {
          enabled: false,
        },
    ...(githubEnabled
      ? {
          socialProviders: {
            github: {
              clientId: config.githubClientId!,
              clientSecret: config.githubClientSecret!,
            },
          },
          account: {
            accountLinking: {
              enabled: false,
            },
          },
        }
      : {}),
    user: {
      additionalFields: {
        cfHandle: {
          type: "string",
          required: false,
          input: true,
          defaultValue: "",
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => ({
            data: {
              ...user,
              cfHandle: user.cfHandle ?? "",
            },
          }),
        },
      },
      session: {
        create: {
          after: async (session) => {
            await config.onSessionCreated?.(session.userId);
          },
        },
      },
    },
  });
};
