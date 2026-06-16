(() => {
  document.documentElement.classList.add("js");

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

    const dispatchFilterChange = () => {
      const event = new Event("change", { bubbles: true });
      if (!minHidden.disabled) minHidden.dispatchEvent(event);
      else if (!maxHidden.disabled) maxHidden.dispatchEvent(event);
      else root.closest("form")?.dispatchEvent(event);
    };

    const sync = (changed, notify = false) => {
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

      if (notify) dispatchFilterChange();
    };

    minInput.addEventListener("input", () => sync("min", true));
    maxInput.addEventListener("input", () => sync("max", true));
    root.cflistSyncRatingFilter = () => sync();

    root.closest("form")?.addEventListener("reset", () => {
      window.requestAnimationFrame(() => sync());
    });

    sync();
  };

  const resetFilterForm = (form) => {
    form.querySelectorAll('input[type="search"]').forEach((input) => {
      input.value = "";
    });
    form.querySelectorAll('input[type="checkbox"]').forEach((input) => {
      input.checked = false;
    });
    form.querySelectorAll("select").forEach((select) => {
      if (select.name === "solved") select.value = "all";
      else if (select.name === "sort") select.value = "contest";
      else if (select.name === "sortDirection") select.value = "desc";
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

  const setupDirectionToggle = (toggle) => {
    const label = toggle.closest(".direction-toggle")?.querySelector("span");
    if (!label) return;

    const sync = () => {
      label.textContent = toggle.checked ? "Ascending" : "Descending";
    };

    toggle.addEventListener("change", sync);
    toggle.closest("form")?.addEventListener("reset", () => {
      window.requestAnimationFrame(sync);
    });
    sync();
  };

  document.querySelectorAll("[data-rating-filter]").forEach(setupRatingFilter);
  document.querySelectorAll('.direction-toggle input[name="sortDirection"]').forEach(setupDirectionToggle);

  document.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const reset = target.closest("[data-filter-reset]");
      const form = reset?.closest("form");
      if (form) resetFilterForm(form);
    },
    true,
  );
})();
