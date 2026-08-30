(function () {
  window.SkydiveCommands = window.SkydiveCommands || [];

  const runtimes = new WeakMap();

  function stopStream(stream) {
    if (!stream) return;
    for (const track of stream.getTracks()) track.stop();
  }

  function setStatus(elements, text) {
    if (elements.status) elements.status.textContent = text;
  }

  async function startCamera(container, elements, runtime) {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
      setStatus(elements, "Camera unavailable");
      return;
    }

    setStatus(elements, "Camera");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 960 },
          height: { ideal: 960 }
        },
        audio: false
      });

      if (runtime.discard || !container.isConnected) {
        stopStream(stream);
        return;
      }

      runtime.stream = stream;
      elements.video.srcObject = stream;
      elements.card.dataset.ready = "true";
      setStatus(elements, "");
      const playPromise = elements.video.play();
      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch(() => {
          setStatus(elements, "Tap to start");
        });
      }
    } catch (error) {
      const denied = error && (error.name === "NotAllowedError" || error.name === "PermissionDeniedError");
      setStatus(elements, denied ? "Camera blocked" : "Camera error");
    }
  }

  function createState() {
    return {
      createdAt: Date.now()
    };
  }

  window.SkydiveCommands.push({
    id: "cam",
    aliases: ["camera", "webcam"],
    title: "Camera",
    description: "Show a local webcam bubble.",

    createState,

    getTitle() {
      return "Camera";
    },

    destroy(container) {
      const runtime = runtimes.get(container);
      if (!runtime) return;
      runtime.discard = true;
      stopStream(runtime.stream);
      runtimes.delete(container);
    },

    render(container) {
      this.destroy(container);

      const runtime = { stream: null, discard: false };
      runtimes.set(container, runtime);

      container.innerHTML = `
        <div class="cam-card">
          <video class="cam-video" autoplay muted playsinline></video>
          <div class="cam-status" aria-live="polite">Camera</div>
        </div>
      `;

      const style = document.createElement("style");
      style.textContent = `
        .cam-card {
          position: relative;
          width: 5.8em;
          height: 5.8em;
          overflow: hidden;
          border: 0.08em solid rgba(17, 24, 39, 0.18);
          border-radius: 50%;
          background: #f4f4f2;
          box-shadow: 0 0.12em 0.52em rgba(17, 24, 39, 0.16);
          color: #3f3d37;
        }

        .cam-video {
          display: block;
          width: 100%;
          height: 100%;
          object-fit: cover;
          transform: scaleX(-1);
          opacity: 0;
          transition: opacity 180ms ease;
          background: #f4f4f2;
        }

        .cam-card[data-ready="true"] .cam-video {
          opacity: 1;
        }

        .cam-status {
          position: absolute;
          inset: 0;
          display: grid;
          place-items: center;
          padding: 0.7em;
          color: #4b4840;
          font: 400 0.42em/1.1 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
          letter-spacing: 0;
          text-align: center;
          white-space: normal;
          pointer-events: none;
        }

        .cam-card[data-ready="true"] .cam-status:empty {
          display: none;
        }
      `;
      container.appendChild(style);

      const elements = {
        card: container.querySelector(".cam-card"),
        video: container.querySelector(".cam-video"),
        status: container.querySelector(".cam-status")
      };

      elements.card.addEventListener("click", () => {
        if (!elements.video.srcObject) return;
        const playPromise = elements.video.play();
        if (playPromise && typeof playPromise.catch === "function") playPromise.catch(() => {});
      });

      void startCamera(container, elements, runtime);
    }
  });
})();
