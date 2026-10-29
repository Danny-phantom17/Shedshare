"use strict";

const express = require("express");
const multer = require("multer");
const rateLimit = require("express-rate-limit");

const DESCRIPTION_DRAFT_INSTRUCTIONS = "Write one useful, specific marketplace description for this rental listing, usually 90–140 words when the supplied details and photo support it. Use seller-provided facts and describe only clearly visible details from the photo, such as type, color, shape, material, or distinguishing features. Never guess the brand, model, exact size, condition, defects, accessories, performance, availability, location, safety, or guarantees. Do not claim something is included unless the seller said so or it is unmistakably visible. If details are limited, keep the description shorter instead of padding. Return only the description as plain text. Do not draft rental conditions, cancellation terms, or any other field.";
const PROVIDERS = Object.freeze({ gemini: { label: "Gemini", key: "GEMINI_API_KEY" } });
function validImage(buffer) {
  return (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    || (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
    || (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP");
}
function imageMimeType(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  return "image/webp";
}
function providerKey(provider) { return process.env[PROVIDERS[provider]?.key] || ""; }

async function getAiControlState(pool) {
  let enabled = false;
  try {
    const [rows] = await pool.execute("SELECT enabled FROM ai_control_settings WHERE setting_id=1");
    if (rows[0]) enabled = Boolean(rows[0].enabled);
  } catch (error) {
    return { provider: "gemini", enabled: false, masterEnabled: process.env.AI_FEATURES_ENABLED !== "false", providers: {}, setupRequired: true };
  }
  const providers = Object.fromEntries(Object.entries(PROVIDERS).map(([id, meta]) => [id, { label: meta.label, configured: Boolean(providerKey(id)) }]));
  const masterEnabled = process.env.AI_FEATURES_ENABLED !== "false";
  const available = enabled && masterEnabled && Boolean(providerKey("gemini"));
  return { provider: "gemini", enabled: available, masterEnabled, providers, setupRequired: false };
}

async function providerJson(url, apiKey, body, timeout = 90_000) {
  const headers = { "content-type": "application/json" };
  if (url.includes("generativelanguage.googleapis.com")) headers["x-goog-api-key"] = apiKey;
  else headers.authorization = `Bearer ${apiKey}`;
  const retryableStatuses = new Set([408, 429, 500, 502, 503, 504]);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
    const payload = await response.json().catch(() => ({}));
    if (response.ok) return payload;
    if (retryableStatuses.has(response.status) && attempt < 2) {
      await new Promise(resolve => setTimeout(resolve, 1000 * (2 ** attempt) + Math.floor(Math.random() * 300)));
      continue;
    }
    console.error("AI provider request failed:", response.status, payload.error?.code || payload.error?.status || "provider_error");
    const error = new Error("The AI provider could not complete that request.");
    error.status = response.status;
    throw error;
  }
  throw new Error("The AI provider could not complete that request.");
}

async function generateText(instructions, input, imageDataUrl = "") {
  const parts = [{ text: `${instructions}\n\nListing details: ${JSON.stringify(input)}` }];
  if (imageDataUrl) parts.push({ inlineData: { mimeType: imageDataUrl.slice(5, imageDataUrl.indexOf(";")), data: imageDataUrl.slice(imageDataUrl.indexOf(",") + 1) } });
  const model = process.env.GEMINI_TEXT_MODEL || "gemini-3.1-flash-lite";
  const payload = await providerJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, providerKey("gemini"), { contents: [{ parts }], generationConfig: { maxOutputTokens: 360 } });
  const result = payload.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("").trim();
  if (!result) throw new Error("Gemini returned no text.");
  return result.slice(0, 1200);
}

async function generateDescriptionDraft(input, imageDataUrl = "") {
  const draft = await generateText(DESCRIPTION_DRAFT_INSTRUCTIONS, input, imageDataUrl);
  if (!draft.trim()) throw new Error("Gemini returned no description draft.");
  return draft.trim().slice(0, 1200);
}

function createAiRouter({ authenticate, pool }) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { files: 1, fileSize: 8 * 1024 * 1024 } });
  const limiter = rateLimit({ windowMs: 10 * 60_000, limit: 6, standardHeaders: "draft-8", legacyHeaders: false, keyGenerator: req => String(req.user.id), message: { error: "AI tools are busy. Try again in a few minutes." } });
  const auth = [authenticate, limiter];

  router.post("/description", ...auth, upload.single("image"), async (req, res) => {
    const control = await getAiControlState(pool);
    if (!control.enabled) return res.status(503).json({ error: "AI listing helpers are currently off." });
    const { name = "", category = "", condition = "", details = "" } = req.body || {};
    if (typeof name !== "string" || name.length > 180 || typeof details !== "string" || details.length > 2000 || (typeof category !== "string" && typeof category !== "number") || (typeof condition !== "string" && typeof condition !== "number")) return res.status(400).json({ error: "Listing details are invalid." });
    if (req.file && !validImage(req.file.buffer)) return res.status(415).json({ error: "Choose a JPEG, PNG, or WebP photo." });
    if (!req.file && !name.trim() && !details.trim()) return res.status(400).json({ error: "Choose a photo or add listing details to draft the description." });
    const input = { itemName: name.trim(), category: String(category || "").slice(0, 100), condition: String(condition || "").slice(0, 40), sellerDetails: details.trim() };
    try {
      const imageDataUrl = req.file ? `data:${imageMimeType(req.file.buffer)};base64,${req.file.buffer.toString("base64")}` : "";
      const draft = await generateDescriptionDraft(input, imageDataUrl);
      return res.json({ draft });
    }
    catch (error) {
      console.error("AI description draft failed:", error.message);
      if (error.status === 503) return res.status(503).json({ error: "Gemini is temporarily busy. Please try the description draft again shortly." });
      return res.status(502).json({ error: "Unable to create the description draft right now." });
    }
  });

  return router;
}

module.exports = { createAiRouter, getAiControlState, generateText, validImage, imageMimeType, PROVIDERS };
