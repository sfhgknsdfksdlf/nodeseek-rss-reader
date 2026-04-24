import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const databaseName = process.env.D1_DATABASE_NAME || "nodeseek-rss-reader";
const generatedConfig = resolve(root, ".wrangler/generated-wrangler.jsonc");

function run(args, options = {}) {
  const result = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["wrangler", ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit"
  });
  if (result.status !== 0) {
    const message = options.capture ? `${result.stderr || ""}${result.stdout || ""}`.trim() : "";
    throw new Error(`wrangler ${args.join(" ")} failed${message ? `:\n${message}` : ""}`);
  }
  return result.stdout || "";
}

function parseJsonOutput(output) {
  const trimmed = output.trim();
  const start = Math.min(...[trimmed.indexOf("["), trimmed.indexOf("{")].filter((index) => index >= 0));
  if (!Number.isFinite(start)) throw new Error(`Wrangler did not return JSON:\n${output}`);
  return JSON.parse(trimmed.slice(start));
}

function normalizeList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.result)) return data.result;
  if (Array.isArray(data.databases)) return data.databases;
  return [];
}

function getDatabaseId(database) {
  return database.uuid || database.id || database.database_id;
}

function findDatabase(databases) {
  return databases.find((db) => db.name === databaseName || db.database_name === databaseName);
}

async function ensureDatabase() {
  const listOutput = run(["d1", "list", "--json"], { capture: true });
  let database = findDatabase(normalizeList(parseJsonOutput(listOutput)));
  if (!database) {
    const createOutput = run(["d1", "create", databaseName, "--json"], { capture: true });
    const created = parseJsonOutput(createOutput);
    database = Array.isArray(created) ? created[0] : created.result || created;
  }
  const databaseId = getDatabaseId(database);
  if (!databaseId) throw new Error(`Could not determine D1 database_id for ${databaseName}`);
  return databaseId;
}

async function writeGeneratedConfig(databaseId) {
  const config = `{
  "$schema": "../node_modules/wrangler/config-schema.json",
  "name": "nodeseek-rss-reader",
  "main": "../src/index.ts",
  "compatibility_date": "2026-04-24",
  "triggers": {
    "crons": ["*/1 * * * *"]
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "${databaseName}",
      "database_id": "${databaseId}"
    }
  ],
  "vars": {
    "RSS_URL": "https://rss.nodeseek.com/",
    "ADMIN_USERNAME": "admin",
    "MAIL_PROVIDER": "brevo"
  }
}
`;
  await mkdir(dirname(generatedConfig), { recursive: true });
  await writeFile(generatedConfig, config, "utf8");
}

async function main() {
  console.log(`Preparing Cloudflare D1 database: ${databaseName}`);
  const databaseId = await ensureDatabase();
  await writeGeneratedConfig(databaseId);
  console.log(`Generated ${generatedConfig}`);
  run(["d1", "migrations", "apply", databaseName, "--remote"]);
  run(["deploy", "--dry-run", "--config", generatedConfig]);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
