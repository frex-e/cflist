export type SyncState = {
  catalogRunning: boolean;
  catalogSyncPromise: Promise<void> | null;
  userRunning: Set<string>;
  contestQueueRunning: boolean;
  lastCatalogStartedAt?: string;
  lastCatalogFinishedAt?: string;
  lastCatalogError?: string;
};

export const syncState: SyncState = {
  catalogRunning: false,
  catalogSyncPromise: null,
  userRunning: new Set(),
  contestQueueRunning: false,
};
