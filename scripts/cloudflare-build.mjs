import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workerName = process.env.WORKER_NAME || "nodeseek-rss-reader";
const databaseName = process.env.D1_DATABASE_NAME || "nodeseek-rss-reader";
const ingestQueueName = "nodeseek-rss-reader-ingest";
const deadLetterQueueName = "nodeseek-rss-reader-ingest-dlq";
const QUEUE_READY_MAX_ATTEMPTS = 10;
const QUEUE_READY_DELAY_MS = 5000;
const generatedConfig = resolve(root, "wrangler.generated.jsonc");
const rootConfig = resolve(root, "wrangler.jsonc");

function readMode(name, fallback, allowed) {
  const raw = (process.env[name] || "").trim();
  if (!raw) return fallback;
  if (!allowed.includes(raw)) {
    throw new Error(`${name} must be one of ${allowed.join("|")} (got "${raw}")`);
  }
  return raw;
}

const ingestMode = readMode("INGEST_MODE", "inline", ["inline", "queue"]);
const htmlMode = readMode("HTML_MODE", "regex", ["regex", "rewriter"]);
const itemsPerMessage = readMode("INGEST_ITEMS_PER_MESSAGE", "5", ["1", "3", "5"]);
// Temporary cron measurement switch; off unless MEASURE_CRON is explicitly "1".
const measureCron = (process.env.MEASURE_CRON || "").trim() === "1" ? "1" : "";
// Temporary A/B/C/D CPU-stage experiment switch; off unless ABCD_EXPERIMENT is explicitly "1".
const abcdExperiment = (process.env.ABCD_EXPERIMENT || "").trim() === "1" ? "1" : "";

function commitVersion() {
  const result = spawnSync("git", ["rev-parse", "--short=7", "HEAD"], { cwd: root, encoding: "utf8" });
  const value = result.status === 0 ? result.stdout.trim() : "";
  if (!/^[0-9a-f]{7}$/i.test(value)) throw new Error("Could not determine the 7-character Git commit version");
  return value;
}

function spawnWrangler(args, { capture = true } = {}) {
  return spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["wrangler", ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit"
  });
}

function outputOf(result) {
  return `${result.stderr || ""}${result.stdout || ""}`.trim();
}

