(function () {
  window.SkydiveCommands = window.SkydiveCommands || [];

  const SECOND_MS = 1000;
  const timers = new WeakMap();

  function getElapsedMs(state) {
    const savedElapsed = Number(state.elapsedMs) || 0;
    if (!state.running) return savedElapsed;
    const startedAt = Number(state.startedAt) || Date.now();
    return savedElapsed + Math.max(0, Date.now() - startedAt);
  }

  function formatElapsed(ms) {
    const totalSeconds = Math.floor(Math.max(0, ms) / SECOND_MS);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts = hours > 0
      ? [hours, minutes, seconds]
      : [minutes, seconds];

    return parts
      .map((part, index) => index === 0 ? String(part) : String(part).padStart(2, "0"))
      .join(":");
  }

  function clearTimer(container) {
    const timer = timers.get(container);
    if (timer) clearInterval(timer);
    timers.delete(container);
  }

  window.SkydiveCommands.push({
    id: "stw",
    aliases: ["stopwatch"],
    title: "Stopwatch",
    description: "A tiny persistent stopwatch.",

    createState() {
      return {
        running: true,
        startedAt: Date.now(),
        elapsedMs: 0
      };
    },

    destroy(container) {
      clearTimer(container);
    },

    render(container, state, updateState) {
      clearTimer(container);

      container.innerHTML = `
        <div class="stw-card">
          <div class="stw-time" aria-live="off">0:00</div>
          <div class="stw-actions">
            <button class="stw-button" type="button" data-command-interactive data-action="toggle"></button>
            <button class="stw-button" type="button" data-command-interactive data-action="reset">Reset</button>
          </div>
        </div>
      `;

      const style = document.createElement("style");
      style.textContent = `
        .stw-card {
          display: grid;
          gap: 0.38em;
          min-width: 5.9em;
          padding: 0.55em 0.62em 0.5em;
          border: 0.04em solid #e4d7c5;
          border-radius: 0.55em;
          background: #fff8ed;
          box-shadow: 0 0.25em 0.9em rgba(82, 59, 36, 0.08);
          color: #3f3328;
        }

        .stw-time {
          font: 400 1em/1.05 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
          letter-spacing: 0;
          tabular-nums: lining-nums;
          font-variant-numeric: tabular-nums;
        }

        .stw-actions {
          display: flex;
          gap: 0.25em;
        }

        .stw-button {
          border: 0;
          border-radius: 0.38em;
          background: #eee1cf;
          padding: 0.26em 0.42em;
          color: #4b3b2d;
          font: 400 0.45em/1 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
        }

        .stw-button:hover {
          background: #e7d6bf;
        }
      `;
      container.appendChild(style);

      const time = container.querySelector(".stw-time");
      const toggle = container.querySelector('[data-action="toggle"]');
      const reset = container.querySelector('[data-action="reset"]');

      function paint() {
        time.textContent = formatElapsed(getElapsedMs(state));
        toggle.textContent = state.running ? "Pause" : "Start";
      }

      toggle.addEventListener("click", () => {
        if (state.running) {
          updateState({
            running: false,
            startedAt: null,
            elapsedMs: getElapsedMs(state)
          });
          return;
        }

        updateState({
          running: true,
          startedAt: Date.now(),
          elapsedMs: Number(state.elapsedMs) || 0
        });
      });

      reset.addEventListener("click", () => {
        updateState({
          running: state.running,
          startedAt: state.running ? Date.now() : null,
          elapsedMs: 0
        });
      });

      paint();
      if (state.running) {
        timers.set(container, setInterval(paint, SECOND_MS));
      }
    }
  });
})();
