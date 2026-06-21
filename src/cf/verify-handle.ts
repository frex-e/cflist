import type { CodeforcesClient } from "./client.js";
import { getCodeforcesClient } from "./shared-client.js";

const handlePattern = /^[a-zA-Z0-9_-]{1,24}$/;

let verifyHandleOverride: ((handle: string) => Promise<boolean>) | undefined;

/** @internal Test hook */
export const setVerifyHandleForTests = (fn: ((handle: string) => Promise<boolean>) | undefined): void => {
  verifyHandleOverride = fn;
};

export const isValidCfHandleFormat = (handle: string): boolean => handlePattern.test(handle);

export const verifyCodeforcesHandle = async (
  handle: string,
  client: CodeforcesClient = getCodeforcesClient(),
): Promise<boolean> => {
  if (verifyHandleOverride) return verifyHandleOverride(handle);
  if (!isValidCfHandleFormat(handle)) return false;

  try {
    const users = await client.userInfo(handle);
    return users.some((user) => user.handle.toLowerCase() === handle.toLowerCase());
  } catch {
    return false;
  }
};
