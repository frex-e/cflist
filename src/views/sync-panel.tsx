import { formatDateTime } from "./html.js";

type SyncPanelOptions = {
  latestSync?: { started_at: string; finished_at: string | null; status: string; message: string | null };
  syncRunning: boolean;
  returnTo: string;
  refreshLabel?: string;
};

export const SyncPanel = (options: SyncPanelOptions) => {
  const { latestSync, syncRunning, returnTo, refreshLabel = "Refresh" } = options;
  const status = syncRunning
    ? "Sync running"
    : latestSync
      ? `${latestSync.status} ${latestSync.finished_at ? `at ${formatDateTime(latestSync.finished_at)}` : ""}`
      : "No sync yet";

  return (
    <section class="sync-panel" aria-label="Codeforces refresh">
      <div>
        <span>{status}</span>
        {latestSync?.message ? <p>{latestSync.message}</p> : ""}
      </div>
      <form method="post" action="/admin/sync">
        <input type="hidden" name="returnTo" value={returnTo} />
        <button type="submit" disabled={syncRunning}>
          {syncRunning ? "Syncing" : refreshLabel}
        </button>
      </form>
    </section>
  );
};
