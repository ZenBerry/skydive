(function () {
  window.SkydiveCommands = window.SkydiveCommands || [];

  const running = new WeakSet();

  function normalizeName(value) {
    return String(value || "").normalize("NFKC").trim();
  }

  function getInitialState(context = {}) {
    return {
      status: "idle",
      name: normalizeName(context.args),
      targetSlug: "",
      targetUrl: "",
      error: ""
    };
  }

  window.SkydiveCommands.push({
    id: "space",
    aliases: ["new-space"],
    acceptsArgs: true,
    title: "Space",
    description: "Create a child space link.",

    isAvailable(context = {}) {
      return Boolean(context.currentUser && context.canCreateChildSpace);
    },

    createState: getInitialState,

    getTitle(state) {
      const name = normalizeName(state && state.name);
      return name ? `Space: ${name}` : "Space";
    },

    render(container, state, updateState, context = {}) {
      const current = state && typeof state === "object" ? state : getInitialState();
      const name = normalizeName(current.name);
      const status = typeof current.status === "string" ? current.status : "idle";

      container.innerHTML = `
        <div class="space-card" data-status="${status}">
          <div class="space-title"></div>
          <div class="space-detail"></div>
          <div class="space-actions">
            <button class="space-button" type="button" data-command-interactive data-action="retry">Retry</button>
          </div>
        </div>
      `;

      const style = document.createElement("style");
      style.textContent = `
        .space-card {
          display: grid;
          gap: 0.36em;
          min-width: 7.2em;
          max-width: 14em;
          padding: 0.55em 0.62em 0.5em;
          border: 0.04em solid var(--widget-border-color, #d6d6d6);
          border-radius: 0.55em;
          background: var(--widget-color, #ffffff);
          color: #2f2f2f;
        }

        .space-card[data-status="error"] {
          border-color: #efc9bd;
          background: #fff5f2;
        }

        .space-title {
          font: 400 0.76em/1.12 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
          letter-spacing: 0;
          overflow-wrap: anywhere;
        }

        .space-detail {
          color: #656565;
          font: 400 0.43em/1.22 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
          letter-spacing: 0;
          overflow-wrap: anywhere;
        }

        .space-actions {
          display: flex;
          gap: 0.25em;
        }

        .space-button {
          border: 0;
          border-radius: 999px;
          background: var(--widget-button-color, hsl(0 0% 91% / 44%));
          padding: 0.26em 0.42em;
          color: #2f2f2f;
          font: 400 0.45em/1 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
        }

        .space-button:hover {
          background: var(--widget-button-hover-color, hsl(0 0% 94% / 44%));
        }
      `;
      container.appendChild(style);

      const title = container.querySelector(".space-title");
      const detail = container.querySelector(".space-detail");
      const retryButton = container.querySelector('[data-action="retry"]');
      if (title) title.textContent = name || "New space";
      if (detail) {
        detail.textContent = status === "error"
          ? current.error || "Could not create this space."
          : "Creating child space...";
      }
      if (retryButton) {
        retryButton.hidden = status !== "error";
        retryButton.addEventListener("click", () => {
          updateState({ ...current, status: "idle", error: "" });
        });
      }

      if (status !== "idle" || running.has(container)) return;
      running.add(container);
      Promise.resolve()
        .then(() => {
          if (!name) throw new Error("Add a space name after /space.");
          if (/[\\/]/.test(name)) throw new Error("Space names cannot include slashes.");
          if (!context || typeof context.createChildSpace !== "function") {
            throw new Error("Space creation is not available here.");
          }
          return context.createChildSpace(name);
        })
        .then((result) => {
          if (context && typeof context.replaceCommandNodeWithExternalLink === "function") {
            context.replaceCommandNodeWithExternalLink(result.targetUrl, result.label || name);
            return;
          }
          updateState({
            ...current,
            status: "complete",
            targetSlug: result.targetSlug,
            targetUrl: result.targetUrl,
            error: ""
          });
        })
        .catch((error) => {
          updateState({
            ...current,
            status: "error",
            error: error && error.message ? error.message : "Could not create this space."
          });
        })
        .finally(() => {
          running.delete(container);
        });
    }
  });
})();
