(function () {
  window.SkydiveCommands = window.SkydiveCommands || [];

  window.SkydiveCommands.push({
    id: "playback",
    title: "Playback",
    description: "Control audio and chord widgets connected by outgoing arrows.",

    createState() {
      return { loop: false };
    },

    render(container, state, updateState, context = {}) {
      const loop = Boolean(state && state.loop);
      container.innerHTML = `
        <div class="playback-card">
          <div class="playback-title">Playback</div>
          <div class="playback-actions">
            <button type="button" data-command-interactive data-action="start">Start</button>
            <button type="button" data-command-interactive data-action="stop">Stop</button>
            <button type="button" data-command-interactive data-action="pause">Pause</button>
            <button type="button" data-command-interactive data-action="loop" aria-pressed="${loop ? "true" : "false"}" data-active="${loop ? "true" : "false"}">Loop</button>
          </div>
        </div>
      `;

      const style = document.createElement("style");
      style.textContent = `
        .playback-card {
          display: grid;
          gap: 0.4em;
          min-width: 8.8em;
          padding: 0.55em 0.62em 0.58em;
          border: 0.04em solid var(--widget-border-color, #ded2c2);
          border-radius: 0.58em;
          background: var(--widget-color, #fffaf3);
          color: #40342b;
          user-select: none;
        }
        .playback-title {
          color: #7b6a58;
          font: 500 0.43em/1.1 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
        }
        .playback-actions {
          display: flex;
          gap: 0.22em;
        }
        .playback-actions button {
          flex: 1 1 auto;
          border: 0;
          border-radius: 0.38em;
          background: var(--widget-button-color, #e7dac9);
          padding: 0.32em 0.44em;
          color: inherit;
          font: 500 0.39em/1 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
          white-space: nowrap;
        }
        .playback-actions button:hover { background: var(--widget-button-hover-color, #ddcbb5); }
        .playback-actions button[data-active="true"] { background: #40342b; color: #fffaf1; }
      `;
      container.appendChild(style);

      const control = (action, value) => {
        if (typeof context.controlOutgoingPlaybackTargets !== "function") return;
        context.controlOutgoingPlaybackTargets(action, value);
      };

      container.querySelector('[data-action="start"]').addEventListener("click", () => {
        control("loop", loop);
        control("start");
      });
      container.querySelector('[data-action="stop"]').addEventListener("click", () => control("stop"));
      container.querySelector('[data-action="pause"]').addEventListener("click", () => control("pause"));
      container.querySelector('[data-action="loop"]').addEventListener("click", () => {
        const nextLoop = !loop;
        control("loop", nextLoop);
        updateState({ ...state, loop: nextLoop });
      });
    }
  });
})();
