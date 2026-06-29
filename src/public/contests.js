(() => {
  const refreshTable = () => {
    if (!document.querySelector("#contests-table")) return;
    window.htmx.ajax("GET", `/contests/fragment${window.location.search}`, {
      target: "#contests-table",
      swap: "outerHTML",
    });
  };

  document.body.addEventListener("click", (event) => {
    const button = event.target.closest("[data-contest-show]");
    if (!(button instanceof HTMLButtonElement)) return;

    const show = button.dataset.contestShow;
    if (show !== "all" && show !== "upsolved" && show !== "participated" && show !== "rated") return;

    const url = new URL(window.location.href);
    url.searchParams.delete("page");
    if (show === "all") url.searchParams.delete("show");
    else url.searchParams.set("show", show);

    window.history.pushState({}, "", url);
    refreshTable();
  });

  window.addEventListener("popstate", () => {
    refreshTable();
  });
})();
