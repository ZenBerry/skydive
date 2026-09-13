(function () {
  window.SkydiveCommands = window.SkydiveCommands || [];

  const DEFAULT_FORMULA = "y=sin(x)";
  const KEYBOARD_ORDER = "1234567890-=qwertyuiop[]asdfghjkl;'\\zxcvbnm,./";
  const BASE_MIDI = 48;
  const NOTE_DURATION_SECONDS = 1.15;
  const ATTACK_SECONDS = 0.012;
  const RELEASE_SECONDS = 0.17;
  const SAMPLE_COUNT = 256;
  const GRAPH_FALLBACK_WIDTH = 220;
  const GRAPH_FALLBACK_HEIGHT = 82;
  const GRAPH_MIN_X = -Math.PI;
  const GRAPH_MAX_X = Math.PI;
  const GRAPH_MIN_Y = -Math.PI;
  const GRAPH_MAX_Y = Math.PI;
  const IMPLICIT_GRID_X = 88;
  const IMPLICIT_GRID_Y = 58;
  const IMPLICIT_JOIN_DISTANCE = Math.hypot(
    (GRAPH_MAX_X - GRAPH_MIN_X) / IMPLICIT_GRID_X,
    (GRAPH_MAX_Y - GRAPH_MIN_Y) / IMPLICIT_GRID_Y
  ) * 1.35;
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

  function compileExpression(expression) {
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

  function expressionUsesIdentifier(expression, identifier) {
    const pattern = new RegExp(`(^|[^a-zA-Z0-9_])${identifier}([^a-zA-Z0-9_]|$)`);
    return pattern.test(expression);
  }

  function parseEquation(value) {
    const formula = cleanFormula(value).replace(/\^/g, "**");
    const equalIndex = formula.indexOf("=");
    if (equalIndex === -1) {
      return {
        type: "explicit-y",
        formula,
        fn: compileExpression(formula)
      };
    }

    const left = formula.slice(0, equalIndex).trim();
    const right = formula.slice(equalIndex + 1).trim();
    if (!left || !right) throw new Error("Write both sides of the equation.");

    const normalizedLeft = left.toLowerCase();
    if (normalizedLeft === "y" && !expressionUsesIdentifier(right, "y")) {
      return {
        type: "explicit-y",
        formula,
        fn: compileExpression(right)
      };
    }
    if (normalizedLeft === "x" && !expressionUsesIdentifier(right, "x")) {
      return {
        type: "explicit-x",
        formula,
        fn: compileExpression(right)
      };
    }

    const leftFn = compileExpression(left);
    const rightFn = compileExpression(right);
    return {
      type: "implicit",
      formula,
      fn(x, y, t, phase) {
        return leftFn(x, y, t, phase) - rightFn(x, y, t, phase);
      }
    };
  }

  function evaluate(fn, x, y, t, phase) {
    const value = Number(fn(x, y, t, phase));
    return Number.isFinite(value) ? value : NaN;
  }

  function normalizeValues(values) {
    let maxAbs = 0;
    values.forEach((value) => {
      if (Number.isFinite(value)) maxAbs = Math.max(maxAbs, Math.abs(value));
    });
    const scale = maxAbs > 0.00001 ? 1 / maxAbs : 1;
    return values.map((value) => Number.isFinite(value) ? Math.max(-1, Math.min(1, value * scale)) : NaN);
  }

  function isFinitePoint(point) {
    return Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y));
  }

  function distanceBetweenPoints(a, b) {
    if (!isFinitePoint(a) || !isFinitePoint(b)) return Infinity;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function sanitizePath(path) {
    return Array.isArray(path) ? path.filter(isFinitePoint) : [];
  }

  function pathLength(path) {
    const points = sanitizePath(path);
    let length = 0;
    for (let index = 1; index < points.length; index += 1) {
      length += distanceBetweenPoints(points[index - 1], points[index]);
    }
    return length;
  }

  function samplePathPoint(path, phase) {
    const points = sanitizePath(path);
    if (points.length === 0) return { x: 0, y: 0 };
    if (points.length === 1) return points[0];
    const totalLength = pathLength(points);
    if (totalLength <= 0.000001) return points[0];
    const target = clampNumber(phase, 0, 1) * totalLength;
    let traveled = 0;
    for (let index = 1; index < points.length; index += 1) {
      const start = points[index - 1];
      const end = points[index];
      const segmentLength = distanceBetweenPoints(start, end);
      if (traveled + segmentLength >= target) {
        const mix = segmentLength > 0.000001 ? (target - traveled) / segmentLength : 0;
        return {
          x: start.x + (end.x - start.x) * mix,
          y: start.y + (end.y - start.y) * mix
        };
      }
      traveled += segmentLength;
    }
    return points[points.length - 1];
  }

  function isClosedPath(path) {
    const points = sanitizePath(path);
    if (points.length < 3) return false;
    return distanceBetweenPoints(points[0], points[points.length - 1]) <= IMPLICIT_JOIN_DISTANCE;
  }

  function sampleTracePoint(graph, phase) {
    const normalizedPhase = phase - Math.floor(phase);
    const tracePhase = graph.closed
      ? normalizedPhase
      : normalizedPhase < 0.5
        ? normalizedPhase * 2
        : (1 - normalizedPhase) * 2;
    return samplePathPoint(graph.trace, tracePhase);
  }

  function createWaveFromTrace(trace, closed) {
    const graph = { trace, closed };
    const values = [];
    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      const point = sampleTracePoint(graph, index / SAMPLE_COUNT);
      values.push(point.y);
    }
    return fillMissingValues(normalizeValues(values));
  }

  function createGraphResult(type, paths) {
    const drawablePaths = paths.map(sanitizePath).filter((path) => path.length >= 2);
    const trace = drawablePaths.slice().sort((a, b) => pathLength(b) - pathLength(a))[0] || [];
    const closed = isClosedPath(trace);
    return {
      type,
      paths: trace.length >= 2 ? [trace] : [],
      trace,
      closed,
      wave: createWaveFromTrace(trace, closed)
    };
  }

  function createExplicitYGraph(equation) {
    const points = [];
    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      const phase = index / (SAMPLE_COUNT - 1);
      const x = GRAPH_MIN_X + (GRAPH_MAX_X - GRAPH_MIN_X) * phase;
      const y = evaluate(equation.fn, x, x, x, phase);
      if (Number.isFinite(y)) points.push({ x, y });
    }
    return createGraphResult(equation.type, [points]);
  }

  function createExplicitXGraph(equation) {
    const points = [];
    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      const phase = index / (SAMPLE_COUNT - 1);
      const y = GRAPH_MIN_Y + (GRAPH_MAX_Y - GRAPH_MIN_Y) * phase;
      const x = evaluate(equation.fn, y, y, y, phase);
      if (Number.isFinite(x)) points.push({ x, y });
    }
    return createGraphResult(equation.type, [points]);
  }

  function interpolateZero(a, b) {
    const total = Math.abs(a) + Math.abs(b);
    if (total <= 0.0000001) return 0.5;
    return Math.abs(a) / total;
  }

  function midpoint(a, b) {
    return {
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2
    };
  }

  function cellSegments(corners) {
    const crossings = [];
    const edges = [
      [corners[0], corners[1]],
      [corners[1], corners[2]],
      [corners[2], corners[3]],
      [corners[3], corners[0]]
    ];

    edges.forEach(([a, b]) => {
      if (!Number.isFinite(a.value) || !Number.isFinite(b.value)) return;
      if (Math.abs(a.value) < 0.000001 && Math.abs(b.value) < 0.000001) {
        crossings.push(midpoint(a, b));
        return;
      }
      if ((a.value <= 0 && b.value >= 0) || (a.value >= 0 && b.value <= 0)) {
        const mix = interpolateZero(a.value, b.value);
        crossings.push({
          x: a.x + (b.x - a.x) * mix,
          y: a.y + (b.y - a.y) * mix
        });
      }
    });

    const finiteCrossings = crossings.filter((point) => (
      point &&
      Number.isFinite(point.x) &&
      Number.isFinite(point.y)
    ));
    const segments = [];
    for (let index = 1; index < finiteCrossings.length; index += 2) {
      segments.push([finiteCrossings[index - 1], finiteCrossings[index]]);
    }
    return segments;
  }

  function fillMissingValues(values) {
    const filled = values.slice();
    let lastFinite = 0;
    for (let index = 0; index < filled.length; index += 1) {
      if (Number.isFinite(filled[index])) {
        lastFinite = filled[index];
      } else {
        filled[index] = lastFinite;
      }
    }
    return filled;
  }

  function attachSegmentToPath(path, segment) {
    const first = path[0];
    const last = path[path.length - 1];
    const a = segment[0];
    const b = segment[1];
    const options = [
      { distance: distanceBetweenPoints(last, a), apply: () => path.push(b) },
      { distance: distanceBetweenPoints(last, b), apply: () => path.push(a) },
      { distance: distanceBetweenPoints(first, b), apply: () => path.unshift(a) },
      { distance: distanceBetweenPoints(first, a), apply: () => path.unshift(b) }
    ].sort((left, right) => left.distance - right.distance);

    if (options[0].distance > IMPLICIT_JOIN_DISTANCE) return false;
    options[0].apply();
    return true;
  }

  function connectSegments(segments) {
    const remaining = segments
      .map(sanitizePath)
      .filter((segment) => segment.length === 2);
    const paths = [];

    while (remaining.length) {
      const path = remaining.pop().slice();
      let extended = true;
      while (extended) {
        extended = false;
        for (let index = remaining.length - 1; index >= 0; index -= 1) {
          if (!attachSegmentToPath(path, remaining[index])) continue;
          remaining.splice(index, 1);
          extended = true;
        }
      }
      paths.push(path);
    }

    return paths.sort((a, b) => pathLength(b) - pathLength(a));
  }

  function createImplicitGraph(equation) {
    const segments = [];
    const grid = [];
    for (let yIndex = 0; yIndex <= IMPLICIT_GRID_Y; yIndex += 1) {
      const row = [];
      const y = GRAPH_MIN_Y + (GRAPH_MAX_Y - GRAPH_MIN_Y) * yIndex / IMPLICIT_GRID_Y;
      for (let xIndex = 0; xIndex <= IMPLICIT_GRID_X; xIndex += 1) {
        const x = GRAPH_MIN_X + (GRAPH_MAX_X - GRAPH_MIN_X) * xIndex / IMPLICIT_GRID_X;
        row.push({
          x,
          y,
          value: evaluate(equation.fn, x, y, x, xIndex / IMPLICIT_GRID_X)
        });
      }
      grid.push(row);
    }

    for (let yIndex = 0; yIndex < IMPLICIT_GRID_Y; yIndex += 1) {
      for (let xIndex = 0; xIndex < IMPLICIT_GRID_X; xIndex += 1) {
        const corners = [
          grid[yIndex][xIndex],
          grid[yIndex][xIndex + 1],
          grid[yIndex + 1][xIndex + 1],
          grid[yIndex + 1][xIndex]
        ];
        segments.push(...cellSegments(corners));
      }
    }

    return createGraphResult(equation.type, connectSegments(segments));
  }

  function createGraph(formula) {
    const equation = parseEquation(formula);
    if (equation.type === "explicit-x") return createExplicitXGraph(equation);
    if (equation.type === "implicit") return createImplicitGraph(equation);
    return createExplicitYGraph(equation);
  }

  function midiToFrequency(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  function graphToCanvas(point, width, height) {
    return {
      x: (point.x - GRAPH_MIN_X) / (GRAPH_MAX_X - GRAPH_MIN_X) * width,
      y: height - (point.y - GRAPH_MIN_Y) / (GRAPH_MAX_Y - GRAPH_MIN_Y) * height
    };
  }

  function drawGrid(ctx, width, height) {
    ctx.strokeStyle = "rgba(54, 45, 36, 0.12)";
    ctx.lineWidth = 1;
    for (let index = 0; index <= 4; index += 1) {
      const x = index / 4 * width;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let index = 0; index <= 4; index += 1) {
      const y = index / 4 * height;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(54, 45, 36, 0.28)";
    ctx.beginPath();
    ctx.moveTo(width / 2, 0);
    ctx.lineTo(width / 2, height);
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();
  }

  function drawGraph(canvas, graph, playheads = []) {
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
    drawGrid(ctx, width, height);

    ctx.strokeStyle = "#7b4fe0";
    ctx.lineWidth = 1.8;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    graph.paths.forEach((path) => {
      if (!Array.isArray(path) || path.length < 2) return;
      const drawablePath = path.filter((point) => (
        point &&
        Number.isFinite(point.x) &&
        Number.isFinite(point.y)
      ));
      if (drawablePath.length < 2) return;
      ctx.beginPath();
      drawablePath.forEach((point, index) => {
        const canvasPoint = graphToCanvas(point, width, height);
        if (index === 0) ctx.moveTo(canvasPoint.x, canvasPoint.y);
        else ctx.lineTo(canvasPoint.x, canvasPoint.y);
      });
      ctx.stroke();
    });

    playheads.forEach((playhead) => {
      const phase = Number(playhead && playhead.phase);
      if (!Number.isFinite(phase)) return;
      const point = sampleTracePoint(graph, phase);
      const canvasPoint = graphToCanvas(point, width, height);
      ctx.strokeStyle = "rgba(239, 97, 61, 0.38)";
      ctx.beginPath();
      ctx.moveTo(canvasPoint.x, 0);
      ctx.lineTo(canvasPoint.x, height);
      ctx.stroke();
      ctx.fillStyle = "#ef613d";
      ctx.beginPath();
      ctx.arc(canvasPoint.x, canvasPoint.y, 4, 0, Math.PI * 2);
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
    drawGraph(runtime.canvas, runtime.graph, getRuntimePlayheads(runtime));
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

  function getAudioContext(runtime) {
    if (runtime.audioContext && runtime.audioContext.state !== "closed") return runtime.audioContext;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    runtime.audioContext = AudioContextClass ? new AudioContextClass() : null;
    return runtime.audioContext;
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
    const wave = runtime.graph.wave;
    if (!audioContext || !wave.length) return;
    void audioContext.resume().catch(() => {});

    const frequency = midiToFrequency(BASE_MIDI + index);
    const length = Math.max(1, Math.round(audioContext.sampleRate * NOTE_DURATION_SECONDS));
    const buffer = audioContext.createBuffer(1, length, audioContext.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) {
      const phase = i * frequency / audioContext.sampleRate;
      const position = phase - Math.floor(phase);
      const wavePosition = position * wave.length;
      const a = Math.floor(wavePosition) % wave.length;
      const b = (a + 1) % wave.length;
      const blend = wavePosition - Math.floor(wavePosition);
      data[i] = (wave[a] * (1 - blend) + wave[b] * blend) * 0.34;
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
    id: "twimla",
    aliases: ["graph-trace", "path-synth"],
    title: "Twimla",
    description: "Play traced equation paths from the keyboard.",
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
      return formula ? `Twimla ${formula}` : "Twimla";
    },

    render(container, state, updateState) {
      clearRuntime(container);
      const formula = cleanFormula(state && state.formula);
      const speed = normalizeSpeed(state && state.speed);
      let graph = { type: "explicit-y", paths: [], wave: [0, 0] };
      let error = "";
      try {
        graph = createGraph(formula);
      } catch (compileError) {
        error = compileError && compileError.message ? compileError.message : "Equation error";
      }

      container.innerHTML = `
        <div class="twimla-card" data-active="false" data-playing="false">
          <div class="twimla-head">
            <div class="twimla-title">Twimla</div>
            <div class="twimla-mode" aria-live="polite">${graph.type === "implicit" ? "implicit" : graph.type === "explicit-x" ? "x=f(y)" : "y=f(x)"}</div>
            <div class="twimla-key" aria-live="polite"></div>
          </div>
          <canvas class="twimla-graph" aria-label="Twimla equation graph"></canvas>
          <input class="twimla-formula" data-command-interactive spellcheck="false" aria-label="Twimla equation">
          <label class="twimla-speed-row">
            <span class="twimla-speed-label">Loop speed</span>
            <input class="twimla-speed" data-command-interactive type="range" min="${MIN_SPEED_EXPONENT}" max="${MAX_SPEED_EXPONENT}" step="0.05" aria-label="Twimla loop speed">
            <span class="twimla-speed-value"></span>
          </label>
          <div class="twimla-actions">
            <button class="twimla-button" type="button" data-command-interactive data-action="activate">Activate keyboard</button>
          </div>
          <div class="twimla-error" aria-live="polite"></div>
        </div>
      `;

      const style = document.createElement("style");
      style.textContent = `
        .twimla-card {
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

        .twimla-head,
        .twimla-actions,
        .twimla-speed-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.4em;
        }

        .twimla-title {
          font-size: 0.72em;
          color: #625446;
        }

        .twimla-mode {
          margin-left: auto;
          color: #7b4fe0;
          font-size: 0.68em;
          white-space: nowrap;
        }

        .twimla-key {
          min-width: 2.4em;
          min-height: 1em;
          color: #d4502e;
          text-align: right;
          font-variant-numeric: tabular-nums;
        }

        .twimla-graph {
          display: block;
          inline-size: 100%;
          block-size: 3.62em;
          aspect-ratio: 19 / 7;
          box-sizing: border-box;
          border: 0.04em solid rgba(54, 45, 36, 0.14);
          border-radius: 0.34em;
          background: #fffaf4;
        }

        .twimla-formula {
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

        .twimla-formula:focus {
          outline: 0.08em solid rgba(123, 79, 224, 0.28);
        }

        .twimla-speed-row {
          display: grid;
          grid-template-columns: auto minmax(0, 1fr) 3.2em;
          gap: 0.34em;
          color: #625446;
          font-size: 0.78em;
        }

        .twimla-speed-label,
        .twimla-speed-value {
          white-space: nowrap;
        }

        .twimla-speed-value {
          text-align: right;
          font-variant-numeric: tabular-nums;
        }

        .twimla-speed {
          min-width: 0;
          accent-color: #7b4fe0;
        }

        .twimla-button {
          border: 0;
          border-radius: 0.38em;
          background: var(--widget-button-color, hsl(0 0% 91% / 44%));
          color: inherit;
          padding: 0.34em 0.58em;
          font: inherit;
        }

        .twimla-card[data-active="true"] .twimla-button {
          color: #5b38ac;
        }

        .twimla-error {
          min-height: 1em;
          color: #b5472f;
          font-size: 0.78em;
        }
      `;
      container.appendChild(style);

      const card = container.querySelector(".twimla-card");
      const canvas = container.querySelector(".twimla-graph");
      const input = container.querySelector(".twimla-formula");
      const speedInput = container.querySelector(".twimla-speed");
      const speedValue = container.querySelector(".twimla-speed-value");
      const button = container.querySelector('[data-action="activate"]');
      const errorNode = container.querySelector(".twimla-error");
      const activeKey = container.querySelector(".twimla-key");
      input.value = formula;
      speedInput.value = String(speedToSliderValue(speed));
      speedValue.textContent = formatSpeed(speed);
      errorNode.textContent = error;
      drawGraph(canvas, graph);

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
        graph,
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
        if (!runtime.graph.wave.length) return;
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
