#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const buildDir = "/tmp/ulw-qa-build";
const fixturesDir = path.join(here, "fixtures");
const tsconfigPath = "scripts/qa/tsconfig.json";
const require_ = createRequire(import.meta.url);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function compileSources() {
  fs.rmSync(buildDir, { recursive: true, force: true });
  const result = spawnSync("tsc", ["-p", tsconfigPath], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32"
  });
  if (result.error) {
    fail(`无法启动 tsc：${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`tsc 编译失败（exit ${String(result.status)}）`);
  }
}

function listFixtureFiles() {
  if (!fs.existsSync(fixturesDir)) return [];
  return fs
    .readdirSync(fixturesDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => path.join(fixturesDir, name));
}

function normalise(value) {
  if (value instanceof Set) return Array.from(value, normalise);
  if (value instanceof Map) return Array.from(value, ([key, entry]) => [normalise(key), normalise(entry)]);
  if (Array.isArray(value)) return value.map(normalise);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = normalise(value[key]);
    return out;
  }
  return value;
}

function canonical(value) {
  return JSON.stringify(normalise(value));
}

function resolveModulePath(moduleName, fixtureFile) {
  if (
    typeof moduleName !== "string" ||
    moduleName.length === 0 ||
    moduleName.includes("..") ||
    !/^[\w./-]+$/.test(moduleName)
  ) {
    throw new Error(`${path.basename(fixtureFile)}: 非法 module 名 ${JSON.stringify(moduleName)}`);
  }
  return path.join(buildDir, `${moduleName}.js`);
}

const totals = { passed: 0, failed: 0 };

function reportPass(label, caseName) {
  totals.passed += 1;
  console.log(`PASS ${label} :: ${caseName}`);
}

function reportFail(label, caseName, expected, actualDetail) {
  totals.failed += 1;
  console.log(`FAIL ${label} :: ${caseName}`);
  console.log(`  expected: ${expected}`);
  console.log(`  actual:   ${actualDetail}`);
}

function runCase(label, target, testCase, index) {
  const caseName =
    typeof testCase.name === "string" && testCase.name.trim() ? testCase.name : `case ${index + 1}`;
  const args = Array.isArray(testCase.args) ? testCase.args : [];
  const expected = canonical(testCase.expect);

  let actual;
  try {
    actual = canonical(target(...args));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reportFail(label, caseName, expected, `threw ${message}`);
    return;
  }

  if (actual === expected) {
    reportPass(label, caseName);
    return;
  }
  reportFail(label, caseName, expected, actual);
}

function runFixtureFile(fixtureFile) {
  let fixture;
  try {
    fixture = JSON.parse(fs.readFileSync(fixtureFile, "utf8"));
  } catch (error) {
    throw new Error(`${path.basename(fixtureFile)}: 无法解析 JSON（${error instanceof Error ? error.message : String(error)}）`);
  }
  if (
    fixture === null ||
    typeof fixture !== "object" ||
    typeof fixture.module !== "string" ||
    typeof fixture.export !== "string" ||
    !Array.isArray(fixture.cases)
  ) {
    throw new Error(`${path.basename(fixtureFile)}: fixture 必须包含 module/export/cases`);
  }

  const label =
    typeof fixture.name === "string" && fixture.name.trim() ? fixture.name : path.basename(fixtureFile);
  const modulePath = resolveModulePath(fixture.module, fixtureFile);
  let mod;
  try {
    mod = require_(modulePath);
  } catch (error) {
    throw new Error(
      `${path.basename(fixtureFile)}: 无法加载 ${modulePath}（${error instanceof Error ? error.message : String(error)}）`
    );
  }
  const target = mod[fixture.export];
  if (typeof target !== "function") {
    throw new Error(`${path.basename(fixtureFile)}: ${fixture.module}.${fixture.export} 不是可调用导出`);
  }

  for (let index = 0; index < fixture.cases.length; index += 1) {
    runCase(label, target, fixture.cases[index], index);
  }
}

function main() {
  compileSources();
  const fixtureFiles = listFixtureFiles();
  if (fixtureFiles.length === 0) {
    fail(`未找到任何 fixture：${fixturesDir}`);
  }
  for (const fixtureFile of fixtureFiles) {
    try {
      runFixtureFile(fixtureFile);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  const total = totals.passed + totals.failed;
  console.log(`\n汇总：${total} 个用例，通过 ${totals.passed}，失败 ${totals.failed}`);
  process.exit(totals.failed === 0 ? 0 : 1);
}

main();
