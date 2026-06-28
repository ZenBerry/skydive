(function () {
  window.SkydiveCommands = window.SkydiveCommands || [];

  const DATE_FORMATTER = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric"
  });

  window.SkydiveCommands.push({
    id: "today",
    aliases: ["date"],
    title: "Today",
    description: "Insert today's date.",
    output: "text",

    createText() {
      return DATE_FORMATTER.format(new Date());
    }
  });
})();
