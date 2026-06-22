(() => {
  let lastSyncRunning = false;
  let lastContestJobsDone = null;
  let lastContestJobsPending = null;
  let userSyncRequested = false;

  const refreshProblems = () => {
    if (!document.querySelector("#problem-list")) return;
    const fragmentUrl = `/problems/fragment${window.location.search}`;
    window.htmx.ajax("GET", fragmentUrl, {
      target: "#problem-list",
      swap: "outerHTML",
    });
  };

  const refreshContests = () => {
    if (!document.querySelector("#contests-table")) return;
    window.htmx.ajax("GET", `/contests/fragment${window.location.search}`, {
      target: "#contests-table",
      swap: "outerHTML",
    });
  };

  const readPanel = (panel) => ({
    running: panel.dataset.syncRunning === "true",
    status: panel.dataset.syncStatus ?? "none",
    refreshPage: panel.dataset.refreshPage ?? "problems",
    polling: panel.hasAttribute("hx-get"),
    autoSyncStarted: panel.dataset.autoSyncStarted === "true",
    contestJobsDone: Number(panel.dataset.contestJobsDone ?? 0),
    contestJobsPending: Number(panel.dataset.contestJobsPending ?? 0),
  });

  const refreshAfterUserSync = (state, { initial = false } = {}) => {
    if (state.status !== "success" || state.running) return;

    const shouldRefresh =
      userSyncRequested
      || state.autoSyncStarted
      || (lastSyncRunning && !state.running)
      || (state.refreshPage === "contests" && !initial);

    if (!shouldRefresh) return;

    if (state.refreshPage === "problems") refreshProblems();
    if (state.refreshPage === "contests") refreshContests();

    userSyncRequested = false;
  };

  const refreshAfterHydration = (state) => {
    if (state.refreshPage !== "contests") return;

    const { contestJobsDone, contestJobsPending } = state;

    if (lastContestJobsDone !== null && lastContestJobsPending !== null) {
      const doneIncreased = contestJobsDone > lastContestJobsDone;
      const pendingDrained = lastContestJobsPending > 0 && contestJobsPending === 0;
      const pendingIncreased = contestJobsPending > lastContestJobsPending;

      if (doneIncreased || pendingDrained || pendingIncreased) {
        refreshContests();
      }
    }

    lastContestJobsDone = contestJobsDone;
    lastContestJobsPending = contestJobsPending;
  };

  const handlePanel = (panel, { initial = false } = {}) => {
    const state = readPanel(panel);

    if (initial) {
      if (state.autoSyncStarted && state.status === "success" && !state.running) {
        refreshAfterUserSync(state, { initial: true });
      }
    } else {
      refreshAfterUserSync(state, { initial: false });
    }

    refreshAfterHydration(state);
    lastSyncRunning = state.running;
  };

  document.body.addEventListener("refreshContestsTable", () => {
    refreshContests();
  });

  document.body.addEventListener("htmx:beforeRequest", (event) => {
    const elt = event.detail?.elt;
    if (!(elt instanceof HTMLElement)) return;
    if (!elt.closest('form[action="/admin/sync"]')) return;
    userSyncRequested = true;
  });

  const initialPanel = document.querySelector("[data-sync-panel]");
  if (initialPanel instanceof HTMLElement) {
    lastSyncRunning = initialPanel.dataset.syncRunning === "true";
    lastContestJobsDone = Number(initialPanel.dataset.contestJobsDone ?? 0);
    lastContestJobsPending = Number(initialPanel.dataset.contestJobsPending ?? 0);
    handlePanel(initialPanel, { initial: true });
  }

  const onPanelSwap = (event) => {
    const target = event.detail?.target;
    if (!(target instanceof HTMLElement) || !target.matches("[data-sync-panel]")) return;
    handlePanel(target);
  };

  document.body.addEventListener("htmx:afterSwap", onPanelSwap);
  document.body.addEventListener("htmx:afterSettle", onPanelSwap);
})();
