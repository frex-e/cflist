import assert from "node:assert/strict";
import test from "node:test";
import { DEV_AUTH_SECRET, validateProductionConfig } from "../src/config.js";

test("validateProductionConfig rejects missing secret in production", () => {
  const originalEnv = { ...process.env };
  try {
    process.env.NODE_ENV = "production";
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.AUTH_SECRET;
    assert.throws(() => validateProductionConfig(), /BETTER_AUTH_SECRET/);
  } finally {
    process.env = originalEnv;
  }
});

test("validateProductionConfig rejects development default secret in production", () => {
  const originalEnv = { ...process.env };
  try {
    process.env.NODE_ENV = "production";
    process.env.BETTER_AUTH_SECRET = DEV_AUTH_SECRET;
    process.env.BETTER_AUTH_URL = "https://cflist.example.com";
    assert.throws(() => validateProductionConfig(), /development default/);
  } finally {
    process.env = originalEnv;
  }
});

test("validateProductionConfig rejects localhost base URL in production", () => {
  const originalEnv = { ...process.env };
  try {
    process.env.NODE_ENV = "production";
    process.env.BETTER_AUTH_SECRET = "production-secret-with-enough-length";
    process.env.BETTER_AUTH_URL = "http://127.0.0.1:3000";
    assert.throws(() => validateProductionConfig(), /BETTER_AUTH_URL/);
  } finally {
    process.env = originalEnv;
  }
});

test("validateProductionConfig passes with valid production env", () => {
  const originalEnv = { ...process.env };
  try {
    process.env.NODE_ENV = "production";
    process.env.BETTER_AUTH_SECRET = "production-secret-with-enough-length";
    process.env.BETTER_AUTH_URL = "https://cflist.example.com";
    assert.doesNotThrow(() => validateProductionConfig());
  } finally {
    process.env = originalEnv;
  }
});
