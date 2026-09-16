# Railway monitor migration (work in progress)

This directory contains PC-independent monitoring, conservative ticket triage, and isolated AI investigation of technical anomalies. It is **not** a replacement for the full automation yet. A queued ticket or a production anomaly causes the cron process to exit with code 2. The scheduled worker may atomically claim a ticket, log the handoff, and release it as `failed` or `decision_required`; it does not send a customer reply. A separate GitHub Actions job may create a draft PR or issue, but no workflow merges or deploys fixes.

## Runtime

- Railway project: `yutakasa-support-automation`
- Service defined in `.railway/railway.ts`: `yutakasa-support-monitor`
- Schedule: `17 * * * *` (UTC)
- Container: `Dockerfile`; `node remote-monitor.mjs run`
- Required Railway variables: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, one of `JWT_SECRET` or `CRON_SECRET`, `VERCEL_TOKEN`, `GITHUB_DISPATCH_TOKEN` (fine-grained GitHub token with Actions write on this repository), `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET`, and `GOOGLE_DRIVE_REFRESH_TOKEN` (Drive metadata.readonly OAuth grant). Use dedicated, scoped credentials. Do not commit values.
- Output contains only counts, deployment identifiers, and fixed reason codes. Private ticket context exists only in a 0700 temporary run directory and is removed when the run ends. Ticket claim and terminal actions require the app's live support API, so keep the Railway cron inactive while the desktop automation is running.

The worker checks the exact support queue via the fixed production snapshot helper, the legacy Drive intake folder, GitHub/Vercel deployment parity, and bounded Vercel log queries. On any actionable condition it dispatches `monitor-alert.yml`, which creates a deduplicated GitHub Issue with fixed reason codes. Current technical anomalies also dispatch `ai-repair.yml` for an isolated investigation and draft PR or issue. No ticket body or Drive filename is sent. A Vercel token, Drive OAuth, or snapshot failure results in a nonzero exit and no healthy verdict. The support GET may recover stale ticket locks and add recovery work logs, so do not run it concurrently with the desktop automation during cutover.

## Before cutover

1. Finish and test a distributed run lease and durable observation state. The current desktop SQLite lease and local state file cannot protect Railway runs; the live API's atomic per-ticket claims only protect ticket mutations.
2. Add automatic code review, CI release gating, production verification, and customer response handling. The configured AI job investigates and drafts only.
3. Preserve the legacy Google Drive intake check and processing-result output. The old automation only flags new Drive items and stops for a dedicated duplicate-prevention helper; it does not process those items automatically. The connected Drive account confirms `コーチングbot/豊かさ/顧客の声/受付` (folder ID `16q1toSGCWB0WyI7zH2KAKNzvENL9FfLT`; zero direct children observed on 2026-09-16) and `処理結果` (folder ID `11nYD_FzHqnYKbOy2zPBge3Y_of2tM-m5`). The Mac-synced folder is unavailable in Railway; this requires a dedicated Drive API identity with durable access before cutover.
4. Configure the Railway secrets, GitHub repair credential, and Vercel access token. Run an initial production smoke and verify at least three scheduled executions and failure notification. Only then pause the desktop automation.

The Railway project is currently empty. `railway config plan --file scripts/automation/.railway/railway.ts` reports one service to add. Applying it before the code is merged and credentials are ready would start an incomplete monitor.
