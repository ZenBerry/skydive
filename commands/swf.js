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
        <div class="swf-card">
          <div class="swf-title"></div>
          <div class="swf-stage" data-command-interactive></div>
        </div>
      `;

      const style = document.createElement("style");
      style.textContent = `
        .swf-card {
          box-sizing: border-box;
          width: 16em;
          overflow: hidden;
          border: 0.04em solid #d8d8d8;
          border-radius: 0.55em;
          background: #111;
          color: #f5f5f5;
        }

        .swf-title {
          overflow: hidden;
          padding: 0.28em 0.46em 0.25em;
          background: #1b1b1b;
          color: #e8e8e8;
          font: 400 0.46em/1.2 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .swf-stage {
          display: grid;
          width: 100%;
          aspect-ratio: 4 / 3;
          place-items: center;
          overflow: hidden;
          background: #000;
          color: #bbb;
          font: 400 0.48em/1.25 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
          text-align: center;
        }

        .swf-stage ruffle-player {
          display: block;
          width: 100%;
          height: 100%;
        }
      `;
      container.appendChild(style);

      const title = container.querySelector(".swf-title");
      const stage = container.querySelector(".swf-stage");
      const status = getStatus(state || {});
      const fileName = getFileName(state || {});
      const fileUrl = normalizeHref(state && state.url);
      title.textContent = fileName;

      if (status === "uploading") {
        stage.textContent = `Uploading... ${getProgress(state || {})}%`;
        return;
      }
      if (status === "error") {
        stage.textContent = typeof state.error === "string" && state.error.trim()
          ? state.error.trim()
          : "Upload failed";
        return;
      }
      if (!fileUrl) {
        stage.textContent = "Drop an SWF file";
        return;
      }

      loadRuffle().then((RufflePlayer) => {
        if (!container.isConnected || !stage.isConnected) return;
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
        stage.replaceChildren(player);
        return player.ruffle().load({ url: fileUrl });
      }).catch((error) => {
        if (!container.isConnected || !stage.isConnected) return;
        console.error("Could not play SWF:", error);
        stage.textContent = "Could not play this SWF";
      });
    },

    destroy(container) {
      const player = container.querySelector("ruffle-player");
      if (player) player.remove();
    }
  });
})();
