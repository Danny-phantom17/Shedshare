# ShedShare product notes

## Implemented in this release

- Public About and FAQ pages. There is deliberately no FAQ assistant.
- Optional public testimonials: signed-in members submit with display-name consent; a ShedShare administrator approves or rejects each submission before publication.
- Optional AI listing helpers: Gemini reads a selected photo and listing details to produce a factual description draft and a separate photo-quality assessment. Only the platform admin can enable or disable these Gemini requests. Cloudinary photo cleaning is an independent, server-side, explicitly opt-in transformation that keeps the original and requires the lister to review and accept the preview.

## AI provider and privacy

Gemini is the text-and-vision provider for listing helpers only. Cloudinary photo cleaning uses standard non-generative image transformations and does not make moderation decisions or call Gemini. Cloudinary credentials remain server-side and cleaning is disabled unless explicitly configured and enabled.

## Operations and review

- Apply database migrations with `npm run migrate` before enabling testimonials.
- Keep the Gemini API key server-side. Leave the server kill switch (`AI_FEATURES_ENABLED=true`) on; Gemini requests remain off until the admin enables AI from the dashboard. Set `GEMINI_TEXT_MODEL` only when changing the default.
- Review public copy against the actual payment, delivery, support, privacy, and terms flows when those change.
- Review AI provider cost, image handling, and privacy/retention terms before turning it on for members.
