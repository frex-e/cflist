import { CodeforcesClient } from "./client.js";

let sharedClient: CodeforcesClient | undefined;

export const getCodeforcesClient = (): CodeforcesClient => {
  if (!sharedClient) sharedClient = new CodeforcesClient();
  return sharedClient;
};

/** @internal Test hook */
export const setCodeforcesClientForTests = (client: CodeforcesClient | undefined): void => {
  sharedClient = client;
};
