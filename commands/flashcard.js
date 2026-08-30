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
        transition: transform 800ms cubic-bezier(0.9, 0, 0.1, 1);
      }

      .flashcard-card[data-flipped="true"] .flashcard-stage {
        transform: rotate3d(0.02, 1, 0.02, 180deg);
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
        transform: rotate3d(0.02, 1, 0.02, 180deg);
      }

      .flashcard-text {
        overflow: hidden;
        min-height: 1.16em;
        color: #4b3b2d;
        font: 500 0.72em/1.16 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
        letter-spacing: 0;
        text-align: center;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        outline: none;
      }

      .flashcard-text[contenteditable="true"] {
        cursor: text;
        user-select: text;
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

  function placeCaretAtEnd(element) {
    if (!element || !document.createRange || !window.getSelection) return;
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(range);
    element.focus();
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
          <div class="flashcard-stage">
            <div class="flashcard-face flashcard-front">
              <div class="flashcard-text" data-command-interactive data-side="front"></div>
            </div>
            <div class="flashcard-face flashcard-back">
              <div class="flashcard-text" data-command-interactive data-side="back"></div>
            </div>
          </div>
          <div class="flashcard-actions">
            <button type="button" data-command-interactive data-action="flip">Flip</button>
            <button type="button" data-command-interactive data-action="edit">${editing ? "Save" : "Edit"}</button>
          </div>
        </div>
      `;

      const card = container.querySelector(".flashcard-card");
      const frontText = container.querySelector('[data-side="front"]');
      const backText = container.querySelector('[data-side="back"]');
      const activeText = flipped ? backText : frontText;
      if (frontText) frontText.textContent = front;
      if (backText) backText.textContent = back;
      if (frontText) frontText.contentEditable = editing && !flipped ? "true" : "false";
      if (backText) backText.contentEditable = editing && flipped ? "true" : "false";

      function readCurrentState(next = {}) {
        return {
          front: normalizeText(frontText && frontText.textContent, DEFAULT_FRONT),
          back: normalizeText(backText && backText.textContent, DEFAULT_BACK),
          flipped,
          editing,
          ...next
        };
      }

      container.querySelector('[data-action="flip"]').addEventListener("click", () => {
        const nextState = readCurrentState({ flipped: !flipped });
        if (card) card.dataset.flipped = nextState.flipped ? "true" : "false";
        window.setTimeout(() => updateState(nextState), 800);
      });

      container.querySelector('[data-action="edit"]').addEventListener("click", () => {
        updateState(readCurrentState({ editing: !editing }));
      });

      if (editing && activeText) {
        window.requestAnimationFrame(() => placeCaretAtEnd(activeText));
      }
    }
  });
})();
