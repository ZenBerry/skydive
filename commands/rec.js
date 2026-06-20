(function () {
  window.SkydiveCommands = window.SkydiveCommands || [];

  const runtimes = new WeakMap();
  const PLAYBACK_SPEEDS = [1, 1.5, 2];
  const MIME_TYPES = [
    "audio/webm;codecs=opus",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/webm",
    "audio/ogg;codecs=opus"
  ];

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

  function getAttachmentUrl(state) {
    const explicit = normalizeHref(state.downloadUrl);
    if (explicit) return explicit;

    const href = normalizeHref(state.url);
    const marker = "/upload/";
    const index = href.indexOf(marker);
    if (!href || index === -1) return href;
    return `${href.slice(0, index + marker.length)}fl_attachment/${href.slice(index + marker.length)}`;
  }

  function formatTime(seconds) {
    const safeSeconds = Number.isFinite(Number(seconds)) ? Math.max(0, Number(seconds)) : 0;
    const minutes = Math.floor(safeSeconds / 60);
    const remainder = Math.floor(safeSeconds % 60);
    return `${minutes}:${String(remainder).padStart(2, "0")}`;
  }

  function getRecordingMimeType() {
    if (typeof MediaRecorder === "undefined") return "";
    if (typeof MediaRecorder.isTypeSupported !== "function") return "";
    return MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) || "";
  }

  function getExtension(mimeType) {
    const type = String(mimeType || "").toLowerCase();
    if (type.includes("mp4") || type.includes("m4a")) return "m4a";
    if (type.includes("ogg")) return "ogg";
    if (type.includes("mpeg")) return "mp3";
    if (type.includes("wav")) return "wav";
    return "webm";
  }

  function createRecordingFile(blob, mimeType) {
    const extension = getExtension(mimeType);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return new File([blob], `recording-${stamp}.${extension}`, {
      type: mimeType || blob.type || "audio/webm",
      lastModified: Date.now()
    });
  }

  function downloadUrl(url, fileName) {
    const href = normalizeHref(url);
    if (!href) return;

    const link = document.createElement("a");
    link.href = href;
    link.download = fileName || "recording";
    link.rel = "noopener noreferrer";
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function setRecordingUi(elements, recording) {
    elements.card.dataset.recording = recording ? "true" : "false";
    elements.record.disabled = recording;
    elements.recordStop.disabled = !recording;
  }

  function stopStream(stream) {
    if (!stream) return;
    for (const track of stream.getTracks()) track.stop();
  }

  function buildUploadedState(file, upload, context, showSpeedControl) {
    if (context && typeof context.createUploadedFileState === "function") {
      return {
        ...context.createUploadedFileState(file, upload),
        showSpeedControl,
        source: "recording"
      };
    }

    const url = normalizeHref(upload && (upload.secure_url || upload.url));
    if (!url) throw new Error("Cloudinary did not return an audio URL.");
    return {
      status: "uploaded",
      progress: 100,
      fileName: file.name,
      extension: getExtension(file.type),
      mimeType: file.type,
      bytes: Number(upload.bytes) || file.size,
      url,
      downloadUrl: "",
      resourceType: "video",
      publicId: typeof upload.public_id === "string" ? upload.public_id : "",
      uploadedAt: Date.now(),
      showSpeedControl,
      source: "recording"
    };
  }

  function createWaveSurfer(container, url, elements, runtime) {
    if (!window.WaveSurfer || typeof window.WaveSurfer.create !== "function") return false;

    let wavesurfer = null;
    try {
      wavesurfer = window.WaveSurfer.create({
        container: elements.wave,
        waveColor: "#9b8d7d",
        progressColor: "#332a23",
        cursorColor: "#e36e54",
        cursorWidth: 1,
        height: "auto",
        normalize: true,
        barWidth: 2,
        barGap: 2,
        barRadius: 3,
        url
      });
    } catch (error) {
      return false;
    }
    runtime.wavesurfer = wavesurfer;

    wavesurfer.on("ready", (duration) => {
      if (!container.isConnected) return;
      elements.time.textContent = `0:00 / ${formatTime(duration)}`;
      elements.start.disabled = false;
      elements.pause.disabled = false;
      elements.stop.disabled = false;
      if (elements.speed) elements.speed.disabled = false;
    });
    wavesurfer.on("timeupdate", (currentTime) => {
      if (!container.isConnected) return;
      elements.time.textContent = `${formatTime(currentTime)} / ${formatTime(wavesurfer.getDuration())}`;
    });
    wavesurfer.on("finish", () => {
      if (!container.isConnected) return;
      elements.time.textContent = `0:00 / ${formatTime(wavesurfer.getDuration())}`;
    });
    wavesurfer.on("error", () => {
      if (!container.isConnected) return;
      elements.status.textContent = "Could not load audio";
    });
    return true;
  }

  function createNativeFallback(url, elements, runtime) {
    const audio = document.createElement("audio");
    audio.src = url;
    audio.preload = "metadata";
    audio.hidden = true;
    elements.card.appendChild(audio);
    elements.wave.dataset.fallback = "true";
    runtime.audio = audio;

    audio.addEventListener("loadedmetadata", () => {
      elements.time.textContent = `0:00 / ${formatTime(audio.duration)}`;
      elements.start.disabled = false;
      elements.pause.disabled = false;
      elements.stop.disabled = false;
      if (elements.speed) elements.speed.disabled = false;
    });
    audio.addEventListener("timeupdate", () => {
      elements.time.textContent = `${formatTime(audio.currentTime)} / ${formatTime(audio.duration)}`;
    });
    audio.addEventListener("error", () => {
      elements.status.textContent = "Could not load audio";
    });
  }

  function getPlayer(runtime) {
    if (runtime.wavesurfer) {
      return {
        play: () => runtime.wavesurfer.play(),
        pause: () => runtime.wavesurfer.pause(),
        stop: () => runtime.wavesurfer.stop(),
        setPlaybackRate: (rate) => runtime.wavesurfer.setPlaybackRate(rate, true)
      };
    }
    if (!runtime.audio) return null;
    return {
      play: () => runtime.audio.play(),
      pause: () => runtime.audio.pause(),
      stop: () => {
        runtime.audio.pause();
        runtime.audio.currentTime = 0;
      },
      setPlaybackRate: (rate) => {
        runtime.audio.playbackRate = rate;
      }
    };
  }

  window.SkydiveCommands.push({
    id: "rec",
    aliases: ["record", "audio", "voice", "voice-note"],
    title: "Recorder",
    description: "Record a voice note and play its waveform.",

    createState() {
      return {
        status: "empty",
        progress: 0,
        fileName: "Recording",
        extension: "",
        mimeType: "",
        bytes: 0,
        url: "",
        downloadUrl: "",
        resourceType: "",
        showSpeedControl: true,
        source: "recording"
      };
    },

    render(container, state, onState, context = {}) {
      const status = typeof state.status === "string" ? state.status : "empty";
      const audioUrl = normalizeHref(state.url);
      const hasAudio = status === "uploaded" && Boolean(audioUrl);
      const showSpeedControl = state.showSpeedControl !== false;
      const fileName = typeof state.fileName === "string" && state.fileName.trim()
        ? state.fileName.trim()
        : "Recording";

      container.innerHTML = `
        <div class="rec-card">
          <div class="rec-heading">
            <span class="rec-title"></span>
            <span class="rec-status" aria-live="polite"></span>
          </div>
          <div class="rec-wave" data-command-interactive>
            <div class="rec-empty-wave" aria-hidden="true"></div>
          </div>
          <div class="rec-time"></div>
          <div class="rec-playback-actions" hidden>
            <button type="button" data-command-interactive data-action="start">Start</button>
            <button type="button" data-command-interactive data-action="stop">Stop</button>
            <button type="button" data-command-interactive data-action="pause">Pause</button>
            <button type="button" data-command-interactive data-action="speed">1x</button>
            <button type="button" data-command-interactive data-action="download">Download</button>
          </div>
          <div class="rec-record-actions" hidden>
            <button type="button" data-command-interactive data-action="record">Record</button>
            <button type="button" data-command-interactive data-action="record-stop">Stop</button>
          </div>
        </div>
      `;

      const style = document.createElement("style");
      style.textContent = `
        .rec-card {
          display: grid;
          gap: 0.34em;
          width: 12.4em;
          padding: 0.58em 0.64em 0.62em;
          border: 0.04em solid #dfd3c3;
          border-radius: 0.68em;
          background: linear-gradient(145deg, #fffaf1, #f5eadc);
          box-shadow: 0 0.3em 1.1em rgba(70, 53, 38, 0.12);
          color: #332a23;
          user-select: none;
        }
        .rec-card[data-status="error"] { border-color: #e9b9ac; }
        .rec-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 0.6em; }
        .rec-title {
          overflow: hidden;
          font: 500 0.54em/1.1 "Myriad Pro", "Roboto", sans-serif;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .rec-status, .rec-time {
          color: #817467;
          font: 400 0.38em/1.1 "Myriad Pro", "Roboto", sans-serif;
          white-space: nowrap;
        }
        .rec-time { min-height: 1.1em; text-align: right; }
        .rec-wave {
          position: relative;
          height: 2em;
          overflow: hidden;
          border-radius: 0.42em;
          background: rgba(98, 78, 60, 0.08);
        }
        .rec-empty-wave {
          position: absolute;
          inset: 20% 0.45em;
          opacity: 0.52;
          background: repeating-linear-gradient(90deg, #9b8d7d 0 0.07em, transparent 0.07em 0.2em);
          clip-path: polygon(0 48%, 4% 38%, 8% 57%, 12% 24%, 16% 62%, 20% 43%, 24% 68%, 28% 28%, 32% 54%, 36% 18%, 40% 72%, 44% 34%, 48% 59%, 52% 25%, 56% 66%, 60% 40%, 64% 76%, 68% 23%, 72% 62%, 76% 35%, 80% 70%, 84% 29%, 88% 57%, 92% 40%, 96% 63%, 100% 48%, 100% 52%, 0 52%);
        }
        .rec-card[data-recording="true"] .rec-empty-wave {
          background-color: #df654e;
          animation: rec-breathe 0.75s ease-in-out infinite alternate;
        }
        .rec-wave[data-fallback="true"] .rec-empty-wave { display: block; }
        .rec-playback-actions, .rec-record-actions { display: flex; gap: 0.22em; }
        .rec-playback-actions[hidden], .rec-record-actions[hidden] { display: none; }
        .rec-card button {
          flex: 1 1 auto;
          border: 0;
          border-radius: 0.38em;
          background: #e7dac9;
          padding: 0.3em 0.42em;
          color: #40342b;
          font: 500 0.39em/1 "Myriad Pro", "Roboto", sans-serif;
          white-space: nowrap;
        }
        .rec-card button:hover:not(:disabled) { background: #ddcbb5; }
        .rec-card button:disabled { cursor: default; opacity: 0.38; }
        .rec-card [data-action="record"] { background: #e36e54; color: white; }
        .rec-card [data-action="record"]:hover:not(:disabled) { background: #d85e45; }
        @keyframes rec-breathe { from { opacity: 0.38; transform: scaleY(0.55); } to { opacity: 0.92; transform: scaleY(1); } }
      `;
      container.appendChild(style);

      const elements = {
        card: container.querySelector(".rec-card"),
        title: container.querySelector(".rec-title"),
        status: container.querySelector(".rec-status"),
        wave: container.querySelector(".rec-wave"),
        time: container.querySelector(".rec-time"),
        playbackActions: container.querySelector(".rec-playback-actions"),
        recordActions: container.querySelector(".rec-record-actions"),
        start: container.querySelector('[data-action="start"]'),
        stop: container.querySelector('[data-action="stop"]'),
        pause: container.querySelector('[data-action="pause"]'),
        speed: container.querySelector('[data-action="speed"]'),
        download: container.querySelector('[data-action="download"]'),
        record: container.querySelector('[data-action="record"]'),
        recordStop: container.querySelector('[data-action="record-stop"]')
      };

      elements.card.dataset.status = status;
      elements.title.textContent = fileName;
      elements.speed.hidden = !showSpeedControl;

      const runtime = {
        recorder: null,
        stream: null,
        wavesurfer: null,
        audio: null,
        animationFrame: null,
        discard: false
      };
      runtimes.set(container, runtime);

      if (hasAudio) {
        elements.status.textContent = "Ready";
        elements.playbackActions.hidden = false;
        elements.wave.replaceChildren();
        elements.start.disabled = true;
        elements.pause.disabled = true;
        elements.stop.disabled = true;
        if (showSpeedControl) elements.speed.disabled = true;

        const initializePlayer = () => {
          runtime.animationFrame = null;
          if (runtime.discard || !container.isConnected) return;
          if (!createWaveSurfer(container, audioUrl, elements, runtime)) {
            elements.wave.innerHTML = '<div class="rec-empty-wave" aria-hidden="true"></div>';
            createNativeFallback(audioUrl, elements, runtime);
          }
        };
        if (container.isConnected) initializePlayer();
        else runtime.animationFrame = requestAnimationFrame(initializePlayer);

        let speedIndex = 0;
        elements.start.addEventListener("click", () => {
          const player = getPlayer(runtime);
          if (player) void player.play();
        });
        elements.pause.addEventListener("click", () => {
          const player = getPlayer(runtime);
          if (player) player.pause();
        });
        elements.stop.addEventListener("click", () => {
          const player = getPlayer(runtime);
          if (player) player.stop();
        });
        elements.speed.addEventListener("click", () => {
          const player = getPlayer(runtime);
          if (!player) return;
          speedIndex = (speedIndex + 1) % PLAYBACK_SPEEDS.length;
          const speed = PLAYBACK_SPEEDS[speedIndex];
          elements.speed.textContent = `${speed}x`;
          player.setPlaybackRate(speed);
        });
        elements.download.addEventListener("click", () => {
          downloadUrl(getAttachmentUrl(state), fileName);
        });
        return;
      }

      elements.recordActions.hidden = false;
      elements.recordStop.disabled = true;
      elements.time.textContent = "";

      if (status === "uploading") {
        const progress = Math.max(0, Math.min(100, Math.round(Number(state.progress) || 0)));
        elements.status.textContent = `Uploading ${progress}%`;
        elements.record.disabled = true;
        return;
      }

      if (status === "error") {
        elements.status.textContent = typeof state.error === "string" && state.error.trim()
          ? state.error.trim()
          : "Upload failed";
      } else {
        elements.status.textContent = "Ready to record";
      }

      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function" || typeof MediaRecorder === "undefined") {
        elements.status.textContent = "Recording is not supported here";
        elements.record.disabled = true;
        return;
      }

      elements.record.addEventListener("click", async () => {
        if (runtime.recorder && runtime.recorder.state !== "inactive") return;
        elements.record.disabled = true;
        elements.status.textContent = "Requesting microphone...";

        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          if (!container.isConnected || runtime.discard) {
            stopStream(stream);
            return;
          }

          const mimeType = getRecordingMimeType();
          const recorder = mimeType
            ? new MediaRecorder(stream, { mimeType })
            : new MediaRecorder(stream);
          const chunks = [];
          runtime.stream = stream;
          runtime.recorder = recorder;

          recorder.addEventListener("dataavailable", (event) => {
            if (event.data && event.data.size > 0) chunks.push(event.data);
          });

          recorder.addEventListener("stop", async () => {
            stopStream(runtime.stream);
            runtime.stream = null;
            if (runtime.discard) return;

            const recordingType = recorder.mimeType || mimeType || "audio/webm";
            const blob = new Blob(chunks, { type: recordingType });
            if (blob.size === 0) {
              setRecordingUi(elements, false);
              elements.status.textContent = "Nothing was recorded";
              return;
            }

            const file = createRecordingFile(blob, recordingType);
            elements.card.dataset.recording = "false";
            elements.record.disabled = true;
            elements.recordStop.disabled = true;
            elements.status.textContent = "Uploading 0%";

            try {
              if (typeof context.uploadFile !== "function") throw new Error("Audio upload is unavailable.");
              const upload = await context.uploadFile(file, (progress) => {
                if (!container.isConnected || runtime.discard) return;
                elements.status.textContent = `Uploading ${Math.round(progress)}%`;
              });
              if (!container.isConnected || runtime.discard) return;
              onState(buildUploadedState(file, upload, context, true));
            } catch (error) {
              if (!container.isConnected || runtime.discard) return;
              onState({
                status: "error",
                progress: 0,
                fileName: file.name,
                extension: getExtension(file.type),
                mimeType: file.type,
                bytes: file.size,
                url: "",
                downloadUrl: "",
                resourceType: "",
                showSpeedControl: true,
                source: "recording",
                error: error && error.message ? String(error.message).slice(0, 180) : "Upload failed",
                failedAt: Date.now()
              });
            }
          });

          recorder.start(250);
          setRecordingUi(elements, true);
          elements.status.textContent = "Recording...";
        } catch (error) {
          stopStream(runtime.stream);
          runtime.stream = null;
          setRecordingUi(elements, false);
          elements.status.textContent = error && error.name === "NotAllowedError"
            ? "Microphone access was denied"
            : "Could not start recording";
        }
      });

      elements.recordStop.addEventListener("click", () => {
        if (!runtime.recorder || runtime.recorder.state === "inactive") return;
        elements.recordStop.disabled = true;
        elements.status.textContent = "Finishing recording...";
        runtime.recorder.stop();
      });
    },

    destroy(container) {
      const runtime = runtimes.get(container);
      if (!runtime) return;
      runtime.discard = true;
      if (runtime.animationFrame !== null) cancelAnimationFrame(runtime.animationFrame);
      if (runtime.recorder && runtime.recorder.state !== "inactive") runtime.recorder.stop();
      stopStream(runtime.stream);
      if (runtime.wavesurfer) runtime.wavesurfer.destroy();
      if (runtime.audio) {
        runtime.audio.pause();
        runtime.audio.removeAttribute("src");
        runtime.audio.load();
      }
      runtimes.delete(container);
    }
  });
})();
