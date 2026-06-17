(function () {
  window.SkydiveCommands = window.SkydiveCommands || [];

  const SECOND_MS = 1000;
  const MINUTE_MS = 60 * SECOND_MS;
  const HOUR_MS = 60 * MINUTE_MS;
  const DAY_MS = 24 * HOUR_MS;
  const DEFAULT_DURATION_MS = HOUR_MS;
  const MAX_DURATION_MS = 365 * DAY_MS;
  const running = new WeakSet();

  const UNIT_MS = {
    s: SECOND_MS,
    sec: SECOND_MS,
    second: SECOND_MS,
    seconds: SECOND_MS,
    m: MINUTE_MS,
    min: MINUTE_MS,
    minute: MINUTE_MS,
    minutes: MINUTE_MS,
    h: HOUR_MS,
    hr: HOUR_MS,
    hour: HOUR_MS,
    hours: HOUR_MS,
    d: DAY_MS,
    day: DAY_MS,
    days: DAY_MS
  };

  function clampDuration(value) {
    const duration = Number(value);
    if (!Number.isFinite(duration) || duration < 0) return DEFAULT_DURATION_MS;
    return Math.min(Math.round(duration), MAX_DURATION_MS);
  }

  function parseDuration(input) {
    const text = String(input || "").trim().toLowerCase().replace(/,/g, " ");
    if (!text) return DEFAULT_DURATION_MS;
    if (text === "now") return 0;
    if (/^\d+(?:\.\d+)?$/.test(text)) return clampDuration(Number(text) * HOUR_MS);

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

  function formatDuration(ms) {
    const duration = Math.max(0, Number(ms) || 0);
    if (duration === 0) return "now";
    const days = Math.floor(duration / DAY_MS);
    const hours = Math.floor((duration % DAY_MS) / HOUR_MS);
    const minutes = Math.floor((duration % HOUR_MS) / MINUTE_MS);
    const parts = [];
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (minutes || parts.length === 0) parts.push(`${minutes}m`);
    return parts.join(" ");
  }

  function formatDate(timestamp) {
    const date = new Date(Number(timestamp) || Date.now());
    return date.toLocaleString([], {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    });
  }

  function getInitialState(context) {
    const input = typeof context.args === "string" ? context.args.trim() : "";
    const durationMs = parseDuration(input);
    return {
      status: "idle",
      input,
      durationMs,
      label: formatDuration(durationMs),
      createdAt: Date.now(),
      targetAt: null,
      targetSlug: "",
      targetUrl: "",
      sourceSlug: "",
      error: ""
    };
  }

  window.SkydiveCommands.push({
    id: "delorean",
    aliases: ["time", "timetravel", "restore"],
    acceptsArgs: true,
    title: "Delorean",
    description: "Open this space as it looked earlier.",

    createState: getInitialState,

    render(container, state, updateState, context = {}) {
      const status = typeof state.status === "string" ? state.status : "idle";
      const durationMs = clampDuration(state.durationMs);
      const label = state.label || formatDuration(durationMs);
      const targetUrl = typeof state.targetUrl === "string" ? state.targetUrl : "";

      container.innerHTML = `
        <div class="delorean-card" data-status="${status}">
          <div class="delorean-kicker">Delorean</div>
          <div class="delorean-title"></div>
          <div class="delorean-detail"></div>
          <div class="delorean-actions">
            <button class="delorean-button" type="button" data-command-interactive data-action="open">Open</button>
            <button class="delorean-button" type="button" data-command-interactive data-action="retry">Retry</button>
          </div>
        </div>
      `;

      const style = document.createElement("style");
      style.textContent = `
        .delorean-card {
          display: grid;
          gap: 0.36em;
          min-width: 7.6em;
          max-width: 11em;
          padding: 0.58em 0.64em 0.54em;
          border: 0.04em solid #ccd7dc;
          border-radius: 0.55em;
          background: #f7fbfb;
          box-shadow: 0 0.25em 0.9em rgba(34, 64, 73, 0.08);
          color: #233238;
        }

        .delorean-card[data-status="error"] {
          border-color: #efc9bd;
          background: #fff5f2;
        }

        .delorean-kicker {
          color: #60727a;
          font: 400 0.4em/1.1 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
          letter-spacing: 0;
          text-transform: uppercase;
        }

        .delorean-title {
          color: #223239;
          font: 400 0.72em/1.12 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
          letter-spacing: 0;
        }

        .delorean-detail {
          color: #60727a;
          font: 400 0.43em/1.22 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
          letter-spacing: 0;
          overflow-wrap: anywhere;
        }

        .delorean-actions {
          display: flex;
          gap: 0.25em;
        }

        .delorean-button {
          border: 0;
          border-radius: 0.38em;
          background: #dfeaec;
          padding: 0.26em 0.42em;
          color: #263940;
          font: 400 0.45em/1 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
        }

        .delorean-button:hover {
          background: #d2e0e3;
        }

        .delorean-button[hidden] {
          display: none;
        }
      `;
      container.appendChild(style);

      const card = container.querySelector(".delorean-card");
      const title = container.querySelector(".delorean-title");
      const detail = container.querySelector(".delorean-detail");
      const openButton = container.querySelector('[data-action="open"]');
      const retryButton = container.querySelector('[data-action="retry"]');

      if (status === "complete") {
        title.textContent = `${label} ago`;
        detail.textContent = `Ready at ${formatDate(state.targetAt)}.`;
        openButton.hidden = false;
        retryButton.hidden = true;
      } else if (status === "error") {
        title.textContent = "Could not time travel";
        detail.textContent = state.error || "Something interrupted the trip.";
        openButton.hidden = true;
        retryButton.hidden = false;
      } else {
        title.textContent = `${label} ago`;
        detail.textContent = "Preparing a separate editable space...";
        openButton.hidden = true;
        retryButton.hidden = true;
      }

      openButton.addEventListener("click", () => {
        if (state.targetSlug && context && typeof context.openSpace === "function") {
          context.openSpace(state.targetSlug);
          return;
        }
        if (targetUrl) window.location.assign(targetUrl);
      });

      retryButton.addEventListener("click", () => {
        updateState({
          ...state,
          status: "idle",
          error: ""
        });
      });

      if (status !== "idle" || running.has(container)) return;
      running.add(container);
      Promise.resolve()
        .then(() => {
          if (!context || typeof context.createDeloreanSpace !== "function") {
            throw new Error("Delorean is not available in this space.");
          }
          return context.createDeloreanSpace(durationMs);
        })
        .then((result) => {
          updateState({
            ...state,
            status: "complete",
            durationMs,
            label,
            targetAt: result.targetAt,
            targetSlug: result.targetSlug,
            targetUrl: result.targetUrl,
            sourceSlug: result.sourceSlug,
            error: ""
          });
        })
        .catch((error) => {
          updateState({
            ...state,
            status: "error",
            durationMs,
            label,
            error: error && error.message ? error.message : "Could not create the Delorean space."
          });
        })
        .finally(() => {
          running.delete(container);
        });
    }
  });
})();
