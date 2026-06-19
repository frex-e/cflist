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

      const saveDefault = target.closest("[data-filter-save-default]");
      const defaultForm = saveDefault?.closest("form");
      if (!defaultForm) return;

      event.preventDefault();
      event.stopPropagation();
      const status = defaultForm.querySelector("[data-filter-default-status]");
      const body = new URLSearchParams(new FormData(defaultForm));
      if (status) status.textContent = "Saving...";

      fetch("/preferences/default-filters", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      })
        .then((response) => {
          if (!response.ok) throw new Error("Could not save default filters");
          if (status) status.textContent = "Default saved";
        })
        .catch(() => {
          if (status) status.textContent = "Could not save";
        });
    },
    true,
  );
})();
