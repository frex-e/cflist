import assert from "node:assert/strict";
import test from "node:test";
import { shouldLogRequest } from "../src/app.js";

test("request logging suppresses routine reads and health checks", () => {
  assert.equal(shouldLogRequest("GET", "/problems", 200, 25), false);
  assert.equal(shouldLogRequest("HEAD", "/public/styles.css", 200, 5), false);
  assert.equal(shouldLogRequest("OPTIONS", "/api/auth/session", 204, 2), false);
  assert.equal(shouldLogRequest("GET", "/healthz", 503, 1_500), false);
});

test("request logging retains mutations, failed reads, and slow reads", () => {
  assert.equal(shouldLogRequest("POST", "/sync", 303, 25), true);
  assert.equal(shouldLogRequest("GET", "/missing", 404, 10), true);
  assert.equal(shouldLogRequest("GET", "/problems", 500, 10), true);
  assert.equal(shouldLogRequest("GET", "/contests", 200, 1_000), true);
});
