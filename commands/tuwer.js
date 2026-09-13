(function () {
  window.SkydiveCommands = window.SkydiveCommands || [];

  const DEFAULT_FORMULA = "x=sin(y)";
  const KEYBOARD_ORDER = "1234567890-=qwertyuiop[]asdfghjkl;'\\zxcvbnm,./";
  const BASE_MIDI = 48;
  const NOTE_DURATION_SECONDS = 1.15;
  const ATTACK_SECONDS = 0.012;
  const RELEASE_SECONDS = 0.17;
  const SAMPLE_COUNT = 256;
  const GRAPH_FALLBACK_WIDTH = 220;
  const GRAPH_FALLBACK_HEIGHT = 82;
  const DEFAULT_SPEED = 1;
  const MIN_SPEED_EXPONENT = -6;
  const MAX_SPEED_EXPONENT = 2;
  const SAFE_IDENTIFIERS = new Set([
    "x", "y", "t", "phase", "pi", "e", "sin", "cos", "tan", "asin", "acos", "atan",
    "atan2", "sinh", "cosh", "tanh", "abs", "sqrt", "cbrt", "pow", "exp", "log",
    "log2", "log10", "floor", "ceil", "round", "trunc", "min", "max", "sign",
    "random", "mod", "clamp"
  ]);
  const runtimes = new WeakMap();
  const activeRuntimes = new Set();

  function clampNumber(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.min(max, Math.max(min, number));
  }

  function speedToSliderValue(speed) {
    const normalizedSpeed = clampNumber(speed, Math.pow(2, MIN_SPEED_EXPONENT), Math.pow(2, MAX_SPEED_EXPONENT));
    return clampNumber(Math.log2(normalizedSpeed), MIN_SPEED_EXPONENT, MAX_SPEED_EXPONENT);
  }

  function sliderValueToSpeed(value) {
    return Math.pow(2, clampNumber(value, MIN_SPEED_EXPONENT, MAX_SPEED_EXPONENT));
  }

  function normalizeSpeed(value) {
    return sliderValueToSpeed(speedToSliderValue(value || DEFAULT_SPEED));
  }

  function formatSpeed(speed) {
    const normalizedSpeed = normalizeSpeed(speed);
    if (normalizedSpeed < 0.1) return `${normalizedSpeed.toFixed(3)}x`;
    if (normalizedSpeed < 1) return `${normalizedSpeed.toFixed(2)}x`;
    if (normalizedSpeed < 10) return `${normalizedSpeed.toFixed(1)}x`;
    return `${normalizedSpeed.toFixed(0)}x`;
  }

  function cleanFormula(value) {
    const withoutComment = String(value || "").split("//")[0].trim();
    return withoutComment || DEFAULT_FORMULA;
  }

  function expressionFromFormula(value) {
    const formula = cleanFormula(value).replace(/\^/g, "**");
    const equalIndex = formula.indexOf("=");
    if (equalIndex === -1) return formula;
    const left = formula.slice(0, equalIndex).trim().toLowerCase();
    const right = formula.slice(equalIndex + 1).trim();
    if (/^(x|y|t|phase)$/.test(left) && right) return right;
    return formula;
  }

  function compileFormula(value) {
    const expression = expressionFromFormula(value);
    if (!/^[\w\s+\-*/%.(),<>=!?:&|^*]+$/.test(expression)) {
      throw new Error("Use numbers, x/y/t, Math names, and operators.");
    }

    const identifiers = expression.match(/[a-zA-Z_]\w*/g) || [];
    const unknown = identifiers.find((name) => !SAFE_IDENTIFIERS.has(name));
    if (unknown) throw new Error(`Unknown name: ${unknown}`);

    return new Function(
      "x",
      "y",
      "t",
      "phase",
      `"use strict";
      const pi = Math.PI;
      const e = Math.E;
      const sin = Math.sin;
      const cos = Math.cos;
      const tan = Math.tan;
      const asin = Math.asin;
      const acos = Math.acos;
      const atan = Math.atan;
      const atan2 = Math.atan2;
      const sinh = Math.sinh;
      const cosh = Math.cosh;
      const tanh = Math.tanh;
      const abs = Math.abs;
      const sqrt = Math.sqrt;
      const cbrt = Math.cbrt;
      const pow = Math.pow;
      const exp = Math.exp;
      const log = Math.log;
      const log2 = Math.log2;
      const log10 = Math.log10;
      const floor = Math.floor;
      const ceil = Math.ceil;
      const round = Math.round;
      const trunc = Math.trunc;
      const min = Math.min;
      const max = Math.max;
      const sign = Math.sign;
      const random = Math.random;
      const mod = (a, b) => ((a % b) + b) % b;
      const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
      return (${expression});`
    );
  }

  function midiToFrequency(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  function sampleWave(formula) {
    const fn = compileFormula(formula);
    const values = [];
    let maxAbs = 0;
    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      const phase = index / SAMPLE_COUNT;
      const angle = phase * Math.PI * 2;
      let value = Number(fn(angle, angle, angle, phase));
      if (!Number.isFinite(value)) value = 0;
      value = Math.max(-8, Math.min(8, value));
      values.push(value);
      maxAbs = Math.max(maxAbs, Math.abs(value));
    }
    const scale = maxAbs > 0.00001 ? 1 / maxAbs : 1;
    return values.map((value) => Math.max(-1, Math.min(1, value * scale)));
  }

  function getAudioContext(runtime) {
    if (runtime.audioContext && runtime.audioContext.state !== "closed") return runtime.audioContext;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    runtime.audioContext = AudioContextClass ? new AudioContextClass() : null;
    return runtime.audioContext;
  }

  function drawGraph(canvas, wave, playheads = []) {
    const cssWidth = Math.round(canvas.clientWidth || GRAPH_FALLBACK_WIDTH);
    const cssHeight = Math.round(canvas.clientHeight || GRAPH_FALLBACK_HEIGHT);
    const width = Math.max(1, cssWidth);
    const height = Math.max(1, cssHeight);
    const scale = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#fffaf4";
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = "rgba(54, 45, 36, 0.12)";
    ctx.lineWidth = 1;
    for (let x = 0; x <= width; x += width / 4) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();
    ctx.strokeStyle = "#2d6cdf";
    ctx.lineWidth = 2;
    ctx.beginPath();
    wave.forEach((value, index) => {
      const x = index / Math.max(1, wave.length - 1) * width;
      const y = height / 2 - value * (height * 0.38);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    playheads.forEach((playhead) => {
      const phase = Number(playhead && playhead.phase);
      if (!Number.isFinite(phase)) return;
      const normalizedPhase = phase - Math.floor(phase);
      const wavePosition = normalizedPhase * wave.length;
      const sampleIndex = Math.floor(wavePosition) % wave.length;
      const nextIndex = (sampleIndex + 1) % wave.length;
      const blend = wavePosition - Math.floor(wavePosition);
      const value = wave[sampleIndex] * (1 - blend) + wave[nextIndex] * blend;
      const x = normalizedPhase * width;
      const y = height / 2 - value * (height * 0.38);
      ctx.strokeStyle = "rgba(239, 97, 61, 0.38)";
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
      ctx.fillStyle = "#ef613d";
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255, 250, 244, 0.92)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
  }

  function getRuntimePlayheads(runtime) {
    if (!runtime || !runtime.audioContext) return [];
    return Array.from(runtime.notes.values()).map((note) => ({
      phase: (runtime.audioContext.currentTime - note.startedAt) * note.frequency * runtime.speed
    }));
  }

  function renderRuntimeGraph(runtime) {
    drawGraph(runtime.canvas, runtime.wave, getRuntimePlayheads(runtime));
  }

  function stopAnimation(runtime) {
    if (!runtime || !runtime.animationFrame) return;
    cancelAnimationFrame(runtime.animationFrame);
    runtime.animationFrame = null;
  }

  function startAnimation(runtime) {
    if (!runtime || runtime.animationFrame) return;
    const tick = () => {
      runtime.animationFrame = null;
      if (!runtime.notes.size || !runtime.card.isConnected) {
        renderRuntimeGraph(runtime);
        return;
      }
      renderRuntimeGraph(runtime);
      runtime.animationFrame = requestAnimationFrame(tick);
    };
    runtime.animationFrame = requestAnimationFrame(tick);
  }

  function stopNote(runtime, key) {
    const note = runtime.notes.get(key);
    if (!note) return;
    runtime.notes.delete(key);
    const now = note.audioContext.currentTime;
    try {
      note.gain.gain.cancelScheduledValues(now);
      note.gain.gain.setValueAtTime(Math.max(0.0001, note.gain.gain.value || 0.0001), now);
      note.gain.gain.exponentialRampToValueAtTime(0.0001, now + RELEASE_SECONDS);
      note.source.stop(now + RELEASE_SECONDS + 0.03);
    } catch (error) {
      // The source may already be stopping after a very short tap.
    }
  }

  function playNote(runtime, key, index) {
    if (runtime.notes.has(key)) return;
    const audioContext = getAudioContext(runtime);
    if (!audioContext || !runtime.wave.length) return;
    void audioContext.resume().catch(() => {});

    const frequency = midiToFrequency(BASE_MIDI + index);
    const length = Math.max(1, Math.round(audioContext.sampleRate * NOTE_DURATION_SECONDS));
    const buffer = audioContext.createBuffer(1, length, audioContext.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) {
      const phase = i * frequency / audioContext.sampleRate;
      const position = phase - Math.floor(phase);
      const wavePosition = position * runtime.wave.length;
      const a = Math.floor(wavePosition) % runtime.wave.length;
      const b = (a + 1) % runtime.wave.length;
      const blend = wavePosition - Math.floor(wavePosition);
      data[i] = (runtime.wave[a] * (1 - blend) + runtime.wave[b] * blend) * 0.34;
    }

    const source = audioContext.createBufferSource();
    const gain = audioContext.createGain();
    source.buffer = buffer;
    source.loop = true;
    source.playbackRate.setValueAtTime(runtime.speed, audioContext.currentTime);
    gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.24, audioContext.currentTime + ATTACK_SECONDS);
    source.connect(gain).connect(audioContext.destination);
    source.start();
    source.addEventListener("ended", () => {
      source.disconnect();
      gain.disconnect();
    }, { once: true });
    runtime.notes.set(key, {
      source,
      gain,
      audioContext,
      frequency,
      startedAt: audioContext.currentTime
    });
    runtime.card.dataset.playing = "true";
    runtime.activeKey.textContent = key === " " ? "Space" : key;
    renderRuntimeGraph(runtime);
    startAnimation(runtime);
  }

  function clearRuntime(container) {
    const runtime = runtimes.get(container);
    if (!runtime) return;
    runtime.notes.forEach((note, key) => stopNote(runtime, key));
    runtime.notes.clear();
    document.removeEventListener("keydown", runtime.onKeyDown, true);
    document.removeEventListener("keyup", runtime.onKeyUp, true);
    window.removeEventListener("resize", runtime.onResize);
    activeRuntimes.delete(runtime);
    stopAnimation(runtime);
    if (runtime.audioContext && runtime.audioContext.state !== "closed") {
      void runtime.audioContext.close().catch(() => {});
    }
    runtimes.delete(container);
  }

  function deactivateRuntime(runtime) {
    if (!runtime) return;
    runtime.active = false;
    activeRuntimes.delete(runtime);
    runtime.notes.forEach((note, key) => stopNote(runtime, key));
    runtime.notes.clear();
    runtime.card.dataset.active = "false";
    runtime.card.dataset.playing = "false";
    runtime.button.textContent = "Activate keyboard";
    runtime.activeKey.textContent = "";
    stopAnimation(runtime);
    renderRuntimeGraph(runtime);
  }

  function deactivateAllActiveRuntimes() {
    if (activeRuntimes.size === 0) return false;
    Array.from(activeRuntimes).forEach((runtime) => deactivateRuntime(runtime));
    return true;
  }

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!deactivateAllActiveRuntimes()) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);

  window.SkydiveCommands.push({
    id: "tuwer",
    aliases: ["graph-synth", "function-synth"],
    title: "Tuwer",
    description: "Play a graphed-function instrument from the keyboard.",
    acceptsArgs: true,

    createState(context = {}) {
      return {
        formula: cleanFormula(context.args),
        speed: DEFAULT_SPEED
      };
    },

    destroy(container) {
      clearRuntime(container);
    },

    getTitle(state) {
      const formula = cleanFormula(state && state.formula);
      return formula ? `Tuwer ${formula}` : "Tuwer";
    },

    render(container, state, updateState) {
      clearRuntime(container);
      const formula = cleanFormula(state && state.formula);
      const speed = normalizeSpeed(state && state.speed);
      let wave = [];
      let error = "";
      try {
        wave = sampleWave(formula);
      } catch (compileError) {
        error = compileError && compileError.message ? compileError.message : "Formula error";
      }

      container.innerHTML = `
        <div class="tuwer-card" data-active="false" data-playing="false">
          <div class="tuwer-head">
            <div class="tuwer-title">Tuwer</div>
            <div class="tuwer-key" aria-live="polite"></div>
          </div>
          <canvas class="tuwer-graph" aria-label="Tuwer function graph"></canvas>
          <input class="tuwer-formula" data-command-interactive spellcheck="false" aria-label="Tuwer formula">
          <label class="tuwer-speed-row">
            <span class="tuwer-speed-label">Loop speed</span>
            <input class="tuwer-speed" data-command-interactive type="range" min="${MIN_SPEED_EXPONENT}" max="${MAX_SPEED_EXPONENT}" step="0.05" aria-label="Tuwer loop speed">
            <span class="tuwer-speed-value"></span>
          </label>
          <div class="tuwer-actions">
            <button class="tuwer-button" type="button" data-command-interactive data-action="activate">Activate keyboard</button>
          </div>
          <div class="tuwer-error" aria-live="polite"></div>
        </div>
      `;

      const style = document.createElement("style");
      style.textContent = `
        .tuwer-card {
          display: grid;
          gap: 0.38em;
          width: 12.8em;
          box-sizing: border-box;
          padding: 0.55em 0.62em 0.58em;
          border: 0.04em solid var(--widget-border-color, #d8d0c4);
          border-radius: 0.55em;
          background: var(--widget-color, #fff8ef);
          color: #2e2924;
          font: 400 0.64em/1.15 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
        }

        .tuwer-head,
        .tuwer-actions,
        .tuwer-speed-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.4em;
        }

        .tuwer-title {
          font-size: 0.72em;
          color: #625446;
        }

        .tuwer-key {
          min-width: 2.4em;
          min-height: 1em;
          color: #d4502e;
          text-align: right;
          font-variant-numeric: tabular-nums;
        }

        .tuwer-graph {
          display: block;
          inline-size: 100%;
          block-size: 3.62em;
          aspect-ratio: 19 / 7;
          box-sizing: border-box;
          border: 0.04em solid rgba(54, 45, 36, 0.14);
          border-radius: 0.34em;
          background: #fffaf4;
        }

        .tuwer-formula {
          width: 100%;
          min-width: 0;
          box-sizing: border-box;
          border: 0.04em solid var(--widget-field-border-color, #d5cabe);
          border-radius: 0.34em;
          background: var(--widget-field-color, rgba(255, 255, 255, 0.64));
          color: inherit;
          padding: 0.32em 0.42em;
          font: inherit;
        }

        .tuwer-formula:focus {
          outline: 0.08em solid rgba(45, 108, 223, 0.28);
        }

        .tuwer-speed-row {
          display: grid;
          grid-template-columns: auto minmax(0, 1fr) 3.2em;
          gap: 0.34em;
          color: #625446;
          font-size: 0.78em;
        }

        .tuwer-speed-label,
        .tuwer-speed-value {
          white-space: nowrap;
        }

        .tuwer-speed-value {
          text-align: right;
          font-variant-numeric: tabular-nums;
        }

        .tuwer-speed {
          min-width: 0;
          accent-color: #2d6cdf;
        }

        .tuwer-button {
          border: 0;
          border-radius: 0.38em;
          background: var(--widget-button-color, hsl(0 0% 91% / 44%));
          color: inherit;
          padding: 0.34em 0.58em;
          font: inherit;
        }

        .tuwer-card[data-active="true"] .tuwer-button {
          color: #214b9d;
        }

        .tuwer-error {
          min-height: 1em;
          color: #b5472f;
          font-size: 0.78em;
        }
      `;
      container.appendChild(style);

      const card = container.querySelector(".tuwer-card");
      const canvas = container.querySelector(".tuwer-graph");
      const input = container.querySelector(".tuwer-formula");
      const speedInput = container.querySelector(".tuwer-speed");
      const speedValue = container.querySelector(".tuwer-speed-value");
      const button = container.querySelector('[data-action="activate"]');
      const errorNode = container.querySelector(".tuwer-error");
      const activeKey = container.querySelector(".tuwer-key");
      input.value = formula;
      speedInput.value = String(speedToSliderValue(speed));
      speedValue.textContent = formatSpeed(speed);
      errorNode.textContent = error;
      drawGraph(canvas, wave.length ? wave : [0, 0]);

      const runtime = {
        active: false,
        audioContext: null,
        animationFrame: null,
        button,
        canvas,
        card,
        activeKey,
        notes: new Map(),
        speed,
        wave,
        onKeyDown: null,
        onKeyUp: null,
        onResize: null
      };

      runtime.onKeyDown = (event) => {
        if (!runtime.active || event.metaKey || event.ctrlKey || event.altKey) return;
        if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
        const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
        const index = KEYBOARD_ORDER.indexOf(key);
        if (index === -1) return;
        event.preventDefault();
        playNote(runtime, key, index);
      };
      runtime.onKeyUp = (event) => {
        const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
        if (!runtime.notes.has(key)) return;
        event.preventDefault();
        stopNote(runtime, key);
        if (runtime.notes.size === 0) {
          runtime.card.dataset.playing = "false";
          runtime.activeKey.textContent = "";
          stopAnimation(runtime);
          renderRuntimeGraph(runtime);
        }
      };
      runtime.onResize = () => renderRuntimeGraph(runtime);

      document.addEventListener("keydown", runtime.onKeyDown, true);
      document.addEventListener("keyup", runtime.onKeyUp, true);
      window.addEventListener("resize", runtime.onResize);
      runtimes.set(container, runtime);
      requestAnimationFrame(() => {
        if (!container.isConnected || runtimes.get(container) !== runtime) return;
        renderRuntimeGraph(runtime);
      });

      input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        updateState({
          ...state,
          formula: cleanFormula(input.value)
        });
      });
      input.addEventListener("blur", () => {
        const nextFormula = cleanFormula(input.value);
        if (nextFormula === formula) return;
        updateState({
          ...state,
          formula: nextFormula
        });
      });
      speedInput.addEventListener("input", () => {
        const nextSpeed = sliderValueToSpeed(speedInput.value);
        runtime.speed = nextSpeed;
        speedValue.textContent = formatSpeed(nextSpeed);
        if (runtime.audioContext) {
          runtime.notes.forEach((note) => {
            note.source.playbackRate.setValueAtTime(nextSpeed, runtime.audioContext.currentTime);
          });
        }
        renderRuntimeGraph(runtime);
      });
      speedInput.addEventListener("change", () => {
        updateState({
          ...state,
          formula: cleanFormula(input.value),
          speed: normalizeSpeed(runtime.speed)
        });
      });
      button.addEventListener("click", () => {
        if (!runtime.wave.length) return;
        if (runtime.active) {
          deactivateRuntime(runtime);
          return;
        }
        runtime.active = true;
        activeRuntimes.add(runtime);
        card.dataset.active = "true";
        button.textContent = "Keyboard active";
      });
    }
  });
})();
