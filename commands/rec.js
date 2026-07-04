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

  function createMp3File(blob) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return new File([blob], `audio-${stamp}.mp3`, {
      type: "audio/mpeg",
      lastModified: Date.now()
    });
  }

  function floatToInt16(samples) {
    const output = new Int16Array(samples.length);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, samples[index]));
      output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return output;
  }

  async function encodeMp3(blob, onProgress, shouldCancel) {
    if (!window.lamejs || typeof window.lamejs.Mp3Encoder !== "function") {
      throw new Error("The MP3 encoder could not be loaded.");
    }

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("MP3 encoding is not supported here.");

    const audioContext = new AudioContextClass();
    try {
      const buffer = await audioContext.decodeAudioData(await blob.arrayBuffer());
      const channelCount = buffer.numberOfChannels > 1 ? 2 : 1;
      const left = buffer.getChannelData(0);
      const right = channelCount === 2 ? buffer.getChannelData(1) : null;
      const encoder = new window.lamejs.Mp3Encoder(channelCount, buffer.sampleRate, 128);
      const mp3Chunks = [];
      const blockSize = 1152;

      for (let offset = 0; offset < buffer.length; offset += blockSize) {
        if (shouldCancel()) throw new DOMException("Encoding canceled.", "AbortError");
        const leftBlock = floatToInt16(left.subarray(offset, offset + blockSize));
        const encoded = right
          ? encoder.encodeBuffer(leftBlock, floatToInt16(right.subarray(offset, offset + blockSize)))
          : encoder.encodeBuffer(leftBlock);
        if (encoded.length > 0) mp3Chunks.push(new Uint8Array(encoded));

        if ((offset / blockSize) % 64 === 0) {
          onProgress(Math.min(99, Math.round((offset / Math.max(1, buffer.length)) * 100)));
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
      }

      const finalChunk = encoder.flush();
      if (finalChunk.length > 0) mp3Chunks.push(new Uint8Array(finalChunk));
      onProgress(100);
      return new Blob(mp3Chunks, { type: "audio/mpeg" });
    } finally {
      try {
        await audioContext.close();
      } catch (error) {
        // Some browsers close decoding contexts automatically.
      }
    }
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

  function stopLiveWaveform(elements, runtime) {
    if (runtime.liveFrame !== null) cancelAnimationFrame(runtime.liveFrame);
    runtime.liveFrame = null;
    if (runtime.mediaSource) runtime.mediaSource.disconnect();
    runtime.mediaSource = null;
    runtime.analyser = null;
    if (runtime.audioContext) {
      void runtime.audioContext.close().catch(() => {});
      runtime.audioContext = null;
    }
    if (elements && elements.wave) elements.wave.dataset.mode = "empty";
  }

  function startLiveWaveform(stream, elements, runtime) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;

    const audioContext = new AudioContextClass();
    const analyser = audioContext.createAnalyser();
    const mediaSource = audioContext.createMediaStreamSource(stream);
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.72;
    mediaSource.connect(analyser);

    runtime.audioContext = audioContext;
    runtime.analyser = analyser;
    runtime.mediaSource = mediaSource;
    elements.wave.dataset.mode = "recording";

    const values = new Uint8Array(analyser.fftSize);
    const canvas = elements.liveWave;
    const context = canvas.getContext("2d");

    const draw = () => {
      if (runtime.discard || !runtime.analyser || !containerIsLive(elements.card)) return;
      const width = Math.max(1, canvas.clientWidth);
      const height = Math.max(1, canvas.clientHeight);
      const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
      const targetWidth = Math.round(width * pixelRatio);
      const targetHeight = Math.round(height * pixelRatio);
      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
      }

      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, width, height);
      analyser.getByteTimeDomainData(values);
      let peak = 0;
      for (let index = 0; index < values.length; index += 1) {
        peak = Math.max(peak, Math.abs((values[index] - 128) / 128));
      }
      const gain = peak > 0.02 ? Math.min(4, 0.82 / peak) : 1;
      context.beginPath();
      context.strokeStyle = "#332a23";
      context.lineWidth = 1.4;
      context.lineJoin = "round";
      context.lineCap = "round";
      for (let index = 0; index < values.length; index += 1) {
        const x = (index / (values.length - 1)) * width;
        const amplitude = ((values[index] - 128) / 128) * gain;
        const y = height / 2 + amplitude * height * 0.5;
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.stroke();
      runtime.liveFrame = requestAnimationFrame(draw);
    };

    runtime.liveFrame = requestAnimationFrame(draw);
  }

  function containerIsLive(card) {
    return Boolean(card && card.isConnected);
  }

  function buildUploadedState(file, upload, context, showSpeedControl, label) {
    if (context && typeof context.createUploadedFileState === "function") {
      return {
        ...context.createUploadedFileState(file, upload),
        label,
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
      label,
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
        waveColor: "#332a23",
        progressColor: "#332a23",
        cursorColor: "#332a23",
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
      if (runtime.loop) {
        restartLoop(runtime);
        return;
      }
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
    audio.loop = runtime.loop;
    audio.preload = "metadata";
    audio.hidden = true;
    elements.card.appendChild(audio);
    elements.wave.dataset.fallback = "true";
    runtime.audio = audio;

    const getDuration = () => Number.isFinite(audio.duration) ? audio.duration : 0;

    audio.addEventListener("loadedmetadata", () => {
      elements.time.textContent = `0:00 / ${formatTime(getDuration())}`;
      elements.start.disabled = false;
      elements.pause.disabled = false;
      elements.stop.disabled = false;
      if (elements.speed) elements.speed.disabled = false;
    });
    audio.addEventListener("timeupdate", () => {
      elements.time.textContent = `${formatTime(audio.currentTime)} / ${formatTime(getDuration())}`;
    });
    audio.addEventListener("ended", () => {
      if (runtime.loop) restartLoop(runtime);
    });
    audio.addEventListener("error", () => {
      elements.status.textContent = "Could not load audio";
    });
  }

  function restartLoop(runtime) {
    const player = getPlayer(runtime);
    if (!player) return;
    player.stop();
    const playPromise = player.play();
    if (playPromise && typeof playPromise.catch === "function") {
      void playPromise.catch(() => {});
    }
  }

  function setLoop(runtime, elements, loop) {
    runtime.loop = loop;
    elements.loop.setAttribute("aria-pressed", loop ? "true" : "false");
    elements.loop.dataset.active = loop ? "true" : "false";

    if (runtime.audio) runtime.audio.loop = loop;
    if (!runtime.wavesurfer) return;

    if (typeof runtime.wavesurfer.getMediaElement === "function") {
      const media = runtime.wavesurfer.getMediaElement();
      if (media) media.loop = loop;
    }
    if (typeof runtime.wavesurfer.setOptions === "function") {
      try {
        runtime.wavesurfer.setOptions({ loop });
      } catch (error) {
        // WaveSurfer versions differ here; finish handling above is the fallback.
      }
    }
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
        fileName: "Audio",
        label: "Audio",
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

    getTitle(state) {
      const current = state && typeof state === "object" ? state : {};
      const label = typeof current.label === "string" && current.label.trim()
        ? current.label.trim()
        : typeof current.fileName === "string" && current.fileName.trim()
          ? current.fileName.trim()
          : "Audio";
      const status = typeof current.status === "string" ? current.status : "empty";
      if (status === "uploading") {
        const progress = Math.max(0, Math.min(100, Math.round(Number(current.progress) || 0)));
        return `Uploading ${progress}%`;
      }
      if (status === "error") return "Audio upload failed";
      return label;
    },

    render(container, state, onState, context = {}) {
      const status = typeof state.status === "string" ? state.status : "empty";
      const audioUrl = normalizeHref(state.url);
      const hasAudio = status === "uploaded" && Boolean(audioUrl);
      const showSpeedControl = state.showSpeedControl !== false;
      const fileName = typeof state.fileName === "string" && state.fileName.trim()
        ? state.fileName.trim()
        : "Audio";
      const label = typeof state.label === "string" && state.label.trim()
        ? state.label.trim()
        : state.source === "drop"
          ? fileName
          : "Audio";

      container.innerHTML = `
        <div class="rec-card">
          <div class="rec-heading">
            <span class="rec-title" data-command-interactive title="Double-click to rename"></span>
            <span class="rec-status" aria-live="polite"></span>
          </div>
          <div class="rec-wave" data-command-interactive>
            <canvas class="rec-live-wave" aria-hidden="true"></canvas>
          </div>
          <div class="rec-time"></div>
          <div class="rec-playback-actions" hidden>
            <button type="button" data-command-interactive data-action="start">Start</button>
            <button type="button" data-command-interactive data-action="stop">Stop</button>
            <button type="button" data-command-interactive data-action="pause">Pause</button>
            <button type="button" data-command-interactive data-action="loop" aria-pressed="false">Loop</button>
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
          color: #332a23;
          user-select: none;
        }
        .rec-card[data-status="error"] { border-color: #e9b9ac; }
        .rec-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 0.6em; }
        .rec-title {
          flex: 1 1 auto;
          min-width: 0;
          overflow: hidden;
          font: 500 0.54em/1.1 "Myriad Pro", "Roboto", sans-serif;
          text-overflow: ellipsis;
          white-space: nowrap;
          cursor: text;
        }
        .rec-title-input {
          flex: 1 1 auto;
          min-width: 0;
          width: 100%;
          border: 0;
          border-bottom: 0.04em solid #a79887;
          outline: 0;
          background: transparent;
          color: #332a23;
          font: 500 0.54em/1.1 "Myriad Pro", "Roboto", sans-serif;
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
        .rec-wave::after {
          content: "";
          position: absolute;
          left: 0.45em;
          right: 0.45em;
          top: 50%;
          height: 1px;
          background: #9b8d7d;
          opacity: 0.55;
        }
        .rec-wave[data-mode="recording"]::after,
        .rec-wave[data-mode="playback"]::after { display: none; }
        .rec-live-wave {
          display: none;
          width: 100%;
          height: 100%;
        }
        .rec-wave[data-mode="recording"] .rec-live-wave { display: block; }
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
        .rec-card button[data-active="true"] { background: #40342b; color: #fffaf1; }
        .rec-card button[data-active="true"]:hover:not(:disabled) { background: #332a23; }
        .rec-card button:disabled { cursor: default; opacity: 0.38; }
        .rec-card [data-action="record"] { background: #e36e54; color: white; }
        .rec-card [data-action="record"]:hover:not(:disabled) { background: #d85e45; }
      `;
      container.appendChild(style);

      const elements = {
        card: container.querySelector(".rec-card"),
        title: container.querySelector(".rec-title"),
        status: container.querySelector(".rec-status"),
        wave: container.querySelector(".rec-wave"),
        liveWave: container.querySelector(".rec-live-wave"),
        time: container.querySelector(".rec-time"),
        playbackActions: container.querySelector(".rec-playback-actions"),
        recordActions: container.querySelector(".rec-record-actions"),
        start: container.querySelector('[data-action="start"]'),
        stop: container.querySelector('[data-action="stop"]'),
        pause: container.querySelector('[data-action="pause"]'),
        loop: container.querySelector('[data-action="loop"]'),
        speed: container.querySelector('[data-action="speed"]'),
        download: container.querySelector('[data-action="download"]'),
        record: container.querySelector('[data-action="record"]'),
        recordStop: container.querySelector('[data-action="record-stop"]')
      };

      elements.card.dataset.status = status;
      elements.wave.dataset.mode = "empty";
      elements.title.textContent = label;
      elements.speed.hidden = !showSpeedControl;

      const runtime = {
        recorder: null,
        stream: null,
        wavesurfer: null,
        audio: null,
        audioContext: null,
        analyser: null,
        mediaSource: null,
        loop: false,
        liveFrame: null,
        animationFrame: null,
        uploading: false,
        discard: false
      };
      runtimes.set(container, runtime);

      elements.title.addEventListener("dblclick", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (runtime.uploading || (runtime.recorder && runtime.recorder.state !== "inactive")) return;

        const input = document.createElement("input");
        input.className = "rec-title-input";
        input.type = "text";
        input.value = label;
        input.maxLength = 120;
        input.setAttribute("data-command-interactive", "");
        elements.title.replaceWith(input);
        input.focus();
        input.select();

        let finished = false;
        const cancel = () => {
          if (finished) return;
          finished = true;
          input.replaceWith(elements.title);
        };
        const commit = () => {
          if (finished) return;
          finished = true;
          const nextLabel = input.value.trim() || "Audio";
          onState({ ...state, label: nextLabel });
        };

        input.addEventListener("blur", commit);
        input.addEventListener("keydown", (inputEvent) => {
          if (inputEvent.key === "Enter") {
            inputEvent.preventDefault();
            input.blur();
          } else if (inputEvent.key === "Escape") {
            inputEvent.preventDefault();
            cancel();
          }
        });
      });

      if (hasAudio) {
        elements.status.textContent = "Ready";
        elements.playbackActions.hidden = false;
        elements.wave.dataset.mode = "playback";
        elements.wave.replaceChildren();
        elements.start.disabled = true;
        elements.pause.disabled = true;
        elements.stop.disabled = true;
        if (showSpeedControl) elements.speed.disabled = true;

        const initializePlayer = () => {
          runtime.animationFrame = null;
          if (runtime.discard || !container.isConnected) return;
          if (!createWaveSurfer(container, audioUrl, elements, runtime)) {
            elements.wave.dataset.mode = "empty";
            elements.wave.replaceChildren();
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
        elements.loop.addEventListener("click", () => {
          setLoop(runtime, elements, !runtime.loop);
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
            stopLiveWaveform(elements, runtime);
            if (runtime.discard) return;

            const recordingType = recorder.mimeType || mimeType || "audio/webm";
            const blob = new Blob(chunks, { type: recordingType });
            if (blob.size === 0) {
              setRecordingUi(elements, false);
              elements.status.textContent = "Nothing was recorded";
              return;
            }

            runtime.uploading = true;
            elements.card.dataset.recording = "false";
            elements.record.disabled = true;
            elements.recordStop.disabled = true;
            elements.status.textContent = "Preparing MP3 0%";

            let file = null;
            try {
              const mp3Blob = await encodeMp3(
                blob,
                (progress) => {
                  if (!runtime.discard) elements.status.textContent = `Preparing MP3 ${progress}%`;
                },
                () => runtime.discard
              );
              if (runtime.discard) return;
              file = createMp3File(mp3Blob);
              if (typeof context.uploadFile !== "function") throw new Error("Audio upload is unavailable.");
              elements.status.textContent = "Uploading 0%";
              const upload = await context.uploadFile(file, (progress) => {
                if (!container.isConnected || runtime.discard) return;
                elements.status.textContent = `Uploading ${Math.round(progress)}%`;
              });
              if (!container.isConnected || runtime.discard) return;
              onState(buildUploadedState(file, upload, context, true, label));
            } catch (error) {
              if (!container.isConnected || runtime.discard) return;
              onState({
                status: "error",
                progress: 0,
                fileName: file ? file.name : "audio.mp3",
                label,
                extension: "mp3",
                mimeType: "audio/mpeg",
                bytes: file ? file.size : 0,
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
          try {
            startLiveWaveform(stream, elements, runtime);
          } catch (error) {
            elements.wave.dataset.mode = "empty";
          }
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
      stopLiveWaveform(null, runtime);
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
