import { syncState } from "../cf/sync.js";
import type { ContestSyncJobCounts } from "../db/queries/sync-jobs.js";
import { hasPendingContestSyncJobs, isStuckUserSyncRun } from "../db/queries/sync-jobs.js";
import { formatDateTime } from "./html.js";
import { render } from "./render.js";

export type SyncPanelOptions = {
  latestSync?: { started_at: string; finished_at: string | null; status: string; message: string | null };
  syncRunning: boolean;
  contestJobs: ContestSyncJobCounts;
  hasSuccessfulSync: boolean;
  autoSyncStarted?: boolean;
  returnTo: string;
  refreshPage: "problems" | "contests";
  notice?: string;
};

const STALE_SYNC_MS = 24 * 60 * 60 * 1000;

const hydrationSummary = (counts: ContestSyncJobCounts): string | undefined => {
  const pending = counts.queued + counts.running + counts.failedRetryable;
  if (pending === 0 && counts.failedPermanent === 0) return undefined;

  const parts: string[] = [];
  if (counts.total > 0) {
    parts.push(`Hydrating contests: ${counts.done}/${counts.total} done`);
  }
  if (pending > 0) {
    parts.push(`${pending} in progress`);
  }
  if (counts.failedPermanent > 0) {
    parts.push(`${counts.failedPermanent} failed`);
  }
  return parts.join(" · ");
};

const statusHeading = (options: SyncPanelOptions): string => {
  const { latestSync, syncRunning, notice } = options;

  if (notice === "already-running") return "Sync already in progress";
  if (syncRunning) {
    return syncState.catalogRunning ? "Syncing from Codeforces… (updating catalog)" : "Syncing from Codeforces…";
  }
  if (isStuckUserSyncRun(latestSync, syncRunning)) return "Last sync interrupted — try again";

  if (!latestSync) {
    return "Not synced yet — pull your Codeforces solved list and contest history.";
  }

  if (latestSync.status === "failed") return "Sync failed";

  if (latestSync.status === "running") return "Syncing from Codeforces…";

  if (latestSync.status === "success" && latestSync.finished_at) {
    const finishedAt = Date.parse(latestSync.finished_at);
    if (Number.isFinite(finishedAt) && Date.now() - finishedAt > STALE_SYNC_MS) {
      const days = Math.floor((Date.now() - finishedAt) / STALE_SYNC_MS);
      return `Last synced ${formatDateTime(latestSync.finished_at)} (${days} day${days === 1 ? "" : "s"} ago)`;
    }
    return `Last synced at ${formatDateTime(latestSync.finished_at)}`;
  }

  return latestSync.status;
};

const panelClassName = (options: SyncPanelOptions): string => {
  const classes = ["sync-panel"];
  if (options.latestSync?.status === "failed" && !options.syncRunning) classes.push("sync-panel--failed");
  return classes.join(" ");
};

const panelUrl = (options: Pick<SyncPanelOptions, "returnTo" | "refreshPage">): string => {
  const params = new URLSearchParams({
    returnTo: options.returnTo,
    refreshPage: options.refreshPage,
  });
  return `/admin/sync/panel?${params}`;
};

export const SyncPanel = (options: SyncPanelOptions) => {
  const { latestSync, syncRunning, contestJobs, returnTo, refreshPage, autoSyncStarted } = options;
  const shouldPoll = syncRunning || hasPendingContestSyncJobs(contestJobs) || syncState.catalogRunning;
  const hydrationLine = hydrationSummary(contestJobs);
  const status = statusHeading(options);
  const showMessage = latestSync?.message && (latestSync.status === "failed" || latestSync.status === "success");

  return (
    <section
      class={panelClassName(options)}
      aria-label="Codeforces sync"
      data-sync-panel
      data-sync-running={syncRunning ? "true" : "false"}
      data-sync-status={latestSync?.status ?? "none"}
      data-refresh-page={refreshPage}
      data-auto-sync-started={autoSyncStarted ? "true" : "false"}
      hx-get={shouldPoll ? panelUrl({ returnTo, refreshPage }) : undefined}
      hx-trigger={shouldPoll ? "every 3s" : undefined}
      hx-target="this"
      hx-swap={shouldPoll ? "outerHTML" : undefined}
    >
      <div class="sync-panel-copy">
        <span class="sync-panel-status">{status}</span>
        {showMessage ? <p class="sync-panel-message">{latestSync.message}</p> : null}
        {hydrationLine ? <p class="sync-panel-hydration">{hydrationLine}</p> : null}
      </div>
      <form
        method="post"
        action="/admin/sync"
        hx-post="/admin/sync"
        hx-target="closest [data-sync-panel]"
        hx-swap="outerHTML"
      >
        <input type="hidden" name="returnTo" value={returnTo} />
        <input type="hidden" name="refreshPage" value={refreshPage} />
        <button type="submit" disabled={syncRunning}>
          {syncRunning ? "Syncing…" : "Sync"}
        </button>
      </form>
    </section>
  );
};

export const syncPanelHtml = (options: SyncPanelOptions): string => render(<SyncPanel {...options} />);
