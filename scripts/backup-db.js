"use strict";

require("dotenv").config();
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

const required = ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) throw new Error(`Missing database settings: ${missing.join(", ")}`);
const directory = path.resolve(process.env.DB_BACKUP_DIR || path.join(__dirname, "..", "backups"));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const target = path.join(directory, `${process.env.DB_NAME}-${stamp}.sql`);

async function main() {
  await fs.mkdir(directory, { recursive: true });
  const output = await fs.open(target, "wx", 0o600);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.env.MYSQLDUMP_BIN || "mysqldump", ["--host", process.env.DB_HOST, "--port", String(process.env.DB_PORT || "3306"), "--user", process.env.DB_USER, "--single-transaction", "--routines", "--triggers", "--hex-blob", "--no-tablespaces", process.env.DB_NAME], { windowsHide: true, env: { ...process.env, MYSQL_PWD: process.env.DB_PASSWORD }, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      const stream = output.createWriteStream();
      stream.on("error", reject);
      child.stdout.pipe(stream);
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) return reject(new Error(`mysqldump exited ${code}: ${stderr.slice(0, 2000)}`));
        stream.end(resolve);
      });
    });
  } catch (error) {
    await output.close();
    await fs.rm(target, { force: true });
    throw error;
  }
  await output.close();
  const files = (await fs.readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.startsWith(`${process.env.DB_NAME}-`) && entry.name.endsWith(".sql")).map((entry) => entry.name).sort().reverse();
  for (const oldFile of files.slice(7)) await fs.rm(path.join(directory, oldFile));
  console.log(`Database backup saved: ${target}`);
}

main().catch((error) => { console.error("Database backup failed:", error.message); process.exitCode = 1; });
