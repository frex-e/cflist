(() => {
  let lastSyncRunning = false;

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
  });

  const refreshAfterUserSync = (state) => {
    if (state.status !== "success" || state.running) return;

    const finishedViaTransition = lastSyncRunning && !state.running;
    const finishedViaAutoSync = state.autoSyncStarted;

    if (!finishedViaTransition && !finishedViaAutoSync) return;

    if (state.refreshPage === "problems") refreshProblems();
    if (state.refreshPage === "contests") refreshContests();
  };

  const handlePanel = (panel, { initial = false } = {}) => {
    const state = readPanel(panel);

    if (initial) {
      if (state.autoSyncStarted && state.status === "success" && !state.running) {
        refreshAfterUserSync(state);
      }
    } else {
      refreshAfterUserSync(state);
    }

    lastSyncRunning = state.running;
  };

  const initialPanel = document.querySelector("[data-sync-panel]");
  if (initialPanel instanceof HTMLElement) {
    lastSyncRunning = initialPanel.dataset.syncRunning === "true";
    handlePanel(initialPanel, { initial: true });
  }

  document.body.addEventListener("htmx:afterSwap", (event) => {
    const target = event.detail?.target;
    if (!(target instanceof HTMLElement) || !target.matches("[data-sync-panel]")) return;
    handlePanel(target);
  });
})();
