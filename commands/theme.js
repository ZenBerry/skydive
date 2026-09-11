(function () {
  window.SkydiveCommands = window.SkydiveCommands || [];

  function normalizeHref(value) {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw) return "";

    try {
      const url = new URL(raw);
      if (url.protocol !== "http:" && url.protocol !== "https:") return "";
      return url.href;
    } catch (error) {
      return "";
    }
  }

  function getThemeName(state) {
    const name = typeof state.themeName === "string" ? state.themeName.trim() : "";
    if (name) return name;
    const paletteName = state.palette && typeof state.palette.name === "string" ? state.palette.name.trim() : "";
    if (paletteName) return paletteName;
    return typeof state.fileName === "string" && state.fileName.trim() ? state.fileName.trim() : "VS Code Theme";
  }

  function getStatus(state) {
    const status = typeof state.status === "string" ? state.status : "";
    return status || (normalizeHref(state.url) ? "uploaded" : "empty");
  }

  function getProgress(state) {
    const progress = Number(state.progress);
    if (!Number.isFinite(progress)) return 0;
    return Math.max(0, Math.min(100, Math.round(progress)));
  }

  function downloadUrl(url, fileName) {
    const href = normalizeHref(url);
    if (!href) return;

    const link = document.createElement("a");
    link.href = href;
    link.download = fileName || "theme.json";
    link.rel = "noopener noreferrer";
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  window.SkydiveCommands.push({
    id: "theme",
    aliases: ["vscode-theme", "color-theme"],
    title: "Theme",
    description: "Apply a VS Code theme to this space.",

    createState(context = {}) {
      const name = typeof context.args === "string" ? context.args.trim() : "";
      return {
        status: "empty",
        progress: 0,
        fileName: name || "theme.json",
        themeName: name || "VS Code Theme",
        extension: "json",
        mimeType: "application/json",
        bytes: 0,
        url: "",
        downloadUrl: "",
        resourceType: "",
        palette: null,
        sourceKind: "vscode-theme"
      };
    },

    getTitle(state, context = {}) {
      const active = context && typeof context.isActiveSpaceTheme === "function" && context.isActiveSpaceTheme();
      return `${active ? "Active theme" : "Theme"}: ${getThemeName(state || {})}`;
    },

    render(container, state, onState, context = {}) {
      const active = context && typeof context.isActiveSpaceTheme === "function" && context.isActiveSpaceTheme();
      const status = getStatus(state || {});
      const palette = state && state.palette && typeof state.palette === "object" ? state.palette : null;
      const attachmentUrl = normalizeHref(state && state.downloadUrl) || normalizeHref(state && state.url);
      const fileName = typeof state.fileName === "string" && state.fileName.trim() ? state.fileName.trim() : "theme.json";
      const canApply = Boolean(palette && typeof context.applySpaceTheme === "function");

      container.innerHTML = `
        <div class="theme-card" data-status="${status}" data-active="${active ? "true" : "false"}">
          <div class="theme-main">
            <div class="theme-name"></div>
            <div class="theme-meta"></div>
            <div class="theme-actions">
              <button type="button" data-command-interactive data-action="apply"></button>
              <button type="button" data-command-interactive data-action="download">Download</button>
            </div>
          </div>
        </div>
      `;

      const style = document.createElement("style");
      style.textContent = `
        .theme-card {
          display: grid;
          gap: 0.38em;
          min-width: 7.4em;
          max-width: 10.8em;
          padding: 0.55em 0.62em 0.5em;
          border: 0.04em solid var(--widget-border-color);
          border-radius: 0.55em;
          background: var(--widget-color);
          color: var(--skydive-widget-text);
        }

        .theme-card[data-active="true"] {
          border-color: var(--skydive-avatar-bg);
        }

        .theme-main {
          display: grid;
          gap: 0.28em;
        }

        .theme-name {
          overflow: hidden;
          color: var(--skydive-widget-text);
          font: 400 0.62em/1.14 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
          letter-spacing: 0;
          overflow-wrap: anywhere;
        }

        .theme-meta {
          overflow: hidden;
          color: var(--skydive-widget-muted);
          font: 400 0.42em/1.18 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
          letter-spacing: 0;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .theme-actions {
          display: flex;
          gap: 0.25em;
        }

        .theme-actions button {
          border: 0;
          border-radius: 0.38em;
          background: var(--widget-button-color);
          padding: 0.26em 0.42em;
          color: var(--skydive-widget-text);
          font: 400 0.45em/1 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
        }

        .theme-actions button:hover:not(:disabled) {
          background: var(--widget-button-hover-color);
        }

        .theme-actions button:disabled {
          opacity: 0.5;
          cursor: default;
        }
      `;
      container.appendChild(style);

      const name = container.querySelector(".theme-name");
      const meta = container.querySelector(".theme-meta");
      const apply = container.querySelector('[data-action="apply"]');
      const download = container.querySelector('[data-action="download"]');

      name.textContent = getThemeName(state || {});
      if (status === "uploading") {
        meta.textContent = `Uploading... ${getProgress(state || {})}%`;
      } else if (status === "error") {
        meta.textContent = state && typeof state.error === "string" && state.error.trim()
          ? state.error.trim()
          : "Upload failed";
      } else {
        meta.textContent = active ? "Active in this space" : "Ready for this space";
      }

      apply.textContent = active ? "Dismiss" : "Apply";
      apply.disabled = !canApply && !active;
      download.disabled = !attachmentUrl;

      apply.addEventListener("click", () => {
        if (active) {
          if (typeof context.dismissSpaceTheme === "function") context.dismissSpaceTheme();
        } else if (canApply) {
          context.applySpaceTheme(palette);
        }
        if (typeof onState === "function") onState({ ...state });
      });

      download.addEventListener("click", () => {
        downloadUrl(attachmentUrl, fileName);
      });
    }
  });
})();
