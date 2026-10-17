(function () {
  window.SkydiveCommands = window.SkydiveCommands || [];

  const RUFFLE_URL = "https://cdn.jsdelivr.net/npm/@ruffle-rs/ruffle@0.7.1/ruffle.js";
  let ruffleLoad = null;

  function normalizeHref(value) {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw) return "";
    try {
      const url = new URL(raw);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
    } catch (error) {
      return "";
    }
  }

  function getFileName(state) {
    const name = typeof state.fileName === "string" ? state.fileName.trim() : "";
    return name || "Flash movie";
  }

  function getStatus(state) {
    const status = typeof state.status === "string" ? state.status : "";
    return status || (normalizeHref(state.url) ? "uploaded" : "empty");
  }

  function getProgress(state) {
    const progress = Number(state.progress);
    return Number.isFinite(progress) ? Math.max(0, Math.min(100, Math.round(progress))) : 0;
  }

  function formatBytes(bytes) {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = Number(bytes);
    if (!Number.isFinite(value) || value < 0) return "Unknown";
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    return `${value.toFixed(unitIndex === 0 || value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
  }

  function formatDate(value) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return "Unknown";
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date(timestamp));
  }

  function downloadUrl(url, fileName) {
    const href = normalizeHref(url);
    if (!href) return;
    const link = document.createElement("a");
    link.href = href;
    link.download = fileName;
    link.rel = "noopener noreferrer";
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function loadRuffle() {
    if (window.RufflePlayer && typeof window.RufflePlayer.newest === "function") {
      return Promise.resolve(window.RufflePlayer);
    }
    if (ruffleLoad) return ruffleLoad;

    ruffleLoad = new Promise((resolve, reject) => {
      window.RufflePlayer = window.RufflePlayer || {};
      window.RufflePlayer.config = {
        ...(window.RufflePlayer.config || {}),
        polyfills: false
      };
      const script = document.createElement("script");
      script.src = RUFFLE_URL;
      script.async = true;
      script.onload = () => {
        if (window.RufflePlayer && typeof window.RufflePlayer.newest === "function") {
          resolve(window.RufflePlayer);
        } else {
          reject(new Error("Ruffle did not initialize."));
        }
      };
      script.onerror = () => reject(new Error("Could not load Ruffle."));
      document.head.appendChild(script);
    }).catch((error) => {
      ruffleLoad = null;
      throw error;
    });

    return ruffleLoad;
  }

  window.SkydiveCommands.push({
    id: "swf",
    title: "Flash Player",
    description: "Play an uploaded SWF with Ruffle.",

    getTitle(state) {
      const status = getStatus(state || {});
      if (status === "uploading") return `Uploading ${getProgress(state || {})}%`;
      if (status === "error") return "SWF upload failed";
      return getFileName(state || {});
    },

    render(container, state) {
      container.innerHTML = `
        <div class="swf-card" data-flipped="false">
          <div class="swf-face swf-front" data-command-interactive></div>
          <div class="swf-face swf-back" data-command-interactive>
            <dl class="swf-info"></dl>
            <div class="swf-actions">
              <button type="button" data-command-interactive data-action="back">Back</button>
              <button type="button" data-command-interactive data-action="download">Download</button>
            </div>
          </div>
        </div>
      `;

      const style = document.createElement("style");
      style.textContent = `
        .swf-card {
          position: relative;
          box-sizing: border-box;
          width: 16em;
          aspect-ratio: 4 / 3;
          border: 0 !important;
          background: transparent !important;
          color: #f5f5f5;
          transform-style: preserve-3d;
          transition: transform 800ms cubic-bezier(0.9, 0, 0.1, 1);
        }

        .swf-card[data-flipped="false"] {
          transform: perspective(42em) rotateY(0deg);
        }

        .swf-card[data-flipped="true"] {
          transform: perspective(42em) rotateY(180deg);
        }

        .swf-face {
          position: absolute;
          inset: 0;
          display: grid;
          box-sizing: border-box;
          overflow: hidden;
          border: 0.04em solid var(--widget-border-color, #d8d8d8);
          border-radius: var(--widget-shell-radius, 0.55em);
          backface-visibility: hidden;
        }

        .swf-front {
          place-items: center;
          background: #000;
          color: #bbb;
          font: 400 0.48em/1.25 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
          pointer-events: auto;
          text-align: center;
        }

        .swf-back {
          align-content: space-between;
          gap: 0.55em;
          padding: 0.72em;
          background: var(--widget-field-color, #fff);
          color: #3f3328;
          pointer-events: none;
          transform: rotateY(180deg);
        }

        .swf-card[data-flipped="true"] .swf-front {
          pointer-events: none;
        }

        .swf-card[data-flipped="true"] .swf-back {
          pointer-events: auto;
        }

        .swf-info {
          display: grid;
          grid-template-columns: auto minmax(0, 1fr);
          gap: 0.28em 0.52em;
          margin: 0;
          font: 400 0.46em/1.2 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
        }

        .swf-info dt {
          color: #7b6650;
        }

        .swf-info dd {
          overflow: hidden;
          margin: 0;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .swf-actions {
          display: flex;
          gap: 0.3em;
        }

        .swf-actions button {
          border: 0;
          padding: 0.28em 0.5em;
          color: #4b3b2d;
          font: 500 0.45em/1 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
        }

        .swf-front ruffle-player {
          display: block;
          width: 100%;
          height: 100%;
        }

        @media (prefers-reduced-motion: reduce) {
          .swf-card {
            transition: none;
          }
        }
      `;
      container.appendChild(style);

      const card = container.querySelector(".swf-card");
      const front = container.querySelector(".swf-front");
      const info = container.querySelector(".swf-info");
      const status = getStatus(state || {});
      const fileName = getFileName(state || {});
      const fileUrl = normalizeHref(state && state.url);
      const attachmentUrl = normalizeHref(state && state.downloadUrl) || fileUrl;
      const fields = [
        ["Filename", fileName],
        ["Size", formatBytes(state && state.bytes)],
        ["Created", formatDate(state && (state.createdAt || state.uploadedAt))],
        ["Modified", formatDate(state && state.modifiedAt)],
        ["Uploaded to Skydive", formatDate(state && state.uploadedAt)]
      ];
      for (const [label, value] of fields) {
        const term = document.createElement("dt");
        const detail = document.createElement("dd");
        term.textContent = label;
        detail.textContent = value;
        detail.title = value;
        info.append(term, detail);
      }

      container.querySelector('[data-action="back"]').addEventListener("click", () => {
        if (card) card.dataset.flipped = "false";
      });
      const download = container.querySelector('[data-action="download"]');
      download.disabled = !attachmentUrl;
      download.addEventListener("click", () => downloadUrl(attachmentUrl, fileName));

      if (status === "uploading") {
        front.textContent = `Uploading... ${getProgress(state || {})}%`;
        return;
      }
      if (status === "error") {
        front.textContent = typeof state.error === "string" && state.error.trim()
          ? state.error.trim()
          : "Upload failed";
        return;
      }
      if (!fileUrl) {
        front.textContent = "Drop an SWF file";
        return;
      }

      loadRuffle().then((RufflePlayer) => {
        if (!container.isConnected || !front.isConnected) return;
        const player = RufflePlayer.newest().createPlayer();
        player.setAttribute("aria-label", fileName);
        player.setAttribute("data-command-interactive", "");
        player.config = {
          autoplay: "on",
          unmuteOverlay: "hidden",
          splashScreen: false,
          contextMenu: "off",
          menu: false,
          showSwfDownload: false,
          warnOnUnsupportedContent: false,
          allowFullscreen: false,
          logLevel: "error"
        };
        front.replaceChildren(player);
        return player.ruffle().load({ url: fileUrl });
      }).catch((error) => {
        if (!container.isConnected || !front.isConnected) return;
        console.error("Could not play SWF:", error);
        front.textContent = "Could not play this SWF";
      });
    },

    showInfo(container) {
      const card = container.querySelector(".swf-card");
      if (card) card.dataset.flipped = "true";
    },

    destroy(container) {
      const player = container.querySelector("ruffle-player");
      if (player) player.remove();
    }
  });
})();
