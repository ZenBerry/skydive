(function () {
  window.SkydiveCommands = window.SkydiveCommands || [];

  const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const LABELS = ["31", "62", "125", "250", "500", "1k", "2k", "4k", "8k", "16k"];

  function normalizeGains(value) {
    const gains = Array.isArray(value) ? value : [];
    return BANDS.map((frequency, index) => Math.max(-12, Math.min(12, Number(gains[index]) || 0)));
  }

  window.SkydiveCommands.push({
    id: "eq",
    aliases: ["equalizer", "equaliser"],
    title: "Equalizer",
    description: "Shape audio from widgets connected by incoming arrows.",

    createState() {
      return { enabled: false, gains: BANDS.map(() => 0) };
    },

    render(container, state, updateState, context = {}) {
      const enabled = !state || state.enabled !== false;
      const gains = normalizeGains(state && state.gains);
      container.innerHTML = `
        <div class="eq-card" data-enabled="${enabled ? "true" : "false"}">
          <div class="eq-bands"></div>
          <button class="eq-toggle" type="button" data-command-interactive aria-pressed="${enabled ? "true" : "false"}">${enabled ? "Turn off" : "Turn on"}</button>
        </div>
      `;

      const style = document.createElement("style");
      style.textContent = `
        .eq-card {
          display: grid;
          gap: 0.42em;
          min-width: 8.8em;
          padding: 0.58em 0.62em 0.54em;
          border: 0.04em solid var(--widget-border-color, #ded2c2);
          border-radius: 0.58em;
          background: var(--widget-color, #fffaf3);
          color: #40342b;
          user-select: none;
        }
        .eq-bands {
          display: grid;
          grid-template-columns: repeat(10, minmax(0, 1fr));
          gap: 0.12em;
          opacity: 1;
          transition: opacity 120ms ease;
        }
        .eq-card[data-enabled="false"] .eq-bands { opacity: 0.34; }
        .eq-band {
          display: grid;
          justify-items: center;
          gap: 0.12em;
          min-width: 0;
        }
        .eq-slider-slot {
          position: relative;
          width: 0.62em;
          height: 3.8em;
        }
        .eq-band input {
          -webkit-appearance: none;
          appearance: none;
          width: 100%;
          height: 100%;
          margin: 0;
          background: transparent;
          font: inherit;
          writing-mode: vertical-lr;
          direction: rtl;
        }
        .eq-band input::-webkit-slider-runnable-track {
          width: 0.12em;
          height: 100%;
          border-radius: 999px;
          background: #d6d6d6;
        }
        .eq-band input::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 0.5em;
          height: 0.5em;
          margin-left: -0.19em;
          border: 0;
          border-radius: 50%;
          background: #40342b;
        }
        .eq-band input::-moz-range-track {
          width: 0.12em;
          height: 100%;
          border-radius: 999px;
          background: #d6d6d6;
        }
        .eq-band input::-moz-range-thumb {
          width: 0.5em;
          height: 0.5em;
          border: 0;
          border-radius: 50%;
          background: #40342b;
        }
        .eq-band-label {
          color: #7b6a58;
          font: 500 0.3em/1 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
          white-space: nowrap;
        }
        .eq-toggle {
          border: 0;
          border-radius: 0.38em;
          background: var(--widget-button-color, #e7dac9);
          padding: 0.34em 0.48em;
          color: var(--skydive-text, #111);
          font: 500 0.39em/1 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
        }
        .eq-toggle:hover { background: var(--widget-button-hover-color, #ddcbb5); }
        .eq-toggle[aria-pressed="true"] { color: var(--skydive-text, #111); }
      `;
      container.appendChild(style);

      const bands = container.querySelector(".eq-bands");
      BANDS.forEach((frequency, index) => {
        const band = document.createElement("label");
        band.className = "eq-band";
        band.innerHTML = `
          <span class="eq-slider-slot"><input type="range" min="-12" max="12" step="1" value="${gains[index]}" data-command-interactive aria-label="${frequency} Hz"></span>
          <span class="eq-band-label">${LABELS[index]}</span>
        `;
        const input = band.querySelector("input");
        input.addEventListener("input", () => {
          gains[index] = Number(input.value);
          if (typeof context.previewAudioEqualizer === "function") {
            context.previewAudioEqualizer({ enabled, gains });
          }
        });
        input.addEventListener("change", () => updateState({ ...state, enabled, gains: gains.slice() }));
        bands.appendChild(band);
      });

      container.querySelector(".eq-toggle").addEventListener("click", () => {
        updateState({ ...state, enabled: !enabled, gains: gains.slice() });
      });
    }
  });
})();
