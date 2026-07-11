(function () {
  window.SkydiveCommands = window.SkydiveCommands || [];

  const DEFAULT_FRETS = ["0", "0", "0", "0", "0", "0"];
  const DEFAULT_TUNING = ["E", "A", "D", "G", "B", "E"];
  const DEFAULT_OCTAVES = [3, 3, 4, 4, 4, 5];
  const NOTE_OFFSETS = {
    c: 0,
    "c#": 1,
    db: 1,
    d: 2,
    "d#": 3,
    eb: 3,
    e: 4,
    f: 5,
    "f#": 6,
    gb: 6,
    g: 7,
    "g#": 8,
    ab: 8,
    a: 9,
    "a#": 10,
    bb: 10,
    b: 11
  };
  const runtimes = new WeakMap();

  function normalizeFret(value) {
    const raw = String(value || "").trim().toLowerCase();
    if (raw === "x" || raw === "m" || raw === "-") return "x";
    if (!/^\d{1,2}$/.test(raw)) return "x";
    return String(Math.min(24, Math.max(0, Number(raw))));
  }

  function parseFrets(input) {
    const parts = String(input || "").trim().split(/\s+/).filter(Boolean);
    const frets = DEFAULT_FRETS.map((fallback, index) => normalizeFret(parts[index] || fallback));
    return frets.length === 6 ? frets : DEFAULT_FRETS.slice();
  }

  function normalizeTuningNote(value, fallback) {
    const raw = String(value || "").trim();
    const match = /^([a-gA-G])([#bB]?)(-?\d+)?$/.exec(raw);
    if (!match) return fallback;
    return `${match[1].toUpperCase()}${match[2] ? match[2].replace("B", "b") : ""}${match[3] || ""}`;
  }

  function normalizeTuning(values) {
    const source = Array.isArray(values) ? values : [];
    return DEFAULT_TUNING.map((fallback, index) => normalizeTuningNote(source[index], fallback));
  }

  function stepTuningNote(value, delta, stringIndex) {
    const note = normalizeTuningNote(value, DEFAULT_TUNING[stringIndex]);
    const midi = noteToMidi(note, stringIndex);
    if (!Number.isFinite(midi)) return note;
    const nextMidi = Math.max(0, Math.min(127, midi + delta));
    const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    return `${names[nextMidi % 12]}${Math.floor(nextMidi / 12) - 1}`;
  }

  function noteToMidi(note, stringIndex) {
    const match = /^([a-gA-G])([#bB]?)(-?\d+)?$/.exec(String(note || "").trim());
    if (!match) return null;
    const key = `${match[1].toLowerCase()}${match[2] ? match[2].toLowerCase() : ""}`;
    const offset = NOTE_OFFSETS[key];
    if (!Number.isFinite(offset)) return null;
    const octave = match[3] === undefined ? DEFAULT_OCTAVES[stringIndex] : Number(match[3]);
    return (octave + 1) * 12 + offset;
  }

  function frequencyFromMidi(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  function getPlayableStrings(state) {
    const frets = parseFrets((state && state.frets) || DEFAULT_FRETS.join(" "));
    const tuning = normalizeTuning(state && state.tuning);
    return frets.map((fret, index) => {
      if (fret === "x") return null;
      const midi = noteToMidi(tuning[index], index);
      if (!Number.isFinite(midi)) return null;
      return {
        index,
        fret,
        note: tuning[index],
        midi: midi + Number(fret),
        frequency: frequencyFromMidi(midi + Number(fret))
      };
    }).filter(Boolean);
  }

  function clearRuntime(container) {
    const runtime = runtimes.get(container);
    if (!runtime) return;
    runtime.timers.forEach((timer) => clearTimeout(timer));
    runtime.timers = [];
    runtime.stops.forEach((stop) => stop());
    runtime.stops = [];
    runtimes.delete(container);
  }

  function getAudioContext() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    return AudioContextClass ? new AudioContextClass() : null;
  }

  function playString(audioContext, frequency, delaySeconds) {
    const startAt = audioContext.currentTime + delaySeconds;
    const stopAt = startAt + 1.45;
    const output = audioContext.createGain();
    const filter = audioContext.createBiquadFilter();
    const body = audioContext.createOscillator();
    const warmth = audioContext.createOscillator();
    const bodyGain = audioContext.createGain();
    const warmthGain = audioContext.createGain();

    filter.type = "lowpass";
    filter.frequency.setValueAtTime(1650, startAt);
    filter.frequency.exponentialRampToValueAtTime(620, stopAt);
    output.gain.setValueAtTime(0.0001, startAt);
    output.gain.exponentialRampToValueAtTime(0.19, startAt + 0.018);
    output.gain.exponentialRampToValueAtTime(0.0001, stopAt);

    body.type = "triangle";
    body.frequency.setValueAtTime(frequency, startAt);
    body.detune.setValueAtTime(-2, startAt);
    warmth.type = "sine";
    warmth.frequency.setValueAtTime(frequency * 2, startAt);
    warmth.detune.setValueAtTime(3, startAt);
    bodyGain.gain.setValueAtTime(0.84, startAt);
    warmthGain.gain.setValueAtTime(0.16, startAt);

    body.connect(bodyGain).connect(filter);
    warmth.connect(warmthGain).connect(filter);
    filter.connect(output).connect(audioContext.destination);
    body.start(startAt);
    warmth.start(startAt);
    body.stop(stopAt + 0.04);
    warmth.stop(stopAt + 0.04);

    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      try {
        body.stop();
        warmth.stop();
      } catch (error) {
        // Oscillators may already have ended.
      }
      body.disconnect();
      warmth.disconnect();
      bodyGain.disconnect();
      warmthGain.disconnect();
      filter.disconnect();
      output.disconnect();
    };
    body.addEventListener("ended", stop, { once: true });
    return stop;
  }

  window.SkydiveCommands.push({
    id: "chord",
    title: "Chord",
    description: "Play a small guitar-tab chord.",
    acceptsArgs: true,

    createState(context = {}) {
      return {
        frets: parseFrets(context.args).join(" "),
        tuning: DEFAULT_TUNING.slice(),
        editing: false
      };
    },

    destroy(container) {
      clearRuntime(container);
    },

    getTitle(state) {
      return parseFrets((state && state.frets) || "").join(" ");
    },

    render(container, state, updateState) {
      clearRuntime(container);

      const frets = parseFrets((state && state.frets) || DEFAULT_FRETS.join(" "));
      const tuning = normalizeTuning(state && state.tuning);
      const editing = Boolean(state && state.editing);

      container.innerHTML = `
        <div class="chord-card" data-editing="${editing ? "true" : "false"}">
          <div class="chord-title">Chord</div>
          <div class="chord-strings" aria-label="Guitar strings"></div>
          <div class="chord-actions">
            <button class="chord-button" type="button" data-command-interactive data-action="play">Play</button>
            <button class="chord-button" type="button" data-command-interactive data-action="edit" aria-pressed="${editing ? "true" : "false"}">${editing ? "Save" : "Edit"}</button>
          </div>
        </div>
      `;

      const style = document.createElement("style");
      style.textContent = `
        .chord-card {
          display: grid;
          gap: 0.42em;
          min-width: 8.05em;
          padding: 0.55em 0.62em 0.52em;
          border: 0.04em solid #e0d2be;
          border-radius: 0.55em;
          background: #fff8ed;
          color: #3f3328;
        }

        .chord-title {
          overflow: hidden;
          color: #7b6650;
          font: 400 0.42em/1.1 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
          letter-spacing: 0;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .chord-strings {
          display: flex;
          gap: 0.22em;
          inline-size: 6.92em;
          contain: layout paint style;
        }

        .chord-string {
          display: flex;
          flex: 0 0 0.97em;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          block-size: 1.6em;
          box-sizing: border-box;
          place-items: center;
          border-radius: 0.38em;
          background: rgba(63, 51, 40, 0.07);
          transition: background 90ms ease, color 90ms ease;
        }

        .chord-card[data-editing="true"] .chord-string {
          block-size: 2.72em;
          gap: 0.13em;
          padding: 0.08em 0;
        }

        .chord-string[data-muted="true"] {
          color: #9a8772;
        }

        .chord-string[data-active="true"] {
          background: #3f3328;
          color: #fff8ed;
        }

        .chord-value,
        .chord-tuning {
          display: block;
          inline-size: 100%;
          min-inline-size: 0;
          box-sizing: border-box;
          border: 0;
          background: transparent;
          color: inherit;
          text-align: center;
          letter-spacing: 0;
          font: 400 0.72em/1 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
        }

        .chord-tuning {
          color: #76614d;
        }

        .chord-value:read-only,
        .chord-tuning:read-only {
          pointer-events: none;
        }

        .chord-card[data-editing="true"] .chord-value,
        .chord-card[data-editing="true"] .chord-tuning {
          border-radius: 0.28em;
          background: rgba(255, 255, 255, 0.45);
        }

        .chord-card[data-editing="true"] .chord-value:focus,
        .chord-card[data-editing="true"] .chord-tuning:focus {
          outline: 0.08em solid rgba(63, 51, 40, 0.25);
        }

        .chord-actions {
          display: flex;
          gap: 0.25em;
        }

        .chord-card .chord-button {
          border: 0;
          border-radius: 0.38em;
          background: #eee1cf;
          padding: 0.26em 0.42em;
          color: #4b3b2d;
          font: 400 0.45em/1 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
        }

        .chord-card .chord-button:hover {
          background: #e7d6bf;
        }
      `;
      container.appendChild(style);

      const card = container.querySelector(".chord-card");
      const strings = container.querySelector(".chord-strings");
      const runtime = { timers: [], stops: [] };
      runtimes.set(container, runtime);

      frets.forEach((fret, index) => {
        const string = document.createElement("div");
        string.className = "chord-string";
        string.dataset.index = String(index);
        string.dataset.muted = fret === "x" ? "true" : "false";

        if (editing) {
          const fretInput = document.createElement("input");
          fretInput.className = "chord-value";
          fretInput.value = fret;
          fretInput.maxLength = 2;
          fretInput.tabIndex = index + 1;
          fretInput.setAttribute("aria-label", `String ${index + 1} fret`);
          fretInput.setAttribute("data-command-interactive", "");

          const tuningInput = document.createElement("input");
          tuningInput.className = "chord-tuning";
          tuningInput.value = tuning[index];
          tuningInput.maxLength = 3;
          tuningInput.tabIndex = index + 7;
          tuningInput.setAttribute("aria-label", `String ${index + 1} tuning`);
          tuningInput.setAttribute("data-command-interactive", "");

          string.append(fretInput, tuningInput);
        } else {
          const fretText = document.createElement("span");
          fretText.className = "chord-value";
          fretText.textContent = fret;
          fretText.dataset.value = fret;
          string.appendChild(fretText);
        }

        strings.appendChild(string);
      });

      function readInputs() {
        const fretValues = Array.from(card.querySelectorAll(".chord-value")).map((element) => {
          return normalizeFret(element instanceof HTMLInputElement ? element.value : element.dataset.value || element.textContent);
        });
        const tuningValues = Array.from(card.querySelectorAll(".chord-tuning")).map((input, index) => {
          return normalizeTuningNote(input.value, DEFAULT_TUNING[index]);
        });

        return {
          frets: fretValues.join(" "),
          tuning: editing ? tuningValues : tuning
        };
      }

      function getEditableInputs() {
        return [
          ...Array.from(card.querySelectorAll(".chord-value")),
          ...Array.from(card.querySelectorAll(".chord-tuning"))
        ];
      }

      function focusInput(input) {
        if (!(input instanceof HTMLInputElement)) return;
        input.focus();
        input.select();
      }

      function moveFocus(input, delta) {
        const inputs = getEditableInputs();
        const index = inputs.indexOf(input);
        if (index === -1) return;
        focusInput(inputs[(index + delta + inputs.length) % inputs.length]);
      }

      function adjustInput(input, delta) {
        const string = input.closest(".chord-string");
        const stringIndex = string ? Number(string.dataset.index) || 0 : 0;
        if (input.classList.contains("chord-value")) {
          const current = normalizeFret(input.value);
          if (current === "x") {
            input.value = "0";
          } else {
            const next = Number(current) + delta;
            input.value = next < 0 ? "x" : String(Math.min(24, next));
          }
          if (string) string.dataset.muted = input.value === "x" ? "true" : "false";
          return;
        }

        input.value = stepTuningNote(input.value, delta, stringIndex);
      }

      function handleInputKeydown(event) {
        if (!editing || !(event.target instanceof HTMLInputElement)) return;
        const input = event.target;

        if (event.key === "Tab") {
          event.preventDefault();
          moveFocus(input, event.shiftKey ? -1 : 1);
          return;
        }

        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          moveFocus(input, event.key === "ArrowLeft" ? -1 : 1);
          return;
        }

        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          adjustInput(input, event.key === "ArrowUp" ? 1 : -1);
        }
      }

      card.addEventListener("keydown", handleInputKeydown);
      card.addEventListener("input", (event) => {
        if (!(event.target instanceof HTMLInputElement)) return;
        if (!event.target.classList.contains("chord-value")) return;
        const string = event.target.closest(".chord-string");
        if (string) string.dataset.muted = normalizeFret(event.target.value) === "x" ? "true" : "false";
      });

      function saveInputs(nextEditing) {
        updateState({
          ...state,
          ...readInputs(),
          editing: nextEditing
        });
      }

      card.querySelector('[data-action="edit"]').addEventListener("click", () => {
        saveInputs(!editing);
      });

      card.querySelector('[data-action="play"]').addEventListener("click", () => {
        const next = {
          ...state,
          ...readInputs(),
          editing
        };
        const playable = getPlayableStrings(next);
        clearRuntime(container);
        const nextRuntime = { timers: [], stops: [] };
        runtimes.set(container, nextRuntime);
        if (playable.length === 0) return;

        const audioContext = getAudioContext();
        if (!audioContext) return;
        const closeTimer = setTimeout(() => {
          void audioContext.close().catch(() => {});
        }, 2600);
        nextRuntime.timers.push(closeTimer);

        playable.forEach((string, order) => {
          const delaySeconds = order * 0.135;
          nextRuntime.stops.push(playString(audioContext, string.frequency, delaySeconds));
          const onTimer = setTimeout(() => {
            if (!container.isConnected) return;
            for (const item of card.querySelectorAll(".chord-string")) item.dataset.active = "false";
            const active = card.querySelector(`.chord-string[data-index="${string.index}"]`);
            if (active) active.dataset.active = "true";
          }, delaySeconds * 1000);
          const offTimer = setTimeout(() => {
            const active = card.querySelector(`.chord-string[data-index="${string.index}"]`);
            if (active) active.dataset.active = "false";
          }, delaySeconds * 1000 + 170);
          nextRuntime.timers.push(onTimer, offTimer);
        });
      });
    }
  });
})();
