(function () {
  window.SkydiveCommands = window.SkydiveCommands || [];

  const cache = new WeakMap();

  function normalizeNeedle(value) {
    return String(value || "").trim();
  }

  function countOccurrences(text, needle) {
    if (!needle) return 0;
    let count = 0;
    let index = 0;
    while (index <= text.length) {
      const nextIndex = text.indexOf(needle, index);
      if (nextIndex === -1) break;
      count += 1;
      index = nextIndex + needle.length;
    }
    return count;
  }

  function paint(container, state, context) {
    const previous = cache.get(container);
    const currentState = state || previous && previous.state || {};
    const needle = normalizeNeedle(currentState && currentState.input);
    const version = Number(
      context && typeof context.getSpaceTextVersion === "function"
        ? context.getSpaceTextVersion()
        : context && context.spaceTextVersion
    ) || 0;
    if (previous && previous.needle === needle && previous.version === version) return;

    const getSpaceText = context && typeof context.getSpaceText === "function"
      ? context.getSpaceText
      : () => "";
    const count = countOccurrences(String(getSpaceText() || ""), needle);
    const label = container.querySelector(".count-label");
    const number = container.querySelector(".count-number");
    if (label) label.textContent = needle || "count";
    if (number) number.textContent = String(count);
    cache.set(container, { state: currentState, needle, version, count });
  }

  window.SkydiveCommands.push({
    id: "count",
    aliases: ["occurrences", "matches"],
    title: "Count",
    description: "Count literal text occurrences in this space.",
    acceptsArgs: true,

    createState(payload) {
      return {
        input: normalizeNeedle(payload && payload.args)
      };
    },

    getTitle(state) {
      const needle = normalizeNeedle(state && state.input);
      return needle ? `${needle}: count` : "Count";
    },

    render(container, state, updateState, context) {
      container.innerHTML = `
        <div class="count-card" aria-live="polite">
          <span class="count-label"></span><span class="count-separator">:</span>
          <span class="count-number">0</span>
        </div>
      `;

      const style = document.createElement("style");
      style.textContent = `
        .count-card {
          display: inline-flex;
          align-items: baseline;
          gap: 0.18em;
          min-width: 3.2em;
          max-width: 18em;
          padding: 0.46em 0.62em 0.42em;
          border: 0.04em solid var(--widget-border-color, #d6d6d6);
          border-radius: 0.55em;
          background: var(--widget-color, #ffffff);
          color: #2f2f2f;
          font: 400 0.82em/1.1 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
          white-space: nowrap;
        }

        .count-label {
          overflow: hidden;
          max-width: 14em;
          text-overflow: ellipsis;
        }

        .count-number {
          font-variant-numeric: tabular-nums;
        }
      `;
      container.appendChild(style);
      paint(container, state, context);
    },

    renderFrame(container, context) {
      paint(container, null, context);
    },

    destroy(container) {
      cache.delete(container);
    }
  });
})();
