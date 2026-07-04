(function () {
  window.SkydiveCommands = window.SkydiveCommands || [];

  const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

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

  function getFileName(state) {
    const name = typeof state.fileName === "string" ? state.fileName.trim() : "";
    return name || "Untitled file";
  }

  function getExtension(state) {
    const extension = typeof state.extension === "string" ? state.extension.trim().toLowerCase() : "";
    if (extension) return extension;
    const name = getFileName(state);
    const dotIndex = name.lastIndexOf(".");
    return dotIndex > 0 && dotIndex < name.length - 1 ? name.slice(dotIndex + 1).toLowerCase() : "";
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

  function formatBytes(bytes) {
    let value = Number(bytes);
    if (!Number.isFinite(value) || value < 0) return "";

    let unitIndex = 0;
    while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }

    const precision = unitIndex === 0 || value >= 10 ? 0 : 1;
    return `${value.toFixed(precision)} ${BYTE_UNITS[unitIndex]}`;
  }

  function isImageFile(state) {
    const mimeType = typeof state.mimeType === "string" ? state.mimeType : "";
    const resourceType = typeof state.resourceType === "string" ? state.resourceType : "";
    return mimeType.startsWith("image/") || resourceType === "image";
  }

  function isEpubFile(state) {
    const mimeType = typeof state.mimeType === "string" ? state.mimeType.toLowerCase() : "";
    return mimeType === "application/epub+zip" || getExtension(state) === "epub";
  }

  function openUrl(url) {
    const href = normalizeHref(url);
    if (!href) return;
    window.open(href, "_blank", "noopener,noreferrer");
  }

  function openBook(url, fileName) {
    const href = normalizeHref(url);
    if (!href) return;
    const title = getFileName({ fileName });
    const pathName = encodeURIComponent(title || "book.epub");
    const readerUrl = `/book/${pathName}?src=${encodeURIComponent(href)}&name=${encodeURIComponent(title)}`;
    window.open(readerUrl, "_blank", "noopener,noreferrer");
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

  window.SkydiveCommands.push({
    id: "file",
    aliases: ["upload", "attachment"],
    title: "File",
    description: "A draggable uploaded file attachment.",

    createState(context = {}) {
      const name = typeof context.args === "string" ? context.args.trim() : "";
      return {
        status: "empty",
        progress: 0,
        fileName: name || "Untitled file",
        extension: "",
        mimeType: "",
        bytes: 0,
        url: "",
        downloadUrl: "",
        resourceType: ""
      };
    },

    getTitle(state) {
      const status = getStatus(state || {});
      if (status === "uploading") return `Uploading ${getProgress(state || {})}%`;
      if (status === "error") return "Upload failed";
      return getFileName(state || {});
    },

    render(container, state) {
      container.innerHTML = `
        <div class="file-card">
          <div class="file-uploading" aria-live="polite"></div>
          <img class="file-preview" alt="" data-command-interactive hidden>
          <div class="file-main">
            <div class="file-name"></div>
            <div class="file-meta"></div>
            <div class="file-actions">
              <button class="file-button" type="button" data-command-interactive data-action="download">Download</button>
              <button class="file-button" type="button" data-command-interactive data-action="open">Open</button>
            </div>
          </div>
        </div>
      `;

      const style = document.createElement("style");
      style.textContent = `
        .file-card {
          display: grid;
          gap: 0.38em;
          min-width: 6.8em;
          max-width: 9.8em;
          padding: 0.55em 0.62em 0.5em;
          border: 0.04em solid #e4d7c5;
          border-radius: 0.55em;
          background: #fff8ed;
          color: #3f3328;
        }

        .file-card[data-status="error"] {
          border-color: #efc9bd;
          background: #fff5f2;
        }

        .file-uploading {
          color: #7b6650;
          font: 400 0.52em/1.2 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
          letter-spacing: 0;
          white-space: nowrap;
        }

        .file-uploading[hidden],
        .file-main[hidden] {
          display: none;
        }

        .file-preview {
          width: 100%;
          max-height: 4.1em;
          border-radius: 0.38em;
          object-fit: cover;
          background: #f0e3d3;
          display: block;
        }

        .file-preview[hidden] {
          display: none;
        }

        .file-main {
          display: grid;
          gap: 0.28em;
        }

        .file-name {
          overflow: hidden;
          color: #3f3328;
          font: 400 0.62em/1.14 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
          letter-spacing: 0;
          overflow-wrap: anywhere;
        }

        .file-meta {
          overflow: hidden;
          color: #7b6650;
          font: 400 0.42em/1.18 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
          letter-spacing: 0;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .file-actions {
          display: flex;
          gap: 0.25em;
        }

        .file-button {
          border: 0;
          border-radius: 0.38em;
          background: #eee1cf;
          padding: 0.26em 0.42em;
          color: #4b3b2d;
          font: 400 0.45em/1 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
        }

        .file-button:hover {
          background: #e7d6bf;
        }
      `;
      container.appendChild(style);

      const card = container.querySelector(".file-card");
      const uploading = container.querySelector(".file-uploading");
      const preview = container.querySelector(".file-preview");
      const main = container.querySelector(".file-main");
      const name = container.querySelector(".file-name");
      const meta = container.querySelector(".file-meta");
      const download = container.querySelector('[data-action="download"]');
      const open = container.querySelector('[data-action="open"]');
      const status = getStatus(state);
      const fileName = getFileName(state);
      const fileUrl = normalizeHref(state.url);
      const attachmentUrl = normalizeHref(state.downloadUrl) || fileUrl;
      const isBook = isEpubFile(state);

      card.dataset.status = status;
      uploading.hidden = status !== "uploading";
      main.hidden = status === "uploading";

      if (status === "uploading") {
        uploading.textContent = `Uploading... ${getProgress(state)}%`;
        preview.hidden = true;
        return;
      }

      name.textContent = fileName;

      if (status === "error") {
        const error = typeof state.error === "string" && state.error.trim()
          ? state.error.trim()
          : "Upload failed";
        meta.textContent = error;
        preview.hidden = true;
        download.hidden = true;
        open.hidden = true;
        return;
      }

      const bytes = formatBytes(state.bytes);
      const extension = getExtension(state).toUpperCase();
      meta.textContent = [extension, bytes].filter(Boolean).join(" - ");

      if (isImageFile(state) && fileUrl) {
        preview.src = fileUrl;
        preview.alt = fileName;
        preview.hidden = false;
      } else {
        preview.hidden = true;
      }

      download.disabled = !attachmentUrl;
      open.disabled = !fileUrl;
      open.textContent = isBook ? "Read" : "Open";

      download.addEventListener("click", () => {
        downloadUrl(attachmentUrl, fileName);
      });

      open.addEventListener("click", () => {
        if (isBook) openBook(fileUrl, fileName);
        else openUrl(fileUrl);
      });
    }
  });
})();
