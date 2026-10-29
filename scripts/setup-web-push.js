"use strict";

require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const webpush = require("web-push");

const envPath = path.join(__dirname, "..", ".env");
if (!fs.existsSync(envPath)) throw new Error("Create the project .env file before configuring phone notifications.");

const source = fs.readFileSync(envPath, "utf8");
const publicConfigured = Boolean(process.env.WEB_PUSH_PUBLIC_KEY);
const privateConfigured = Boolean(process.env.WEB_PUSH_PRIVATE_KEY);
if (publicConfigured !== privateConfigured) throw new Error("Both WEB_PUSH_PUBLIC_KEY and WEB_PUSH_PRIVATE_KEY must be set together.");
if (publicConfigured) {
  console.log("Web Push keys are already configured; kept the existing pair.");
  process.exit(0);
}

const keys = webpush.generateVAPIDKeys();
const updated = source
  .replace(/^WEB_PUSH_PUBLIC_KEY=.*$/m, `WEB_PUSH_PUBLIC_KEY=${keys.publicKey}`)
  .replace(/^WEB_PUSH_PRIVATE_KEY=.*$/m, `WEB_PUSH_PRIVATE_KEY=${keys.privateKey}`);
fs.writeFileSync(envPath, updated, { mode: 0o600 });
console.log("Generated persistent Web Push credentials in the local .env file. Key values were not displayed.");
