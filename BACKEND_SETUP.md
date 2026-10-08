# ShedShare backend setup

The backend uses the existing MySQL 8 schema for relational data, Supabase Auth for signup verification and Google-linked accounts, Supabase Storage for item images/videos, and Paystack for verified rent payments. Supabase's service-role key and Paystack secret stay on the API server.

## Local API

1. Install Node.js 18 or newer and MySQL 8.
2. Create a database and least-privilege application user. Copy `.env.example` to `.env` and enter real credentials. Generate a random `JWT_SECRET` with at least 32 characters.
3. In Supabase, create a project, copy its project URL, anon key, and **service role** key into `.env`, enable email confirmations, configure the SMTP provider and allowed redirect URL, and create a public Storage bucket named `shedshare-media` (or set `SUPABASE_STORAGE_BUCKET`). Supabase Auth sends the confirmation link; Gmail can be used as the custom SMTP sender if Google Workspace/Gmail SMTP credentials and app-password policies are set up. A normal Gmail address/password is not sufficient for SMTP.
4. Configure `EMAIL_VERIFICATION_REDIRECT_URL` as the deployed ShedShare frontend URL. Add it to Supabase Auth's allowed redirect URLs and keep Supabase's confirmation template configured to return either a `token_hash` or a confirmed session access token in the URL hash; ShedShare verifies either form server-side before allowing login.
5. In Google Cloud Console, create a Web OAuth client. Add its origin to Authorized JavaScript origins and set the matching client ID in both `script.js` (`GOOGLE_CLIENT_ID`) and server `.env`.
6. In Paystack, complete business verification and platform onboarding. Authenticated owners must call `POST /api/auth/paystack/subaccount` to resolve their bank from Paystack's live bank list, verify their account number, and create the payout subaccount. Do not store card data. Add the webhook URL `https://<api-domain>/api/payments/paystack/webhook` in Paystack.
7. Install packages with `npm install`, apply migrations with `npm run migrate`, then start with `npm start`.
8. Set `API_BASE` in `script.js` to the deployed API origin. API-backed rental checkout always uses server-created Paystack initialization and webhook confirmation. When `API_BASE` is empty, the preview does not accept or mark rental payments as paid.
9. Set `ALLOWED_ORIGINS` to the exact frontend origin (no path) and `TRUST_PROXY_HOPS` to the number of trusted reverse proxies. Production refuses to start without the critical provider keys and origin list.
10. After production is reachable, call `GET /api/health`; it returns 503 until required production services and origins are configured. It does not reveal credentials. Run the Paystack sandbox flow and verify the account settlement split in the Paystack dashboard before switching to live keys.

Migration 001 defines the final schema for fresh installs; migration 002 upgrades databases where migration 001 was already applied before these fields existed. Review and back up production data before applying schema migrations.

For local development, use a strong `JWT_SECRET` even outside production. Create the first admin only by updating `users.is_admin` directly in MySQL after signup and email verification. The public frontend's demo admin email has no authority in API mode.

## Payment boundaries

The API creates rentals as `pending_payment`. Paystack redirects the renter to its hosted checkout to select a supported payment method; the app does not promise a Paystack-created bank account number. Only a valid, signed Paystack `charge.success` webhook plus a successful server-side Verify Transaction response with matching reference, amount, and currency changes a rental to `confirmed`. Each owner subaccount uses a 0% main-account percentage by default; checkout overrides it with the flat platform `transaction_charge` computed from the rental subtotal. Paystack settles the platform fee into the platform's Paystack balance and the remainder to the owner's linked bank via their subaccount. Neither the platform's nor owner's full bank account number is displayed to renters. The deposit and delivery fee are excluded from the platform transaction and remain direct owner/renter arrangements.

## Media

The authenticated endpoints `PUT /api/items/:id/image` and `PUT /api/items/:id/video` accept `multipart/form-data` fields `image` and `video`. Images are signature-checked JPEG/PNG/WebP up to 8 MiB. Videos are signature-checked MP4/WebM/Ogg, up to 20 MiB and 60 seconds (requires `ffprobe-static`). The storage bucket currently returns public URLs for public marketplace listings.

## Existing-account note

Migration 002 adds `email_verified` as false by default. Existing users need an explicit email verification or administrator-reviewed backfill before they can log in; do not mark all legacy emails verified automatically. Set an administrator's `is_admin` field directly in the database.

## Security limits

No application can promise that hackers cannot break in. This project adds password hashing, signed short-lived JWTs, server-side role checks, exact CORS origin allowlisting, rate limits, security headers, parameterized SQL, upload size/signature checks, and signed payment webhooks. Production still requires HTTPS, protected provider secrets, a least-privilege database user, provider dashboard security, backups, monitoring, dependency updates, and a security review before real customer payments.
