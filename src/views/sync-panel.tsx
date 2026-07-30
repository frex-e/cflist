import { syncState } from "../cf/sync.js";
import type { ManualUserSyncCooldown } from "../db/queries.js";
import type { ContestSyncJobCounts } from "../db/queries/sync-jobs.js";
import { hasPendingContestSyncJobs, isStuckUserSyncRun } from "../db/queries/sync-jobs.js";
import { formatDateTime } from "./html.js";
import { render } from "./render.js";

export type SyncPanelOptions = {
  latestSync?: { started_at: string; finished_at: string | null; status: string; message: string | null };
  syncRunning: boolean;
  contestJobs: ContestSyncJobCounts;
  hasSuccessfulSync: boolean;
  cooldown: ManualUserSyncCooldown;
  autoSyncStarted?: boolean;
  returnTo: string;
  refreshPage: "problems" | "contests";
  notice?: string;
};

const STALE_SYNC_MS = 24 * 60 * 60 * 1000;

export const formatRetryAfter = (ms: number): string => {
  const totalMinutes = Math.max(1, Math.ceil(ms / 60_000));
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
};

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
  const { latestSync, syncRunning, notice, cooldown } = options;

  if (notice === "already-running") return "Sync already in progress";
  if (notice === "rate-limited" && !cooldown.allowed) {
    return `Synced recently — next sync available in ${formatRetryAfter(cooldown.retryAfterMs)}`;
  }
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
    let base: string;
    if (Number.isFinite(finishedAt) && Date.now() - finishedAt > STALE_SYNC_MS) {
      const days = Math.floor((Date.now() - finishedAt) / STALE_SYNC_MS);
      base = `Last synced ${formatDateTime(latestSync.finished_at)} (${days} day${days === 1 ? "" : "s"} ago)`;
    } else {
      base = `Last synced at ${formatDateTime(latestSync.finished_at)}`;
    }
    if (!cooldown.allowed) {
      return `${base} · next sync in ${formatRetryAfter(cooldown.retryAfterMs)}`;
    }
    return base;
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
  const { latestSync, syncRunning, contestJobs, returnTo, refreshPage, autoSyncStarted, cooldown } = options;
  const shouldPoll = syncRunning || hasPendingContestSyncJobs(contestJobs) || syncState.catalogRunning;
  const contestJobsPending = contestJobs.queued + contestJobs.running + contestJobs.failedRetryable;
  const hydrationLine = hydrationSummary(contestJobs);
  const status = statusHeading(options);
  const showMessage = latestSync?.message && (latestSync.status === "failed" || latestSync.status === "success");
  const syncDisabled = syncRunning || !cooldown.allowed;

  return (
    <section
      class={panelClassName(options)}
      aria-label="Codeforces sync"
      data-sync-panel
      data-sync-running={syncRunning ? "true" : "false"}
      data-sync-status={latestSync?.status ?? "none"}
      data-sync-cooldown={cooldown.allowed ? "false" : "true"}
      data-refresh-page={refreshPage}
      data-auto-sync-started={autoSyncStarted ? "true" : "false"}
      data-contest-jobs-done={contestJobs.done}
      data-contest-jobs-pending={contestJobsPending}
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
        <button type="submit" disabled={syncDisabled}>
          {syncRunning ? "Syncing…" : "Sync"}
        </button>
      </form>
    </section>
  );
};

export const syncPanelHtml = (options: SyncPanelOptions): string => render(<SyncPanel {...options} />);

export const syncPanelResponseHeaders = (
  options: Pick<SyncPanelOptions, "refreshPage" | "syncRunning" | "latestSync">,
): Record<string, string> => {
  if (options.refreshPage !== "contests") return {};
  if (options.syncRunning) return {};
  if (options.latestSync?.status !== "success") return {};
  return { "HX-Trigger": JSON.stringify({ refreshContestsTable: true }) };
};
