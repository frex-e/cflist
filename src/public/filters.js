(() => {
  const setupRatingFilter = (root) => {
    const min = Number(root.dataset.min);
    const max = Number(root.dataset.max);
    const minInput = root.querySelector("[data-rating-min]");
    const maxInput = root.querySelector("[data-rating-max]");
    const minHidden = root.querySelector("[data-rating-min-hidden]");
    const maxHidden = root.querySelector("[data-rating-max-hidden]");
    const minOutput = root.querySelector("[data-rating-min-output]");
    const maxOutput = root.querySelector("[data-rating-max-output]");

    if (!minInput || !maxInput || !minHidden || !maxHidden || !minOutput || !maxOutput) return;

    const sync = (changed) => {
      let minValue = Number(minInput.value);
      let maxValue = Number(maxInput.value);

      if (minValue > maxValue) {
        if (changed === "min") {
          maxValue = minValue;
          maxInput.value = String(maxValue);
        } else {
          minValue = maxValue;
          minInput.value = String(minValue);
        }
      }

      minOutput.value = minValue === min ? "Any" : String(minValue);
      maxOutput.value = maxValue === max ? "Any" : String(maxValue);

      minHidden.disabled = minValue === min;
      maxHidden.disabled = maxValue === max;
      minHidden.value = minValue === min ? "" : String(minValue);
      maxHidden.value = maxValue === max ? "" : String(maxValue);
    };

    minInput.addEventListener("input", () => sync("min"));
    maxInput.addEventListener("input", () => sync("max"));
    root.cflistSyncRatingFilter = () => sync();
    sync();
  };

  document.querySelectorAll("[data-rating-filter]").forEach(setupRatingFilter);

  const numberFormat = new Intl.NumberFormat("en");

  const fragmentUrlFor = (url) => {
    const fragmentUrl = new URL(url, window.location.origin);
    fragmentUrl.pathname = "/problems/fragment";
    return fragmentUrl;
  };

  const problemUrlFor = (url) => {
    const problemUrl = new URL(url, window.location.origin);
    problemUrl.pathname = "/problems";
    return problemUrl;
  };

  const parseFragment = (html) => {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return doc.querySelector("[data-problem-list]");
  };

  const updateSummary = (list) => {
    const summary = document.querySelector("[data-problem-summary]");
    if (summary && list.dataset.summary) {
      summary.textContent = list.dataset.summary;
    }
  };

  const countProblemRows = (list) => {
    return [...list.querySelectorAll("[data-problem-rows] > tr")].filter((row) => !row.querySelector(".empty"))
      .length;
  };

  const updateCumulativeLabel = (list) => {
    const label = list.querySelector("[data-page-label]");
    if (!label) return;

    const total = Number(list.dataset.total || "0");
    const page = Number(list.dataset.page || "1");
    const totalPages = Number(list.dataset.totalPages || "1");
    const shown = countProblemRows(list);

    if (total === 0) {
      label.textContent = `Page ${numberFormat.format(page)} of ${numberFormat.format(totalPages)}`;
      return;
    }

    label.textContent = `Page ${numberFormat.format(page)} of ${numberFormat.format(totalPages)} · Showing ${numberFormat.format(shown)} of ${numberFormat.format(total)}`;
  };

  let replaceController;
  let infiniteObserver;
  let loadingNextPage = false;

  const setListLoading = (loading) => {
    const list = document.querySelector("[data-problem-list]");
    if (!list) return;
    list.classList.toggle("is-loading", loading);
    list.setAttribute("aria-busy", loading ? "true" : "false");
  };

  const setupInfiniteScroll = () => {
    if (infiniteObserver) {
      infiniteObserver.disconnect();
      infiniteObserver = undefined;
    }

    const list = document.querySelector("[data-problem-list]");
    const sentinel = list?.querySelector("[data-load-more]");
    if (!("IntersectionObserver" in window)) return;
    if (!list || !sentinel || !list.dataset.nextUrl) return;

    infiniteObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadNextPage(list);
        }
      },
      { rootMargin: "600px 0px" },
    );
    infiniteObserver.observe(sentinel);
  };

  const replaceProblemList = async (url, { updateHistory = true } = {}) => {
    if (replaceController) replaceController.abort();
    const controller = new AbortController();
    replaceController = controller;
    setListLoading(true);

    try {
      const response = await fetch(fragmentUrlFor(url), {
        headers: { accept: "text/html" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(await response.text());

      const nextList = parseFragment(await response.text());
      const currentList = document.querySelector("[data-problem-list]");
      if (!nextList || !currentList) throw new Error("Problem list fragment missing");

      currentList.replaceWith(nextList);
      updateSummary(nextList);
      setupInfiniteScroll();

      if (updateHistory) {
        window.history.replaceState({}, "", problemUrlFor(url));
      }
    } catch (error) {
      if (error.name !== "AbortError") {
        console.error(error);
        window.location.assign(problemUrlFor(url));
      }
    } finally {
      if (replaceController === controller) {
        replaceController = undefined;
        setListLoading(false);
      }
    }
  };

  const loadNextPage = async (list) => {
    if (loadingNextPage || !list.dataset.nextUrl) return;
    loadingNextPage = true;

    const sentinel = list.querySelector("[data-load-more]");
    if (sentinel) sentinel.hidden = false;

    try {
      const response = await fetch(fragmentUrlFor(list.dataset.nextUrl), {
        headers: { accept: "text/html" },
      });
      if (!response.ok) throw new Error(await response.text());

      if (document.querySelector("[data-problem-list]") !== list) return;

      const nextList = parseFragment(await response.text());
      const currentRows = list.querySelector("[data-problem-rows]");
      const nextRows = nextList?.querySelector("[data-problem-rows]");
      if (!nextList || !currentRows || !nextRows) throw new Error("Problem list fragment missing");

      for (const row of nextRows.querySelectorAll("tr")) {
        if (!row.querySelector(".empty")) currentRows.append(row);
      }

      list.dataset.page = nextList.dataset.page || list.dataset.page || "1";
      list.dataset.totalPages = nextList.dataset.totalPages || list.dataset.totalPages || "1";
      list.dataset.total = nextList.dataset.total || list.dataset.total || "0";
      list.dataset.solved = nextList.dataset.solved || list.dataset.solved || "0";
      list.dataset.unsolved = nextList.dataset.unsolved || list.dataset.unsolved || "0";

      if (nextList.dataset.nextUrl) {
        list.dataset.nextUrl = nextList.dataset.nextUrl;
      } else {
        delete list.dataset.nextUrl;
      }

      const currentPager = list.querySelector(".pager");
      const nextPager = nextList.querySelector(".pager");
      if (currentPager && nextPager) currentPager.replaceWith(nextPager);

      updateSummary(list);
      updateCumulativeLabel(list);

      if (!list.dataset.nextUrl && infiniteObserver) {
        infiniteObserver.disconnect();
        infiniteObserver = undefined;
      }
    } catch (error) {
      console.error(error);
    } finally {
      if (sentinel) sentinel.hidden = !list.dataset.nextUrl;
      loadingNextPage = false;
    }
  };

  const setupDynamicFilters = () => {
    const form = document.querySelector("form.filters");
    if (!form || !document.querySelector("[data-problem-list]")) return;

    const resetFormControls = () => {
      form.querySelectorAll('input[type="search"]').forEach((input) => {
        input.value = "";
      });
      form.querySelectorAll('input[type="checkbox"]').forEach((input) => {
        input.checked = false;
      });
      form.querySelectorAll("select").forEach((select) => {
        if (select.name === "solved") select.value = "all";
        else if (select.name === "sort") select.value = "contest";
        else if (select.name === "tagMode") select.value = "all";
        else if (select.name === "pageSize") select.value = "50";
        else select.value = "";
      });
      form.querySelectorAll("[data-rating-filter]").forEach((root) => {
        const minInput = root.querySelector("[data-rating-min]");
        const maxInput = root.querySelector("[data-rating-max]");
        const minHidden = root.querySelector("[data-rating-min-hidden]");
        const maxHidden = root.querySelector("[data-rating-max-hidden]");
        if (minInput) minInput.value = root.dataset.min || minInput.min;
        if (maxInput) maxInput.value = root.dataset.max || maxInput.max;
        if (minHidden) minHidden.value = "";
        if (maxHidden) maxHidden.value = "";
        if (typeof root.cflistSyncRatingFilter === "function") root.cflistSyncRatingFilter();
      });
    };

    const buildUrl = () => {
      const url = new URL(form.action, window.location.origin);
      const params = new URLSearchParams();
      for (const [key, value] of new FormData(form)) {
        if (typeof value !== "string" || value === "") continue;
        if (key === "solved" && value === "all") continue;
        if (key === "sort" && value === "contest") continue;
        if (key === "tagMode" && value === "all") continue;
        if (key === "pageSize" && value === "50") continue;
        params.append(key, value);
      }
      url.search = params.toString();
      return url;
    };

    const scheduleFetch = (() => {
      let timeout;
      return (delay) => {
        window.clearTimeout(timeout);
        timeout = window.setTimeout(() => {
          void replaceProblemList(buildUrl());
        }, delay);
      };
    })();

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void replaceProblemList(buildUrl());
    });

    form.addEventListener("input", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (target.matches('input[type="search"]')) scheduleFetch(250);
      if (target.matches('input[type="range"]')) scheduleFetch(150);
    });

    form.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
      if (target.matches('input[type="range"], input[type="search"]')) return;
      scheduleFetch(0);
    });

    form.querySelector('a[href="/problems"]')?.addEventListener("click", (event) => {
      event.preventDefault();
      resetFormControls();
      void replaceProblemList(new URL("/problems", window.location.origin));
    });

    setupInfiniteScroll();
  };

  const renderStatusForm = ({ action, returnTo, solved }) => {
    const escapeAttr = (value) =>
      String(value)
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
    const safeAction = escapeAttr(action);
    const safeReturnTo = escapeAttr(returnTo);

    if (solved) {
      return `
        <form class="status-form" data-status-form method="post" action="${safeAction}">
          <input type="hidden" name="solvedOverride" value="">
          <input type="hidden" name="returnTo" value="${safeReturnTo}">
          <button class="status status-button solved manual-solved" type="submit" title="Undo manual solved mark">✓</button>
        </form>
      `;
    }

    return `
      <form class="status-form" data-status-form method="post" action="${safeAction}">
        <input type="hidden" name="solvedOverride" value="1">
        <input type="hidden" name="returnTo" value="${safeReturnTo}">
        <button class="status status-button unsolved" type="submit" title="Mark solved"></button>
      </form>
    `;
  };

  const setupStatusForms = () => {
    document.addEventListener("submit", async (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement) || !form.matches("[data-status-form]")) return;

      event.preventDefault();
      const row = form.closest("[data-problem-row]");
      const cell = form.closest("[data-status-cell]");
      const button = form.querySelector("button");
      if (!row || !cell || !button) {
        form.submit();
        return;
      }

      button.disabled = true;

      try {
        const response = await fetch(form.action, {
          method: "POST",
          body: new FormData(form),
          headers: {
            accept: "application/json",
          },
        });

        if (!response.ok) throw new Error(await response.text());

        const payload = await response.json();
        const solved = Boolean(payload.effectiveSolved);
        row.classList.toggle("solved-row", solved);
        cell.innerHTML = renderStatusForm({
          action: form.getAttribute("action") || form.action,
          returnTo: form.querySelector('input[name="returnTo"]')?.value || window.location.pathname + window.location.search,
          solved,
        });
      } catch (error) {
        console.error(error);
        form.submit();
      }
    });
  };

  setupStatusForms();
  setupDynamicFilters();
})();
