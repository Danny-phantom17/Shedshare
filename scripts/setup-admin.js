"use strict";

require("dotenv").config();

const bcrypt = require("bcryptjs");
const mysql = require("mysql2/promise");
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const { normalizeEmail } = require("../email-integrity");

function askHidden(question, initial = "") {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    return Promise.reject(new Error("Run this command in an interactive PowerShell or VS Code terminal so password input can stay hidden."));
  }
  return new Promise((resolve) => {
    stdout.write(question);
    let answer = initial;
    let escape = "";
    stdin.setRawMode(true);
    const onData = (chunk) => {
      const text = String(chunk);
      if (text === "\u0003" || text === "\u001b") {
        stdin.off("data", onData);
        stdin.setRawMode(false);
        stdout.write("\n");
        process.exit(130);
      }
      if (escape) {
        escape += text;
        if (escape.length === 3) {
          if (escape === "\u001b[D") answer = answer.slice(0, -1);
          escape = "";
        }
      } else if (text === "\u001b") {
        escape = text;
      } else if (text === "\r" || text === "\n") {
        stdin.off("data", onData);
        stdin.pause();
        stdin.setRawMode(false);
        stdout.write("\n");
        resolve(answer);
      } else if (text === "\u007f" || text === "\b") {
        answer = answer.slice(0, -1);
      } else {
        for (const character of text) {
          if (character >= " ") answer += character;
          else if (character === "\u0015") answer = "";
          else if (character === "\u0008" || character === "\u007f") answer = answer.slice(0, -1);
        }
      }
    };
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("This setup command is disabled in production.");
  }
  const required = ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD", "JWT_SECRET"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) throw new Error(`Missing database settings: ${missing.join(", ")}`);

  const rl = readline.createInterface({ input: stdin, output: stdout });
  let name;
  let email;
  let password;
  try {
    console.log("Create or promote a local ShedShare admin account.");
    name = (await rl.question("Full name: ")).trim();
    email = normalizeEmail(await rl.question("Email: "));
  } finally {
    rl.close();
  }

  if (!name || name.length > 120) throw new Error("Enter a name up to 120 characters.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error("Enter a valid email address.");
  password = await askHidden("Password (input hidden): ");
  if (password.length < 8 || Buffer.byteLength(password, "utf8") > 72) {
    throw new Error("Password must be 8 to 72 bytes long.");
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD
  });
  try {
    const [rows] = await connection.execute(
      "SELECT id FROM users WHERE email_normalized = ? LIMIT 1", [email]
    );
  if (rows.length) {
      const [result] = await connection.execute(
        "UPDATE users SET is_admin = TRUE, name = ?, password_hash = ?, email_verified = FALSE WHERE id = ?",
        [name, passwordHash, rows[0].id]
      );
    console.log(result.affectedRows ? "Local admin account updated. Email remains unverified because this setup command does not prove mailbox ownership." : "That account is already set up as admin.");
      return;
    }
    await connection.execute(
      `INSERT INTO users (name, phone, bank_name, account_number, email, password_hash, email_verified, is_admin)
       VALUES (?, '', '', '', ?, ?, FALSE, TRUE)`,
      [name, email, passwordHash]
    );
    console.log("Local admin account created. Email remains unverified; local authentication may sign in, but no email-verification referral can qualify.");
  } finally {
    await connection.end();
  }

}

main().catch((error) => {
  console.error("Admin setup failed:", error.message);
  process.exitCode = 1;
});
