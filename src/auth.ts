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
};

export const createAuth = (db: Db, config: AuthConfig) => {
  return betterAuth({
    database: db,
    baseURL: config.baseURL,
    secret: config.secret,
    trustedOrigins: config.trustedOrigins,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
    },
    user: {
      additionalFields: {
        cfHandle: {
          type: "string",
          required: true,
          input: true,
        },
      },
    },
  });
};
