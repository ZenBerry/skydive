(function () {
  window.SkydiveCommands = window.SkydiveCommands || [];

  const DAY_MS = 24 * 60 * 60 * 1000;
  const MONTHS = {
    jan: 0,
    january: 0,
    feb: 1,
    february: 1,
    mar: 2,
    march: 2,
    apr: 3,
    april: 3,
    may: 4,
    jun: 5,
    june: 5,
    jul: 6,
    july: 6,
    aug: 7,
    august: 7,
    sep: 8,
    sept: 8,
    september: 8,
    oct: 9,
    october: 9,
    nov: 10,
    november: 10,
    dec: 11,
    december: 11
  };

  function stripUntil(input) {
    return String(input || "").trim().replace(/^until\s+/i, "").trim();
  }

  function startOfLocalDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  function daysBetween(fromDate, toDate) {
    const from = Date.UTC(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate());
    const to = Date.UTC(toDate.getFullYear(), toDate.getMonth(), toDate.getDate());
    return Math.round((to - from) / DAY_MS);
  }

  function parseTargetDate(input) {
    const text = stripUntil(input);
    if (!text) return null;

    const numeric = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/.exec(text);
    if (numeric) {
      const now = new Date();
      const year = numeric[3] ? normalizeYear(numeric[3]) : now.getFullYear();
      const month = Number(numeric[1]) - 1;
      const day = Number(numeric[2]);
      if (!isExactDate(year, month, day)) return null;
      return rollForwardIfYearless(new Date(year, month, day), !numeric[3]);
    }

    const named = /^([a-z]+)\.?\s+(\d{1,2})(?:,?\s+(\d{2,4}))?$/i.exec(text);
    if (named) {
      const now = new Date();
      const month = MONTHS[named[1].toLowerCase()];
      if (!Number.isFinite(month)) return null;
      const year = named[3] ? normalizeYear(named[3]) : now.getFullYear();
      const day = Number(named[2]);
      if (!isExactDate(year, month, day)) return null;
      return rollForwardIfYearless(new Date(year, month, day), !named[3]);
    }

    const dayFirstNamed = /^(\d{1,2})\s+([a-z]+)\.?(?:,?\s+(\d{2,4}))?$/i.exec(text);
    if (dayFirstNamed) {
      const now = new Date();
      const month = MONTHS[dayFirstNamed[2].toLowerCase()];
      if (!Number.isFinite(month)) return null;
      const year = dayFirstNamed[3] ? normalizeYear(dayFirstNamed[3]) : now.getFullYear();
      const day = Number(dayFirstNamed[1]);
      if (!isExactDate(year, month, day)) return null;
      return rollForwardIfYearless(new Date(year, month, day), !dayFirstNamed[3]);
    }

    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : rollForwardIfYearless(parsed, !/\d{4}/.test(text));
  }

  function normalizeYear(value) {
    const year = Number(value);
    return year < 100 ? 2000 + year : year;
  }

  function isExactDate(year, month, day) {
    const date = new Date(year, month, day);
    return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day;
  }

  function rollForwardIfYearless(date, yearless) {
    if (Number.isNaN(date.getTime())) return null;
    const target = startOfLocalDay(date);
    if (yearless && daysBetween(new Date(), target) < 0) {
      target.setFullYear(target.getFullYear() + 1);
    }
    return target;
  }

  function formatDaysLeft(targetDate) {
    if (!targetDate) return "Pick a date";
    const days = daysBetween(new Date(), targetDate);
    if (days < 0) return "Date passed";
    if (days === 0) return "Today";
    return `${days} ${days === 1 ? "day" : "days"} left`;
  }

  window.SkydiveCommands.push({
    id: "days",
    aliases: ["days-until", "until"],
    acceptsArgs: true,
    title: "Days Until",
    description: "Count calendar days until a date.",

    createState(context = {}) {
      const input = stripUntil(context.args);
      return {
        input,
        editing: false
      };
    },

    getTitle(state) {
      return formatDaysLeft(parseTargetDate(state && state.input));
    },

    render(container, state, updateState) {
      const input = stripUntil(state && state.input);
      const editing = Boolean(state && state.editing);
      const targetDate = parseTargetDate(input);

      container.innerHTML = `
        <div class="days-card" data-editing="${editing ? "true" : "false"}">
          <div class="days-label"></div>
          <div class="days-count" aria-live="polite"></div>
          <div class="days-edit-row" hidden>
            <input class="days-input" type="text" data-command-interactive>
          </div>
          <div class="days-actions">
            <button class="days-button" type="button" data-command-interactive data-action="edit">${editing ? "Save" : "Edit"}</button>
          </div>
        </div>
      `;

      const style = document.createElement("style");
      style.textContent = `
        .days-card {
          display: grid;
          gap: 0.38em;
          min-width: 6.5em;
          padding: 0.55em 0.62em 0.5em;
          border: 0.04em solid #d6d6d6;
          border-radius: 0.55em;
          background: #ffffff;
          color: #27302c;
        }

        .days-label {
          overflow: hidden;
          color: #64706a;
          font: 400 0.42em/1.1 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
          letter-spacing: 0;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .days-count {
          font: 400 0.95em/1.05 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
          letter-spacing: 0;
          white-space: nowrap;
        }

        .days-edit-row[hidden] {
          display: none;
        }

        .days-input {
          box-sizing: border-box;
          inline-size: 100%;
          min-inline-size: 0;
          border: 0.04em solid #d6d6d6;
          border-radius: 0.32em;
          background: #ffffff;
          padding: 0.22em 0.32em;
          color: inherit;
          font: 400 0.5em/1.15 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
        }

        .days-input:focus {
          outline: 0.08em solid rgba(39, 48, 44, 0.22);
        }

        .days-actions {
          display: flex;
          gap: 0.25em;
        }

        .days-card .days-button {
          border: 0;
          border-radius: 0.38em;
          background: #e8e8e8;
          padding: 0.26em 0.42em;
          color: #27302c;
          font: 400 0.45em/1 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
        }

        .days-card .days-button:hover {
          background: #f0f0f0;
        }
      `;
      container.appendChild(style);

      const card = container.querySelector(".days-card");
      const label = container.querySelector(".days-label");
      const count = container.querySelector(".days-count");
      const row = container.querySelector(".days-edit-row");
      const inputEl = container.querySelector(".days-input");
      const editButton = container.querySelector('[data-action="edit"]');

      label.textContent = input || "Days until";
      count.textContent = formatDaysLeft(targetDate);
      row.hidden = !editing;
      inputEl.value = input;

      function save(nextEditing) {
        updateState({
          ...state,
          input: stripUntil(inputEl.value),
          editing: nextEditing
        });
      }

      editButton.addEventListener("click", () => {
        save(!editing);
      });

      inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          save(false);
        }
        if (event.key === "Escape") {
          event.preventDefault();
          updateState({ ...state, editing: false });
        }
      });

      if (editing) {
        inputEl.focus();
        inputEl.select();
      }
    }
  });
})();
