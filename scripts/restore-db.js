"use strict";

require("dotenv").config();
const fs = require("node:fs/promises");
const { spawn } = require("node:child_process");

async function main() {
  const testMode = process.argv.includes("--test");
  const fileArg = process.argv.find((arg) => arg !== "--test" && !arg.startsWith("-"));
  if (!fileArg) throw new Error("Usage: npm run restore:db -- <backup.sql> [--test]");
  const backup = require("node:path").resolve(fileArg);
  const stat = await fs.stat(backup);
  if (!stat.isFile() || !backup.toLowerCase().endsWith(".sql")) throw new Error("Provide a readable .sql backup file.");
  const targetDb = testMode ? process.env.DB_RESTORE_TEST_NAME : process.env.DB_NAME;
  if (!targetDb) throw new Error(testMode ? "Set DB_RESTORE_TEST_NAME to an empty test database before using --test." : "DB_NAME is required.");
  if (testMode && targetDb === process.env.DB_NAME) throw new Error("Restore test database must differ from DB_NAME.");
  if (!process.env.DB_HOST || !process.env.DB_USER || !process.env.DB_PASSWORD) throw new Error("DB_HOST, DB_USER, and DB_PASSWORD are required.");
  if (!testMode) console.warn(`WARNING: this will replace data in database ${targetDb}.`);
  await new Promise((resolve, reject) => {
    const child = spawn(process.env.MYSQL_BIN || "mysql", ["--host", process.env.DB_HOST, "--port", String(process.env.DB_PORT || "3306"), "--user", process.env.DB_USER, targetDb], { windowsHide: true, env: { ...process.env, MYSQL_PWD: process.env.DB_PASSWORD }, stdio: ["pipe", "inherit", "inherit"] });
    const input = require("node:fs").createReadStream(backup);
    input.pipe(child.stdin);
    input.on("error", reject);
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`mysql restore exited with code ${code}`)));
  });
  console.log(`Database restore ${testMode ? "test " : ""}completed into ${targetDb}.`);
}

main().catch((error) => { console.error("Database restore failed:", error.message); process.exitCode = 1; });
