const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(process.argv[2] || path.join(__dirname, ".."));
const registryPath = path.join(rootDir, "commands", "registry.json");
const indexPath = path.join(rootDir, "index.html");

function commandScriptPath(command) {
  const configured = typeof command.script === "string" ? command.script.trim() : "";
  return configured || `/commands/${command.id}.js`;
}

function registeredCommandIds(source) {
  return Array.from(source.matchAll(
    /window\.SkydiveCommands\.push\(\s*\{[\s\S]*?\bid\s*:\s*["']([^"']+)["']/g
  ), (match) => match[1]);
}

function checkCommandRegistry() {
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  const html = fs.readFileSync(indexPath, "utf8");
  const commands = Array.isArray(registry.commands) ? registry.commands : [];
  const problems = [];
  const allIds = new Set();

  for (const command of commands) {
    const id = command && typeof command.id === "string" ? command.id.trim() : "";
    if (!id) {
      problems.push("Registry entries must have a non-empty id.");
      continue;
    }
    if (allIds.has(id)) problems.push(`Duplicate registry id: /${id}.`);
    allIds.add(id);
  }

  // Marketplace, private, uploaded, and other runtime command sources are
  // intentionally outside this built-in asset check.
  const staticCommands = commands.filter((command) => command && command.source === "static");
  const commandById = new Map(commands.map((command) => [command.id, command]));
  const staticById = new Map(staticCommands.map((command) => [command.id, command]));
  const commandByScript = new Map(commands.map((command) => [commandScriptPath(command), command]));

  const directScripts = Array.from(html.matchAll(
    /<script\b[^>]*\bsrc=["'](\/commands\/[^"'?]+\.js)(?:\?[^"']*)?["'][^>]*><\/script>/g
  ), (match) => match[1]);

  const lazyBlockMatch = html.match(
    /const\s+LAZY_STATIC_COMMANDS\s*=\s*new\s+Map\(\[([\s\S]*?)\]\);/
  );
  const lazyBlock = lazyBlockMatch ? lazyBlockMatch[1] : "";
  const lazyEntries = Array.from(lazyBlock.matchAll(
    /\[\s*["']([^"']+)["']\s*,\s*\{[\s\S]*?\bscript\s*:\s*["'](\/commands\/[^"']+\.js)["']/g
  ), (match) => ({ id: match[1], script: match[2] }));

  const directCounts = new Map();
  let staticDirectCount = 0;
  for (const script of directScripts) {
    const command = commandByScript.get(script);
    if (!command) {
      problems.push(`Direct command loader has no registry entry: ${script}.`);
      continue;
    }
    if (command.source !== "static") continue;
    staticDirectCount += 1;
    directCounts.set(script, (directCounts.get(script) || 0) + 1);
  }

  const lazyCounts = new Map();
  for (const entry of lazyEntries) {
    lazyCounts.set(entry.id, (lazyCounts.get(entry.id) || 0) + 1);
    const command = staticById.get(entry.id);
    if (!command) {
      problems.push(`Lazy loader has no static registry entry: /${entry.id}.`);
    } else if (entry.script !== commandScriptPath(command)) {
      problems.push(`Lazy loader for /${entry.id} points to ${entry.script}.`);
    }
  }

  for (const command of staticCommands) {
    const script = commandScriptPath(command);
    const directCount = directCounts.get(script) || 0;
    const lazyCount = lazyCounts.get(command.id) || 0;
    const loaderCount = directCount + lazyCount;

    if (loaderCount === 0) problems.push(`Static command /${command.id} has no frontend loader.`);
    if (loaderCount > 1) problems.push(`Static command /${command.id} has ${loaderCount} frontend loaders.`);

    const relativeScript = script.replace(/^\//, "");
    const modulePath = path.join(rootDir, relativeScript);
    if (!fs.existsSync(modulePath)) {
      problems.push(`Static command /${command.id} is missing ${script}.`);
      continue;
    }

    const moduleSource = fs.readFileSync(modulePath, "utf8");
    const registeredIds = registeredCommandIds(moduleSource);
    const matchingRegistrations = registeredIds.filter((id) => id === command.id).length;
    if (matchingRegistrations === 0) {
      problems.push(`${script} does not register /${command.id}.`);
    } else if (matchingRegistrations > 1) {
      problems.push(`${script} registers /${command.id} ${matchingRegistrations} times.`);
    }
    for (const registeredId of registeredIds) {
      if (registeredId !== command.id) {
        problems.push(`${script} unexpectedly registers /${registeredId}.`);
      }
    }
  }

  const commandFiles = fs.readdirSync(path.join(rootDir, "commands"))
    .filter((file) => file.endsWith(".js"));
  for (const file of commandFiles) {
    const moduleSource = fs.readFileSync(path.join(rootDir, "commands", file), "utf8");
    for (const registeredId of registeredCommandIds(moduleSource)) {
      if (!commandById.has(registeredId)) {
        problems.push(`/commands/${file} registers /${registeredId} without registry metadata.`);
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`Command registry check failed:\n- ${problems.join("\n- ")}`);
  }

  console.log(
    `Command registry check passed: ${staticCommands.length} bundled static commands `
      + `(${staticDirectCount} direct, ${lazyEntries.length} lazy).`
  );
}

try {
  checkCommandRegistry();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
