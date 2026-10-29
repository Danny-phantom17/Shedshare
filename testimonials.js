"use strict";

const express = require("express");
const rateLimit = require("express-rate-limit");
const { z } = require("zod");

function createTestimonialsRouter({ pool, authenticate }) {
  const router = express.Router();
  const limiter = rateLimit({ windowMs: 60 * 60_000, limit: 3, standardHeaders: "draft-8", legacyHeaders: false, keyGenerator: req => String(req.user.id), message: { error: "You have submitted several testimonials recently. Try again later." } });
  router.get("/testimonials", async (_req, res) => {
    try {
      const [rows] = await pool.execute("SELECT id,display_name,body,created_at FROM testimonials WHERE status='approved' AND consent_public=TRUE ORDER BY reviewed_at DESC,id DESC LIMIT 30");
      return res.json(rows.map(row => ({ id: String(row.id), displayName: row.display_name, body: row.body, createdAt: new Date(row.created_at).toISOString() })));
    } catch (error) { console.error("Loading testimonials failed:", error.message); return res.status(500).json({ error: "Unable to load testimonials." }); }
  });
  router.post("/testimonials", authenticate, limiter, async (req, res) => {
    const parsed = z.object({ displayName: z.string().trim().min(1).max(80), body: z.string().trim().min(20).max(700), consentPublic: z.literal(true) }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Enter a review of at least 20 characters and agree before it can be considered for public display." });
    try {
      const [result] = await pool.execute("INSERT INTO testimonials(user_id,display_name,body,consent_public,status) VALUES(?,?,?,TRUE,'pending')", [req.user.id, parsed.data.displayName, parsed.data.body]);
      return res.status(201).json({ id: String(result.insertId), status: "pending", message: "Thank you. Your testimonial will be reviewed before it appears publicly." });
    } catch (error) { console.error("Submitting testimonial failed:", error.message); return res.status(500).json({ error: "Unable to submit your testimonial." }); }
  });
  return router;
}

module.exports = { createTestimonialsRouter };
