# Weekly maintenance checklist

Run this checklist once a week and record the date and outcome.

- [ ] Run `npm run check`; review and resolve reported vulnerabilities and outdated packages.
- [ ] Confirm a recent daily backup exists, then test a restore into a separate empty database: `npm run restore:db:test -- .\backups\<backup-file>.sql` (set `DB_RESTORE_TEST_NAME` first).
- [ ] Review recent rows in MySQL `security_events` for failed logins, admin logins/actions, payment failures, and webhook signature failures. Investigate unexpected IPs and actions.
- [ ] Review Paystack transactions and webhook delivery status against ShedShare payment records; investigate failures or mismatches.

## Daily database backup

The backup script calls `mysqldump`, saves timestamped SQL files to `DB_BACKUP_DIR` (default `./backups`), and retains the latest seven. Install a daily scheduled task on the server. For Windows Task Scheduler, run `npm run backup:db` from the project directory daily. For cron, use `0 2 * * * cd /path/to/shedshare && npm run backup:db` and set the correct `DB_*`, `PATH` (including MySQL client tools), and `DB_BACKUP_DIR` for the scheduled process. Store backups on a disk with restricted access and preferably copy them to a separate protected location.

## Alerts and lockout settings

Configure `EMAIL_PROVIDER_URL`, `EMAIL_PROVIDER_API_KEY`, and `SECURITY_ALERT_EMAIL` in the server environment to email alerts. The provider endpoint must accept JSON `{ "to", "subject", "text" }` and a Bearer API key. Without these values, alert details are written to the server error log. Login lockout occurs after five failed attempts for the same IP and email in 15 minutes and lasts 15 minutes. The `/api/auth` rate limiter also remains active.

After adding the security migration, run `npm run migrate` once. Database restore replaces existing contents unless `--test` is used with a separate, empty `DB_RESTORE_TEST_NAME` database.

## Listing media cleanup

The authenticated administrator endpoint `POST /api/admin/storage-cleanup` inventories stale, unreferenced listing media in the configured Supabase media bucket and, when configured, the S3-compatible video bucket. It only offers files that are in the asset registry created by this migration; untracked legacy objects are deliberately excluded because their rental-history association cannot be proven. It retains every object referenced by a current listing, request reference, chat attachment, rental agreement snapshot, handover record, request audit record, admin audit metadata, or the asset registry for an item with rental history. Media uploads and video removals use the same MySQL advisory lock as a delete run, so an active upload cannot be mistaken for an orphan. Storage listing is limited to `items/`; private renter/rider documents, chat attachments, local FFmpeg scratch folders, and Cloudinary preview assets are intentionally outside this cleanup scope.

Start with `{ "mode": "dry_run", "reason": "..." }`. The response reports the provider, bucket, key, byte size, last modified time, and reason, and writes a durable report to `storage_cleanup_runs` / `storage_cleanup_run_items` plus `admin_audit_log`. Default retention is 30 days and can be raised with `STORAGE_CLEANUP_RETENTION_DAYS` (30–3650); inventory is capped at 200 candidates. Review the report and ensure backups and retention policy allow removal. Permanent deletion is disabled unless `STORAGE_CLEANUP_DELETE_ENABLED=true` is explicitly set. A delete request must include a reviewed `runId`, a reason, and `confirmation: "DELETE UNREFERENCED MEDIA"`; it rechecks references and age under the upload lock, limits each run to 50 objects, and records per-object outcomes. Failed objects remain available for a later reviewed run. Do not enable deletion or call delete mode automatically in production.

The asset registry is populated for new listing uploads and video removals. Existing rows are not bulk-backfilled: current listing fields and stored agreement/audit references are still checked, but a historical media object that was replaced before this registry existed may not be traceable if it was omitted from its agreement snapshot. Such untracked legacy files are excluded rather than treated as deletable; review them manually and retain uncertain objects. Apply migration `030_storage_cleanup_audit.sql` before using the endpoint. The application and all upload-serving instances must be upgraded together for the advisory lock to coordinate correctly.
