(function () {
  window.SkydiveCommands = window.SkydiveCommands || [];

  const BELL_URL = "https://res.cloudinary.com/zenberry/video/upload/v1671170195/other%20audio/UI/415510__inspectorj__bell-counter-a_qianey.wav";
  const SECOND_MS = 1000;
  const MINUTE_MS = 60 * SECOND_MS;
  const HOUR_MS = 60 * MINUTE_MS;
  const DEFAULT_DURATION_MS = 30 * MINUTE_MS;
  const MAX_DURATION_MS = 7 * 24 * HOUR_MS;
  const timers = new WeakMap();

  const UNIT_MS = {
    ms: 1,
    millisecond: 1,
    milliseconds: 1,
    s: SECOND_MS,
    sec: SECOND_MS,
    secs: SECOND_MS,
    second: SECOND_MS,
    seconds: SECOND_MS,
    m: MINUTE_MS,
    min: MINUTE_MS,
    mins: MINUTE_MS,
    minute: MINUTE_MS,
    minutes: MINUTE_MS,
    h: HOUR_MS,
    hr: HOUR_MS,
    hrs: HOUR_MS,
    hour: HOUR_MS,
    hours: HOUR_MS,
    d: 24 * HOUR_MS,
    day: 24 * HOUR_MS,
    days: 24 * HOUR_MS
  };

  function clampDuration(ms) {
    const duration = Number(ms);
    if (!Number.isFinite(duration) || duration <= 0) return DEFAULT_DURATION_MS;
    return Math.min(Math.round(duration), MAX_DURATION_MS);
  }

  function parseColonDuration(text) {
    const compact = text.replace(/\s+/g, "");
    const match = /^(\d+):([0-5]?\d)(?::([0-5]?\d))?$/.exec(compact);
    if (!match) return null;

    const first = Number(match[1]);
    const second = Number(match[2]);
    const third = match[3] === undefined ? null : Number(match[3]);
    return third === null
      ? (first * MINUTE_MS) + (second * SECOND_MS)
      : (first * HOUR_MS) + (second * MINUTE_MS) + (third * SECOND_MS);
  }

  function parseDuration(input) {
    const text = String(input || "").trim().toLowerCase().replace(/,/g, " ");
    if (!text) return DEFAULT_DURATION_MS;

    const colonDuration = parseColonDuration(text);
    if (colonDuration !== null) return clampDuration(colonDuration);

    if (/^\d+(?:\.\d+)?$/.test(text)) {
      return clampDuration(Number(text) * MINUTE_MS);
    }

    let total = 0;
    let matched = false;
    const matcher = /(\d+(?:\.\d+)?)\s*([a-z]+)/g;
    let match = matcher.exec(text);

    while (match) {
      const amount = Number(match[1]);
      const unitMs = UNIT_MS[match[2]];
      if (Number.isFinite(amount) && unitMs) {
        total += amount * unitMs;
        matched = true;
      }
      match = matcher.exec(text);
    }

    return matched ? clampDuration(total) : DEFAULT_DURATION_MS;
  }

  function getDurationMs(state) {
    return clampDuration(state.durationMs);
  }

  function getRemainingMs(state) {
    if (state.completed) return 0;

    const savedRemaining = Number.isFinite(Number(state.remainingMs))
      ? Number(state.remainingMs)
      : getDurationMs(state);

    if (!state.running) return Math.max(0, savedRemaining);

    const startedAt = Number(state.startedAt) || Date.now();
    return Math.max(0, savedRemaining - Math.max(0, Date.now() - startedAt));
  }

  function formatRemaining(ms) {
    const totalSeconds = Math.ceil(Math.max(0, ms) / SECOND_MS);
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

  function formatDurationLabel(ms) {
    const totalSeconds = Math.round(Math.max(0, ms) / SECOND_MS);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts = [];

    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    if (seconds || parts.length === 0) parts.push(`${seconds}s`);
    return parts.join(" ");
  }

  function playBell() {
    const audio = new Audio(BELL_URL);
    audio.preload = "auto";
    const playPromise = audio.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(() => {});
    }
  }

  function clearTimer(container) {
    const timer = timers.get(container);
    if (timer) clearInterval(timer);
    timers.delete(container);
  }

  window.SkydiveCommands.push({
    id: "timer",
    aliases: ["countdown", "alarm"],
    acceptsArgs: true,
    title: "Timer",
    description: "A tiny persistent countdown timer.",

    createState(context = {}) {
      const input = typeof context.args === "string" ? context.args.trim() : "";
      const durationMs = parseDuration(input);
      return {
        durationMs,
        remainingMs: durationMs,
        running: true,
        startedAt: Date.now(),
        completed: false,
        completedAt: null,
        alarmed: false,
        input
      };
    },

    destroy(container) {
      clearTimer(container);
    },

    render(container, state, updateState) {
      clearTimer(container);

      container.innerHTML = `
        <div class="timer-card">
          <div class="timer-label"></div>
          <div class="timer-time" aria-live="polite">0:00</div>
          <div class="timer-actions">
            <button class="timer-button" type="button" data-command-interactive data-action="toggle"></button>
            <button class="timer-button" type="button" data-command-interactive data-action="reset">Reset</button>
          </div>
        </div>
      `;

      const style = document.createElement("style");
      style.textContent = `
        .timer-card {
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

        .timer-card[data-complete="true"] {
          border-color: #d7e2c7;
          background: #fbfff5;
        }

        .timer-label {
          overflow: hidden;
          color: #7b6650;
          font: 400 0.42em/1.1 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
          letter-spacing: 0;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .timer-time {
          font: 400 1em/1.05 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
          letter-spacing: 0;
          tabular-nums: lining-nums;
          font-variant-numeric: tabular-nums;
        }

        .timer-actions {
          display: flex;
          gap: 0.25em;
        }

        .timer-button {
          border: 0;
          border-radius: 0.38em;
          background: #eee1cf;
          padding: 0.26em 0.42em;
          color: #4b3b2d;
          font: 400 0.45em/1 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
        }

        .timer-button:hover {
          background: #e7d6bf;
        }
      `;
      container.appendChild(style);

      const card = container.querySelector(".timer-card");
      const label = container.querySelector(".timer-label");
      const time = container.querySelector(".timer-time");
      const toggle = container.querySelector('[data-action="toggle"]');
      const reset = container.querySelector('[data-action="reset"]');
      const durationMs = getDurationMs(state);

      function completeTimer() {
        playBell();
        updateState({
          ...state,
          running: false,
          startedAt: null,
          remainingMs: 0,
          completed: true,
          completedAt: Date.now(),
          alarmed: true
        });
      }

      function paint() {
        const remainingMs = getRemainingMs(state);
        const completed = remainingMs <= 0 || Boolean(state.completed);
        card.dataset.complete = completed ? "true" : "false";
        label.textContent = completed ? "Done" : formatDurationLabel(durationMs);
        time.textContent = formatRemaining(remainingMs);
        toggle.textContent = state.running ? "Pause" : "Start";

        if (state.running && remainingMs <= 0) {
          completeTimer();
        }
      }

      toggle.addEventListener("click", () => {
        if (state.running) {
          updateState({
            ...state,
            running: false,
            startedAt: null,
            remainingMs: getRemainingMs(state),
            completed: false
          });
          return;
        }

        const remainingMs = state.completed ? durationMs : getRemainingMs(state);
        updateState({
          ...state,
          running: true,
          startedAt: Date.now(),
          remainingMs: remainingMs > 0 ? remainingMs : durationMs,
          completed: false,
          completedAt: null,
          alarmed: false
        });
      });

      reset.addEventListener("click", () => {
        updateState({
          ...state,
          running: state.running,
          startedAt: state.running ? Date.now() : null,
          remainingMs: durationMs,
          completed: false,
          completedAt: null,
          alarmed: false
        });
      });

      paint();
      if (state.running && getRemainingMs(state) > 0) {
        timers.set(container, setInterval(paint, SECOND_MS));
      }
    }
  });
})();
