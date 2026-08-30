(function () {
  window.SkydiveCommands = window.SkydiveCommands || [];

  const STYLE_ID = "skydive-flashcard-command-style";
  const DEFAULT_FRONT = "Question";
  const DEFAULT_BACK = "Answer";

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .flashcard-card {
        display: grid;
        gap: 0.38em;
        width: 11.8em;
        max-width: 18em;
        padding: 0.45em 0.52em 0.42em;
        border: 0.04em solid #d6d6d6;
        border-radius: 0.55em;
        background: #ffffff;
        color: #3f3328;
        perspective: 42em;
        user-select: none;
      }

      .flashcard-stage {
        position: relative;
        min-height: 4.75em;
        transform-style: preserve-3d;
        transition: transform 520ms cubic-bezier(0.9, 0, 0.1, 1);
      }

      .flashcard-card[data-flipped="true"] .flashcard-stage {
        transform: rotateY(180deg);
      }

      .flashcard-face {
        position: absolute;
        inset: 0;
        display: grid;
        align-content: center;
        box-sizing: border-box;
        overflow: hidden;
        padding: 0.58em 0.62em;
        border: 0.04em solid rgba(63, 51, 40, 0.1);
        border-radius: 0.72em;
        background: var(--widget-field-color, #ffffff);
        backface-visibility: hidden;
      }

      .flashcard-back {
        transform: rotateY(180deg);
      }

      .flashcard-text {
        overflow: hidden;
        color: #4b3b2d;
        font: 500 0.72em/1.16 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
        letter-spacing: 0;
        text-align: center;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }

      .flashcard-editor {
        display: grid;
        gap: 0.3em;
      }

      .flashcard-editor[hidden] {
        display: none;
      }

      .flashcard-editor textarea {
        width: 100%;
        min-height: 3.2em;
        box-sizing: border-box;
        resize: vertical;
        border: 0.04em solid var(--widget-field-border-color, #d6d6d6);
        border-radius: 0.38em;
        background: var(--widget-field-color, #ffffff);
        padding: 0.36em 0.44em;
        color: #3f3328;
        font: 400 0.48em/1.2 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
        letter-spacing: 0;
        outline: none;
      }

      .flashcard-actions {
        display: flex;
        gap: 0.25em;
        align-items: center;
      }

      .flashcard-card button {
        border: 0;
        border-radius: 999px;
        background: var(--widget-button-color, hsl(0 0% 91% / 44%));
        padding: 0.26em 0.42em;
        color: #4b3b2d;
        font: 500 0.45em/1 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
        cursor: pointer;
      }

      .flashcard-card button:hover {
        background: var(--widget-button-hover-color, hsl(0 0% 94% / 44%));
      }

      @media (prefers-reduced-motion: reduce) {
        .flashcard-stage {
          transition: none;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function normalizeText(value, fallback) {
    const text = String(value || "").trim();
    return text || fallback;
  }

  function parseArgs(args) {
    const text = String(args || "").trim();
    if (!text) return { front: DEFAULT_FRONT, back: DEFAULT_BACK };
    const separator = text.includes("::") ? "::" : text.includes("|") ? "|" : "";
    if (!separator) return { front: text, back: DEFAULT_BACK };
    const [front, ...rest] = text.split(separator);
    return {
      front: normalizeText(front, DEFAULT_FRONT),
      back: normalizeText(rest.join(separator), DEFAULT_BACK)
    };
  }

  window.SkydiveCommands.push({
    id: "flashcard",
    aliases: ["card", "study"],
    acceptsArgs: true,
    title: "Flashcard",
    description: "Study a two-sided card.",

    createState(context = {}) {
      return {
        ...parseArgs(context.args),
        flipped: false,
        editing: false
      };
    },

    getTitle(state) {
      return normalizeText(state && state.front, DEFAULT_FRONT);
    },

    render(container, state, updateState) {
      ensureStyle();
      const front = normalizeText(state && state.front, DEFAULT_FRONT);
      const back = normalizeText(state && state.back, DEFAULT_BACK);
      const flipped = Boolean(state && state.flipped);
      const editing = Boolean(state && state.editing);

      container.innerHTML = `
        <div class="flashcard-card" data-flipped="${flipped ? "true" : "false"}" data-editing="${editing ? "true" : "false"}">
          <div class="flashcard-stage" ${editing ? "hidden" : ""}>
            <div class="flashcard-face flashcard-front">
              <div class="flashcard-text" data-role="front-text"></div>
            </div>
            <div class="flashcard-face flashcard-back">
              <div class="flashcard-text" data-role="back-text"></div>
            </div>
          </div>
          <div class="flashcard-editor" ${editing ? "" : "hidden"}>
            <textarea data-command-interactive data-field="front" aria-label="Front"></textarea>
            <textarea data-command-interactive data-field="back" aria-label="Back"></textarea>
          </div>
          <div class="flashcard-actions">
            <button type="button" data-command-interactive data-action="flip">Flip</button>
            <button type="button" data-command-interactive data-action="edit">Edit</button>
          </div>
        </div>
      `;

      const frontText = container.querySelector('[data-role="front-text"]');
      const backText = container.querySelector('[data-role="back-text"]');
      const frontInput = container.querySelector('[data-field="front"]');
      const backInput = container.querySelector('[data-field="back"]');
      if (frontText) frontText.textContent = front;
      if (backText) backText.textContent = back;
      if (frontInput) frontInput.value = front;
      if (backInput) backInput.value = back;

      function readCurrentState(next = {}) {
        return {
          front: normalizeText(frontInput && frontInput.value, DEFAULT_FRONT),
          back: normalizeText(backInput && backInput.value, DEFAULT_BACK),
          flipped,
          editing,
          ...next
        };
      }

      container.querySelector('[data-action="flip"]').addEventListener("click", () => {
        updateState(readCurrentState({ flipped: !flipped }));
      });

      container.querySelector('[data-action="edit"]').addEventListener("click", () => {
        updateState(readCurrentState({ editing: !editing }));
      });
    }
  });
})();