function run(args, options = {}) {
  const result = spawnWrangler(args, { capture: Boolean(options.capture) });
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

function parseDatabaseIdFromCreateOutput(output) {
  const uuid = /database_id\s*=\s*"([0-9a-f-]{32,36})"/i.exec(output)?.[1]
    || /"database_id"\s*:\s*"([0-9a-f-]{32,36})"/i.exec(output)?.[1]
    || /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(output)?.[1];
  return uuid || "";
}

function findDatabase(databases) {
  return databases.find((db) => db.name === databaseName || db.database_name === databaseName);
}

async function ensureDatabase() {
  const listOutput = run(["d1", "list", "--json"], { capture: true });
  let database = findDatabase(normalizeList(parseJsonOutput(listOutput)));
  if (!database) {
    const createOutput = run(["d1", "create", databaseName], { capture: true });
    const databaseId = parseDatabaseIdFromCreateOutput(createOutput);
    if (databaseId) return databaseId;
    const refreshedListOutput = run(["d1", "list", "--json"], { capture: true });
    database = findDatabase(normalizeList(parseJsonOutput(refreshedListOutput)));
  }
  const databaseId = getDatabaseId(database);
  if (!databaseId) throw new Error(`Could not determine D1 database_id for ${databaseName}`);
  return databaseId;
}

function queueFallbackHint(name) {
  return [
    `If this Cloudflare Workers Builds token cannot manage Queues, create the queue once with:`,
    `  npx wrangler queues create ${name}`,
    `Then redeploy. See README「自动 Queue 创建失败时」for the CLI fallback.`
  ].join("\n");
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

// Cloudflare Queue creation is eventually consistent: `queues create` can return
// before the queue is visible to the API that `wrangler deploy` uses to validate
// producer/consumer bindings, so a deploy issued right after creation can fail
// with `Queue "<name>" does not exist`. Poll `queues info` until it resolves.
async function waitForQueue(name) {
  for (let attempt = 1; attempt <= QUEUE_READY_MAX_ATTEMPTS; attempt += 1) {
    const info = spawnWrangler(["queues", "info", name]);
    const infoOutput = outputOf(info);
    if (info.status === 0) {
      console.log(`Queue ready: ${name}`);
      return;
    }
    if (!/does not exist/i.test(infoOutput)) {
      throw new Error(
        `Could not check Queue "${name}" (exit ${info.status ?? "unknown"}):\n${infoOutput || "<no output>"}\n${queueFallbackHint(name)}`
      );
    }
    if (attempt < QUEUE_READY_MAX_ATTEMPTS) {
      console.log(`Waiting for Queue "${name}" to become visible (${attempt}/${QUEUE_READY_MAX_ATTEMPTS})...`);
      await sleep(QUEUE_READY_DELAY_MS);
    }
  }
  throw new Error(
    `Queue "${name}" was created but is still not visible after ${QUEUE_READY_MAX_ATTEMPTS} checks (${QUEUE_READY_DELAY_MS / 1000}s between checks). Cloudflare Queue propagation can lag behind creation; retry the build.\n${queueFallbackHint(name)}`
  );
}

async function ensureQueue(name) {
  // wrangler 4.85.0 has no `queues list --json`; `queues info <name>` is the
  // name-filtered existence check and fails with a stable "does not exist" message.
  const info = spawnWrangler(["queues", "info", name]);
  const infoOutput = outputOf(info);
  if (info.status === 0) {
    console.log(`Queue ready: ${name}`);
    return;
  }
  if (!/does not exist/i.test(infoOutput)) {
    throw new Error(
      `Could not check Queue "${name}" (exit ${info.status ?? "unknown"}):\n${infoOutput || "<no output>"}\n${queueFallbackHint(name)}`
    );
  }
  console.log(`Creating Queue: ${name}`);
  const create = spawnWrangler(["queues", "create", name]);
  const createOutput = outputOf(create);
  if (create.status === 0) {
    console.log(`Created Queue: ${name}`);
    await waitForQueue(name);
    return;
  }
  if (/\b11009\b|already\s+(?:exists|in use|taken)/i.test(createOutput)) {
    console.log(`Queue already existed: ${name}`);
    await waitForQueue(name);
    return;
  }
  throw new Error(
    `Could not create Queue "${name}" (exit ${create.status ?? "unknown"}):\n${createOutput || "<no output>"}\n${queueFallbackHint(name)}`
  );
}

async function ensureQueues() {
  await ensureQueue(deadLetterQueueName);
  await ensureQueue(ingestQueueName);
}

function buildConfig(databaseId, version) {
  return `{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "${workerName}",
  "main": "src/index.ts",
  "compatibility_date": "2026-04-24",
  "triggers": {
    "crons": [
      "*/1 * * * *",
      "* * * * *",
      "0-59 * * * *"
    ]
  },
  "observability": {
    "enabled": true
  },
  "queues": {
    "producers": [
      {
        "binding": "INGEST_QUEUE",
        "queue": "${ingestQueueName}"
      }
    ],
    "consumers": [
      {
        "queue": "${ingestQueueName}",
        "max_batch_size": 1,
        "max_batch_timeout": 5,
        "max_retries": 5,
        "max_concurrency": 1,
        "dead_letter_queue": "${deadLetterQueueName}"
      }
    ]
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
    "COMMIT_VERSION": "${version}",
    "INGEST_MODE": "${ingestMode}",
    "INGEST_ITEMS_PER_MESSAGE": "${itemsPerMessage}",
    "HTML_MODE": "${htmlMode}",
    "MEASURE_CRON": "${measureCron}",
    "ABCD_EXPERIMENT": "${abcdExperiment}"
  }
}
`;
}

async function writeGeneratedConfig(databaseId, version) {
  const config = buildConfig(databaseId, version);
  await writeFile(generatedConfig, config, "utf8");
  await writeFile(rootConfig, config, "utf8");
}

function verifyMigratedDatabase() {
  const output = run([
    "d1",
    "execute",
    databaseName,
    "--remote",
    "--config",
    generatedConfig,
    "--command",
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('posts', 'users', 'sync_state', 'app_settings', 'admin_sessions') ORDER BY name;"
  ], { capture: true });
  for (const table of ["posts", "users", "sync_state", "app_settings", "admin_sessions"]) {
    if (!output.includes(table)) throw new Error(`D1 migration verification failed: missing table ${table}`);
  }
}

async function main() {
  console.log(`Preparing Cloudflare Worker: ${workerName}`);
  console.log(`Preparing Cloudflare D1 database: ${databaseName}`);
  console.log(`Preparing ingest Queue: ${ingestQueueName} (DLQ ${deadLetterQueueName})`);
  const version = commitVersion();
  console.log(`Commit version: ${version}`);
  const databaseId = await ensureDatabase();
  await ensureQueues();
  await writeGeneratedConfig(databaseId, version);
  console.log(`Generated ${generatedConfig}`);
  console.log(`Updated ${rootConfig} so Cloudflare deploys with DB + Queue bindings`);
  console.log(`D1 binding: DB -> ${databaseName} (${databaseId})`);
  console.log(`Queue binding: INGEST_QUEUE -> ${ingestQueueName}; DLQ -> ${deadLetterQueueName}`);
  console.log(`Ingest mode: ${ingestMode}; HTML mode: ${htmlMode}; items/message: ${itemsPerMessage}; measure cron: ${measureCron || "off"}; abcd experiment: ${abcdExperiment || "off"}`);
  run(["d1", "migrations", "apply", databaseName, "--remote", "--config", generatedConfig]);
  verifyMigratedDatabase();
  // Re-check immediately before the dry-run so the last readiness check is as
  // close as possible to the real deploy `npm run deploy` runs after this script.
  await ensureQueues();
  run(["deploy", "--dry-run", "--config", generatedConfig]);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
