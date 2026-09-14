(function () {
  window.SkydiveCommands = window.SkydiveCommands || [];

  const DEFAULT_PROMPT = "gentle ambient river, warm analog synths, soft piano pulses";
  const SAMPLE_RATE = 48000;
  const CHANNELS = 2;
  const BYTES_PER_SAMPLE = 2;
  const FRAME_BYTES = CHANNELS * BYTES_PER_SAMPLE;
  const START_BUFFER_SECONDS = 2.4;
  const TARGET_BUFFER_SECONDS = 4.2;
  const MAX_BUFFER_SECONDS = 9;
  const FADE_SECONDS = 0.22;
  const RECONNECT_DELAY_MS = 450;
  const STREAM_STALL_MS = 15000;
  const runtimes = new WeakMap();

  function cleanPrompt(value) {
    const prompt = String(value || "").replace(/\s+/g, " ").trim();
    return prompt || DEFAULT_PROMPT;
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function concatBytes(left, right) {
    if (!left || !left.length) return right;
    if (!right || !right.length) return left;
    const merged = new Uint8Array(left.length + right.length);
    merged.set(left, 0);
    merged.set(right, left.length);
    return merged;
  }

  function getAudioContext(runtime) {
    if (runtime.audioContext && runtime.audioContext.state !== "closed") return runtime.audioContext;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      runtime.audioContext = null;
      return runtime.audioContext;
    }
    try {
      runtime.audioContext = new AudioContextClass({ sampleRate: SAMPLE_RATE });
    } catch (error) {
      runtime.audioContext = new AudioContextClass();
    }
    return runtime.audioContext;
  }

  function bufferedSeconds(runtime) {
    if (!runtime.audioContext) return 0;
    return Math.max(0, runtime.nextStartTime - runtime.audioContext.currentTime);
  }

  async function waitForBufferRoom(runtime, token) {
    while (runtime.playToken === token && bufferedSeconds(runtime) > MAX_BUFFER_SECONDS) {
      updateStatus(runtime);
      await wait(160);
    }
  }

  function pcmToAudioBuffer(audioContext, bytes) {
    const frameCount = Math.floor(bytes.length / FRAME_BYTES);
    const buffer = audioContext.createBuffer(CHANNELS, frameCount, SAMPLE_RATE);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    const view = new DataView(bytes.buffer, bytes.byteOffset, frameCount * FRAME_BYTES);
    for (let index = 0; index < frameCount; index += 1) {
      const offset = index * FRAME_BYTES;
      left[index] = view.getInt16(offset, true) / 32768;
      right[index] = view.getInt16(offset + BYTES_PER_SAMPLE, true) / 32768;
    }
    return buffer;
  }

  function schedulePcm(runtime, bytes) {
    const audioContext = getAudioContext(runtime);
    if (!audioContext || !bytes.length) return;
    if (!runtime.outputGain) {
      runtime.outputGain = audioContext.createGain();
      runtime.outputGain.gain.setValueAtTime(0.0001, audioContext.currentTime);
      runtime.outputGain.connect(audioContext.destination);
    }

    const audioBuffer = pcmToAudioBuffer(audioContext, bytes);
    const now = audioContext.currentTime;
    if (!runtime.nextStartTime || runtime.nextStartTime < now + START_BUFFER_SECONDS) {
      runtime.nextStartTime = now + START_BUFFER_SECONDS;
    }

    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(runtime.outputGain);
    source.start(runtime.nextStartTime);
    source.addEventListener("ended", () => source.disconnect(), { once: true });
    runtime.nextStartTime += audioBuffer.duration;

    if (!runtime.audibleAt) runtime.audibleAt = runtime.nextStartTime - audioBuffer.duration;
    runtime.outputGain.gain.cancelScheduledValues(now);
    runtime.outputGain.gain.setTargetAtTime(0.9, now, FADE_SECONDS);
  }

  function updateStatus(runtime, message) {
    if (!runtime || !runtime.status) return;
    if (message) {
      runtime.status.textContent = message;
      return;
    }
    if (!runtime.playing) {
      runtime.status.textContent = "Ready";
      return;
    }
    const buffered = bufferedSeconds(runtime);
    if (buffered < 0.25) runtime.status.textContent = "Listening for the stream...";
    else if (runtime.audioContext && runtime.audibleAt && runtime.audioContext.currentTime < runtime.audibleAt) {
      runtime.status.textContent = `Buffering ${buffered.toFixed(1)}s`;
    } else {
      runtime.status.textContent = `Playing - ${buffered.toFixed(1)}s buffered`;
    }
  }

  function startMeter(runtime) {
    if (runtime.animationFrame) return;
    const tick = () => {
      runtime.animationFrame = null;
      if (!runtime.card || !runtime.card.isConnected) return;
      const buffered = bufferedSeconds(runtime);
      runtime.bars.forEach((bar, index) => {
        const phase = performance.now() / 280 + index * 0.9;
        const energy = runtime.playing ? Math.max(0.12, Math.min(1, buffered / TARGET_BUFFER_SECONDS)) : 0.12;
        const height = 14 + Math.abs(Math.sin(phase)) * 46 * energy + Math.random() * 8 * energy;
        bar.style.blockSize = `${height.toFixed(1)}%`;
      });
      updateStatus(runtime);
      runtime.animationFrame = requestAnimationFrame(tick);
    };
    runtime.animationFrame = requestAnimationFrame(tick);
  }

  function stopMeter(runtime) {
    if (!runtime || !runtime.animationFrame) return;
    cancelAnimationFrame(runtime.animationFrame);
    runtime.animationFrame = null;
  }

  async function readStream(runtime, token, response) {
    const reader = response.body.getReader();
    let carry = runtime.carry || new Uint8Array(0);
    while (runtime.playToken === token) {
      await waitForBufferRoom(runtime, token);
      const result = await Promise.race([
        reader.read(),
        wait(STREAM_STALL_MS).then(() => ({ stalled: true }))
      ]);
      if (result.stalled) throw new Error("Stream stalled; reconnecting.");
      const { value, done } = result;
      if (done) break;
      const incoming = value instanceof Uint8Array ? value : new Uint8Array(value || []);
      const merged = concatBytes(carry, incoming);
      const alignedLength = merged.length - (merged.length % FRAME_BYTES);
      if (alignedLength > 0) {
        schedulePcm(runtime, merged.slice(0, alignedLength));
      }
      carry = merged.slice(alignedLength);
    }
    runtime.carry = carry;
    try {
      reader.releaseLock();
    } catch (error) {
      // Older readers may already be released after abort.
    }
  }

  async function streamLoop(runtime, token) {
    while (runtime.playToken === token) {
      const controller = new AbortController();
      runtime.abortController = controller;
      try {
        const url = `/api/iriver?prompt=${encodeURIComponent(runtime.prompt)}`;
        const response = await fetch(url, {
          cache: "no-store",
          signal: controller.signal
        });
        if (!response.ok || !response.body) {
          const detail = await response.text().catch(() => "");
          throw new Error(detail || `Stream failed (${response.status})`);
        }
        updateStatus(runtime, "Buffering stream...");
        await readStream(runtime, token, response);
      } catch (error) {
        if (runtime.playToken !== token || controller.signal.aborted) break;
        const message = error && error.message ? error.message.replace(/[{}"]/g, "").slice(0, 120) : "Stream interrupted";
        updateStatus(runtime, message);
        await wait(1600);
      } finally {
        if (runtime.abortController === controller) runtime.abortController = null;
      }
      if (runtime.playToken === token) await wait(RECONNECT_DELAY_MS);
    }
  }

  async function start(runtime) {
    const audioContext = getAudioContext(runtime);
    if (!audioContext) {
      updateStatus(runtime, "Web Audio is unavailable");
      return;
    }
    await audioContext.resume().catch(() => {});
    runtime.playing = true;
    runtime.playToken += 1;
    runtime.prompt = cleanPrompt(runtime.input.value);
    runtime.nextStartTime = 0;
    runtime.audibleAt = 0;
    runtime.carry = new Uint8Array(0);
    runtime.card.dataset.playing = "true";
    runtime.button.textContent = "Stop";
    runtime.input.disabled = true;
    startMeter(runtime);
    updateStatus(runtime, "Connecting...");
    void streamLoop(runtime, runtime.playToken);
  }

  function stop(runtime) {
    runtime.playToken += 1;
    runtime.playing = false;
    runtime.card.dataset.playing = "false";
    runtime.button.textContent = "Play";
    runtime.input.disabled = false;
    if (runtime.abortController) runtime.abortController.abort();
    if (runtime.outputGain && runtime.audioContext) {
      const now = runtime.audioContext.currentTime;
      runtime.outputGain.gain.cancelScheduledValues(now);
      runtime.outputGain.gain.setTargetAtTime(0.0001, now, FADE_SECONDS);
    }
    stopMeter(runtime);
    runtime.bars.forEach((bar) => {
      bar.style.blockSize = "18%";
    });
    updateStatus(runtime, "Ready");
  }

  function clearRuntime(container) {
    const runtime = runtimes.get(container);
    if (!runtime) return;
    stop(runtime);
    stopMeter(runtime);
    if (runtime.audioContext && runtime.audioContext.state !== "closed") {
      void runtime.audioContext.close().catch(() => {});
    }
    runtimes.delete(container);
  }

  window.SkydiveCommands.push({
    id: "iriver",
    aliases: ["river", "endless-radio"],
    title: "iRiver",
    description: "Stream endless prompt-based instrumental music.",
    acceptsArgs: true,

    createState(context = {}) {
      return {
        prompt: cleanPrompt(context.args)
      };
    },

    destroy(container) {
      clearRuntime(container);
    },

    getTitle(state) {
      const prompt = cleanPrompt(state && state.prompt);
      return prompt ? `iRiver ${prompt}` : "iRiver";
    },

    render(container, state, updateState) {
      clearRuntime(container);
      const prompt = cleanPrompt(state && state.prompt);
      container.innerHTML = `
        <div class="iriver-card" data-playing="false">
          <div class="iriver-head">
            <div class="iriver-title">iRiver</div>
            <div class="iriver-live" aria-hidden="true"></div>
          </div>
          <div class="iriver-meter" aria-hidden="true">
            ${Array.from({ length: 18 }).map(() => "<span></span>").join("")}
          </div>
          <textarea class="iriver-prompt" data-command-interactive spellcheck="false" rows="2" aria-label="iRiver prompt"></textarea>
          <div class="iriver-actions">
            <button class="iriver-button" type="button" data-command-interactive>Play</button>
            <div class="iriver-status" aria-live="polite">Ready</div>
          </div>
        </div>
      `;

      const style = document.createElement("style");
      style.textContent = `
        .iriver-card {
          display: grid;
          gap: 0.44em;
          width: 13.4em;
          box-sizing: border-box;
          padding: 0.58em 0.64em 0.6em;
          border: 0.04em solid var(--widget-border-color, #d8d0c4);
          border-radius: 0.55em;
          background: var(--widget-color, #fff8ef);
          color: #2e2924;
          font: 400 0.64em/1.15 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
        }

        .iriver-head,
        .iriver-actions {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.42em;
        }

        .iriver-title {
          font-size: 0.74em;
          color: #625446;
        }

        .iriver-live {
          inline-size: 0.48em;
          block-size: 0.48em;
          border-radius: 50%;
          background: #c7beb1;
        }

        .iriver-card[data-playing="true"] .iriver-live {
          background: #38a169;
          box-shadow: 0 0 0 0.18em rgba(56, 161, 105, 0.15);
        }

        .iriver-meter {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 0.08em;
          inline-size: 100%;
          block-size: 3.3em;
          box-sizing: border-box;
          padding: 0.42em;
          border: 0.04em solid rgba(54, 45, 36, 0.14);
          border-radius: 0.34em;
          background: #fffaf4;
        }

        .iriver-meter span {
          inline-size: 0.18em;
          block-size: 18%;
          min-block-size: 0.22em;
          border-radius: 999px;
          background: #2d6cdf;
          opacity: 0.72;
          transition: block-size 120ms ease;
        }

        .iriver-prompt {
          width: 100%;
          min-width: 0;
          resize: vertical;
          box-sizing: border-box;
          border: 0.04em solid var(--widget-field-border-color, #d5cabe);
          border-radius: 0.34em;
          background: var(--widget-field-color, rgba(255, 255, 255, 0.64));
          color: inherit;
          padding: 0.34em 0.42em;
          font: inherit;
        }

        .iriver-prompt:focus {
          outline: 0.08em solid rgba(45, 108, 223, 0.28);
        }

        .iriver-button {
          border: 0;
          border-radius: 0.38em;
          background: var(--widget-button-color, hsl(0 0% 91% / 44%));
          color: inherit;
          padding: 0.34em 0.62em;
          font: inherit;
        }

        .iriver-card[data-playing="true"] .iriver-button {
          color: #a13b2d;
        }

        .iriver-status {
          min-width: 0;
          color: #625446;
          text-align: right;
          font-size: 0.78em;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
      `;
      container.appendChild(style);

      const card = container.querySelector(".iriver-card");
      const input = container.querySelector(".iriver-prompt");
      const button = container.querySelector(".iriver-button");
      const status = container.querySelector(".iriver-status");
      const bars = Array.from(container.querySelectorAll(".iriver-meter span"));
      input.value = prompt;

      const runtime = {
        abortController: null,
        audioContext: null,
        audibleAt: 0,
        animationFrame: null,
        bars,
        button,
        card,
        carry: new Uint8Array(0),
        input,
        nextStartTime: 0,
        outputGain: null,
        playing: false,
        playToken: 0,
        prompt,
        status
      };
      runtimes.set(container, runtime);
      updateStatus(runtime);

      input.addEventListener("blur", () => {
        const nextPrompt = cleanPrompt(input.value);
        if (nextPrompt === prompt) return;
        updateState({
          ...state,
          prompt: nextPrompt
        });
      });
      input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || event.shiftKey) return;
        event.preventDefault();
        const nextPrompt = cleanPrompt(input.value);
        updateState({
          ...state,
          prompt: nextPrompt
        });
      });
      button.addEventListener("click", () => {
        if (runtime.playing) {
          stop(runtime);
          return;
        }
        void start(runtime);
      });
    }
  });
})();
