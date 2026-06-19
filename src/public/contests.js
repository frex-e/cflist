(() => {
  const refreshTable = () => {
    if (!document.querySelector("#contests-table")) return;
    window.htmx.ajax("GET", `/contests/fragment${window.location.search}`, {
      target: "#contests-table",
      swap: "outerHTML",
    });
  };

  document.body.addEventListener("click", (event) => {
    const button = event.target.closest("[data-contest-filter]");
    if (!(button instanceof HTMLButtonElement)) return;

    const filter = button.dataset.contestFilter;
    const param = filter === "unrated" ? "hideUnrated" : filter === "upsolve" ? "hideUpsolve" : null;
    if (!param) return;

    const url = new URL(window.location.href);
    if (url.searchParams.get(param) === "1") url.searchParams.delete(param);
    else url.searchParams.set(param, "1");

    window.history.pushState({}, "", url);
    refreshTable();
  });
})();
