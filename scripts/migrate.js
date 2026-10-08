"use strict";

require("dotenv").config();

const fs = require("node:fs/promises");
const path = require("node:path");
const mysql = require("mysql2/promise");

function readPositiveInteger(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return value;
}

async function migrate() {
  const required = ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"];
  const missing = required.filter((name) => !process.env[name]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: readPositiveInteger("DB_PORT", 3306),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    multipleStatements: true
  });

  try {
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name VARCHAR(255) NOT NULL PRIMARY KEY,
        applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `);

    const migrationsDirectory = path.join(__dirname, "..", "migrations");
    const files = (await fs.readdir(migrationsDirectory))
      .filter((file) => file.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const [rows] = await connection.execute(
        "SELECT name FROM schema_migrations WHERE name = ?",
        [file]
      );

      if (rows.length > 0) {
        console.log(`Already applied: ${file}`);
        continue;
      }

      const sql = await fs.readFile(path.join(migrationsDirectory, file), "utf8");
      await connection.query(sql);
      await connection.execute(
        "INSERT INTO schema_migrations (name) VALUES (?)",
        [file]
      );
      console.log(`Applied: ${file}`);
    }
  } finally {
    await connection.end();
  }
}

migrate().catch((error) => {
  console.error("Migration failed:", error.message);
  process.exitCode = 1;
});
