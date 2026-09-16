(function () {
  window.SkydiveCommands = window.SkydiveCommands || [];

  function normalizeInteger(value, fallback = 1) {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : fallback;
  }

  function parseInput(value) {
    const input = String(value || "").trim();
    if (!input) return { label: "Clicker", value: 1 };

    const parts = input.split(/\s+/);
    const last = parts[parts.length - 1];
    if (/^[+-]?\d+$/.test(last)) {
      const parsedValue = Number(last);
      if (Number.isSafeInteger(parsedValue)) {
        parts.pop();
        return {
          label: parts.join(" ") || "Clicker",
          value: parsedValue
        };
      }
    }

    return { label: input, value: 1 };
  }

  window.SkydiveCommands.push({
    id: "clicker",
    aliases: ["counter", "tally"],
    title: "Clicker",
    description: "Track an integer with plus and minus buttons.",
    acceptsArgs: true,

    createState(payload) {
      return parseInput(payload && payload.args);
    },

    getTitle(state) {
      return String(state && state.label || "Clicker").trim() || "Clicker";
    },

    getNumericValue(state) {
      return normalizeInteger(state && state.value);
    },

    render(container, state, updateState) {
      const label = String(state && state.label || "Clicker").trim() || "Clicker";
      const value = normalizeInteger(state && state.value);

      container.innerHTML = `
        <div class="clicker-card">
          <div class="clicker-title"></div>
          <div class="clicker-number" aria-live="polite"></div>
          <div class="clicker-actions">
            <button class="clicker-button" type="button" data-command-interactive data-delta="1" aria-label="Increase"></button>
            <button class="clicker-button" type="button" data-command-interactive data-delta="-1" aria-label="Decrease"></button>
          </div>
        </div>
      `;

      const style = document.createElement("style");
      style.textContent = `
        .clicker-card {
          display: grid;
          gap: 0.4em;
          min-width: 5.8em;
          padding: 0.58em;
          border: 0.04em solid var(--widget-border-color, #d6d6d6);
          border-radius: 0.62em;
          background: var(--widget-color, #ffffff);
          color: #2f2f2f;
          font-family: "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
          text-align: center;
        }

        .clicker-title {
          overflow: hidden;
          max-width: 12em;
          color: #615a53;
          font-size: 0.48em;
          line-height: 1.1;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .clicker-number {
          font-size: 1.12em;
          font-variant-numeric: tabular-nums;
          line-height: 1;
        }

        .clicker-actions {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 0.28em;
        }

        .clicker-card .clicker-button {
          min-width: 2.25em;
          min-height: 1.55em;
          padding: 0;
          border: 0;
          border-radius: var(--widget-button-radius, 999px);
          background: var(--widget-button-color, #ece7df);
          color: inherit;
          font: 400 0.82em/1 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
          cursor: pointer;
        }

        .clicker-card .clicker-button:hover {
          filter: brightness(0.97);
        }

        .clicker-card .clicker-button:active {
          transform: scale(0.96);
        }
      `;
      container.appendChild(style);

      container.querySelector(".clicker-title").textContent = label;
      container.querySelector(".clicker-number").textContent = String(value);
      const buttons = container.querySelectorAll(".clicker-button");
      buttons[0].textContent = "+";
      buttons[1].textContent = "−";

      buttons.forEach((button) => {
        button.addEventListener("click", () => {
          const delta = Number(button.dataset.delta) || 0;
          const nextValue = value + delta;
          if (!Number.isSafeInteger(nextValue)) return;
          updateState({ label, value: nextValue });
        });
      });
    }
  });
})();
