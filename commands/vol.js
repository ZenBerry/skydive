(function () {
  window.SkydiveCommands = window.SkydiveCommands || [];

  const MIN_VOLUME_DB = -60;
  const FIRST_AUDIBLE_SLIDER_STEP = 0.01;

  function clamp(value, minimum, maximum, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
  }

  function volumeToSliderPosition(value) {
    const volume = clamp(value, 0, 1, 1);
    if (volume === 0) return 0;
    const decibels = 20 * Math.log10(volume);
    const normalized = clamp((decibels - MIN_VOLUME_DB) / -MIN_VOLUME_DB, 0, 1, 1);
    return FIRST_AUDIBLE_SLIDER_STEP + normalized * (1 - FIRST_AUDIBLE_SLIDER_STEP);
  }

  function sliderPositionToVolume(value) {
    const position = clamp(value, 0, 1, 1);
    if (position === 0) return 0;
    const normalized = clamp(
      (position - FIRST_AUDIBLE_SLIDER_STEP) / (1 - FIRST_AUDIBLE_SLIDER_STEP),
      0,
      1,
      1
    );
    return Math.pow(10, (MIN_VOLUME_DB + normalized * -MIN_VOLUME_DB) / 20);
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
      const volumePosition = volumeToSliderPosition(volume);
      container.innerHTML = `
        <div class="vol-card">
          <label class="vol-control">
            <span>Vol</span>
            <input type="range" min="0" max="1" step="0.01" value="${volumePosition}" data-command-interactive aria-label="Volume">
            <output>${Math.round(volumePosition * 100)}%</output>
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
          grid-template-columns: 1.5em minmax(4.5em, 1fr) 1.8em;
          align-items: center;
          gap: 0.34em;
          font: 500 0.39em/1 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
        }
        .vol-control input {
          -webkit-appearance: none;
          appearance: none;
          width: 100%;
          height: 0.62em;
          margin: 0;
          background: transparent;
          font: inherit;
        }
        .vol-control input::-webkit-slider-runnable-track {
          width: 100%;
          height: 0.12em;
          border-radius: 999px;
          background: #d6d6d6;
        }
        .vol-control input::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 0.5em;
          height: 0.5em;
          margin-top: -0.19em;
          border: 0;
          border-radius: 50%;
          background: #40342b;
        }
        .vol-control input::-moz-range-track {
          width: 100%;
          height: 0.12em;
          border-radius: 999px;
          background: #d6d6d6;
        }
        .vol-control input::-moz-range-thumb {
          width: 0.5em;
          height: 0.5em;
          border: 0;
          border-radius: 50%;
          background: #40342b;
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
        const position = Number(inputs[0].value);
        volume = sliderPositionToVolume(position);
        outputs[0].textContent = `${Math.round(position * 100)}%`;
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
