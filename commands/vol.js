(function () {
  window.SkydiveCommands = window.SkydiveCommands || [];

  function clamp(value, minimum, maximum, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
  }

  window.SkydiveCommands.push({
    id: "vol",
    aliases: ["volume", "pan"],
    title: "Volume & Pan",
    description: "Control volume and pan for audio widgets connected by incoming arrows.",

    createState() {
      return { volume: 1, pan: 0 };
    },

    render(container, state, updateState, context = {}) {
      let volume = clamp(state && state.volume, 0, 1, 1);
      let pan = clamp(state && state.pan, -1, 1, 0);
      container.innerHTML = `
        <div class="vol-card">
          <label class="vol-control">
            <span>Volume</span>
            <input type="range" min="0" max="1" step="0.01" value="${volume}" data-command-interactive aria-label="Volume">
            <output>${Math.round(volume * 100)}%</output>
          </label>
          <label class="vol-control">
            <span>Pan</span>
            <input type="range" min="-1" max="1" step="0.01" value="${pan}" data-command-interactive aria-label="Pan">
            <output>${pan === 0 ? "C" : `${Math.round(Math.abs(pan) * 100)}${pan < 0 ? "L" : "R"}`}</output>
          </label>
        </div>
      `;

      const style = document.createElement("style");
      style.textContent = `
        .vol-card {
          display: grid;
          gap: 0.48em;
          min-width: 8.8em;
          padding: 0.62em;
          border: 0.04em solid var(--widget-border-color, #ded2c2);
          border-radius: 0.58em;
          background: var(--widget-color, #fffaf3);
          color: #40342b;
          user-select: none;
        }
        .vol-control {
          display: grid;
          grid-template-columns: 2.5em minmax(4.5em, 1fr) 1.8em;
          align-items: center;
          gap: 0.34em;
          font: 500 0.39em/1 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
        }
        .vol-control input {
          width: 100%;
          margin: 0;
          accent-color: #40342b;
        }
        .vol-control output {
          color: #7b6a58;
          text-align: right;
          font-variant-numeric: tabular-nums;
        }
      `;
      container.appendChild(style);

      const inputs = container.querySelectorAll("input");
      const outputs = container.querySelectorAll("output");
      const preview = () => {
        if (typeof context.previewAudioVolume === "function") {
          context.previewAudioVolume({ volume, pan });
        }
      };

      inputs[0].addEventListener("input", () => {
        volume = Number(inputs[0].value);
        outputs[0].textContent = `${Math.round(volume * 100)}%`;
        preview();
      });
      inputs[1].addEventListener("input", () => {
        pan = Number(inputs[1].value);
        outputs[1].textContent = pan === 0 ? "C" : `${Math.round(Math.abs(pan) * 100)}${pan < 0 ? "L" : "R"}`;
        preview();
      });
      inputs.forEach((input) => input.addEventListener("change", () => {
        updateState({ ...state, volume, pan });
      }));
    }
  });
})();
