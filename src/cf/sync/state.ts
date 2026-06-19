export type SyncState = {
  catalogRunning: boolean;
  userRunning: Set<string>;
  contestQueueRunning: boolean;
  lastCatalogStartedAt?: string;
  lastCatalogFinishedAt?: string;
  lastCatalogError?: string;
};

export const syncState: SyncState = {
  catalogRunning: false,
  userRunning: new Set(),
  contestQueueRunning: false,
};
