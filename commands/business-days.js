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
    return String(input || "")
      .trim()
      .replace(/^(?:business\s+days?|bdays?)\s+until\s+/i, "")
      .replace(/^until\s+/i, "")
      .trim();
  }

  function startOfLocalDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  function daysBetween(fromDate, toDate) {
    const from = Date.UTC(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate());
    const to = Date.UTC(toDate.getFullYear(), toDate.getMonth(), toDate.getDate());
    return Math.round((to - from) / DAY_MS);
  }

  function businessDaysBetween(fromDate, toDate) {
    const days = daysBetween(fromDate, toDate);
    if (days <= 0) return days;

    let count = 0;
    const cursor = startOfLocalDay(fromDate);
    for (let offset = 1; offset <= days; offset += 1) {
      cursor.setDate(cursor.getDate() + 1);
      if (isBusinessDay(cursor)) count += 1;
    }
    return count;
  }

  function isBusinessDay(date) {
    const day = date.getDay();
    return day !== 0 && day !== 6;
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

  function formatBusinessDaysLeft(targetDate) {
    if (!targetDate) return "Pick a date";
    const calendarDays = daysBetween(new Date(), targetDate);
    if (calendarDays < 0) return "Date passed";
    if (calendarDays === 0) return "Today";
    const days = businessDaysBetween(new Date(), targetDate);
    return `${days} business ${days === 1 ? "day" : "days"} left`;
  }

  window.SkydiveCommands.push({
    id: "business-days",
    aliases: ["business-days-until", "business-days-left", "bdays", "workdays"],
    acceptsArgs: true,
    title: "Business Days Until",
    description: "Count weekdays until a date.",

    createState(context = {}) {
      const input = stripUntil(context.args);
      return {
        input,
        editing: false
      };
    },

    getTitle(state) {
      return formatBusinessDaysLeft(parseTargetDate(state && state.input));
    },

    render(container, state, updateState) {
      const input = stripUntil(state && state.input);
      const editing = Boolean(state && state.editing);
      const targetDate = parseTargetDate(input);

      container.innerHTML = `
        <div class="business-days-card" data-editing="${editing ? "true" : "false"}">
          <div class="business-days-label"></div>
          <div class="business-days-count" aria-live="polite"></div>
          <div class="business-days-edit-row" hidden>
            <input class="business-days-input" type="text" data-command-interactive>
          </div>
          <div class="business-days-actions">
            <button class="business-days-button" type="button" data-command-interactive data-action="edit">${editing ? "Save" : "Edit"}</button>
          </div>
        </div>
      `;

      const style = document.createElement("style");
      style.textContent = `
        .business-days-card {
          display: grid;
          gap: 0.38em;
          min-width: 7.6em;
          padding: 0.55em 0.62em 0.5em;
          border: 0.04em solid #d6d6d6;
          border-radius: 0.55em;
          background: #ffffff;
          color: #27302c;
        }

        .business-days-label {
          overflow: hidden;
          color: #64706a;
          font: 400 0.42em/1.1 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
          letter-spacing: 0;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .business-days-count {
          font: 400 0.82em/1.05 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
          letter-spacing: 0;
          white-space: nowrap;
        }

        .business-days-edit-row[hidden] {
          display: none;
        }

        .business-days-input {
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

        .business-days-input:focus {
          outline: 0.08em solid rgba(39, 48, 44, 0.22);
        }

        .business-days-actions {
          display: flex;
          gap: 0.25em;
        }

        .business-days-card .business-days-button {
          border: 0;
          border-radius: 0.38em;
          background: #e8e8e8;
          padding: 0.26em 0.42em;
          color: #27302c;
          font: 400 0.45em/1 "Myriad Pro", "Roboto", "Helvetica Neue", Arial, sans-serif;
        }

        .business-days-card .business-days-button:hover {
          background: #f0f0f0;
        }
      `;
      container.appendChild(style);

      const label = container.querySelector(".business-days-label");
      const count = container.querySelector(".business-days-count");
      const row = container.querySelector(".business-days-edit-row");
      const inputEl = container.querySelector(".business-days-input");
      const editButton = container.querySelector('[data-action="edit"]');

      label.textContent = input || "Business days until";
      count.textContent = formatBusinessDaysLeft(targetDate);
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
