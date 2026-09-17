# Railway monitor migration (work in progress)

This directory contains PC-independent monitoring, conservative ticket triage, and isolated AI investigation of technical anomalies. It is **not** a replacement for the full automation yet. A queued ticket or a production anomaly causes the cron process to exit with code 2. The scheduled worker atomically claims a ticket together with its claim log, then releases it as `failed` or `decision_required`; the old `reply` action returns HTTP 409 before any database write or customer send. A separate GitHub Actions job may create a draft PR or issue; automatic merge has separate CI, ruleset, preview, and private ticket gates.

## Runtime

- Railway project: `yutakasa-support-automation`
- Shared service definition in `.railway/railway.ts`: existing `yutakasa-daily-support-report` and proposed `yutakasa-support-monitor`
- Schedule: `*/10 * * * *` (UTC; every 10 minutes)
- Container: `Dockerfile`; `node remote-monitor.mjs run`
- Required Railway variables: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, one of `JWT_SECRET` or `CRON_SECRET`, `VERCEL_TOKEN`, `GITHUB_DISPATCH_TOKEN` (fine-grained GitHub token with Actions write on this repository), and the Drive API-only shared secret `GOOGLE_DRIVE_API_KEY`. Use dedicated, scoped credentials. Do not commit values.
- The Drive API key is currently stored as a production shared variable while the monitor service is absent, so the daily-report service inherits it unnecessarily. During monitor creation, verify Railway supports a monitor-service-only variable, move the rotated key there, change the IaC reference, and remove the shared copy only after a monitor-side API read succeeds. Keep the monitor inactive throughout this credential move.
- Output contains only counts, deployment identifiers, and fixed reason codes. Private ticket context exists only in a 0700 temporary run directory and is removed when the run ends. Ticket claim and terminal actions require the app's live support API, so keep the Railway cron inactive while the desktop automation is running.

After a claim, the worker fetches the ticket's current history through a lock-authenticated internal API. If the latest user message or decision category changed since the queue snapshot, it discards the old decision and releases only through a guarded failure update. Normal `failed` and `decision_required` updates require the current lock token, investigating state, latest user message ID, and the ticket version returned after claim. A conflicting user or administrator change returns 409 and leaves the newer state intact. The lock token is sent in an HTTP header, not a URL. An ambiguous claim without a verified fresh snapshot is left for the existing 30-minute stale-lock recovery.

The `failed` and `decision_required` paths use `finish_locked_support_ticket`, an additive support database function that compares the lock token, ticket version, current state, and latest user message before updating the ticket and inserting its work log in one transaction. A competing change returns no row/HTTP 409. A log insert failure rolls back the ticket update; an ambiguous API response still yields a nonhealthy worker result until state is checked. The customer reply path uses a separate RPC and remains outside this terminal function.

## Durable run ownership and observation

Apply `monitor-ledger.sql` to the Yutakasa Supabase project before enabling the Railway monitor. The `service_role` key can call atomic acquire, renew, and finish RPCs, and read the metadata-only `yutakasa_monitor_runs` table; it cannot write the table directly. A run owns a two-minute lease and renews it every 30 seconds and before external side effects. A second invocation exits with `monitor_overlap` without inspecting or changing tickets. If renewal or completion cannot be confirmed, the run fails closed. An expired owner becomes `abandoned` on the next acquisition; the old owner cannot finish or mark healthy. The scheduled `run` command uses this lease; the former two-process `preflight`/`complete` CLI modes are disabled because a process-local checkpoint cannot retain distributed ownership.

Each finished run stores only timestamps, `healthy`/`action_required`/`failed`/`abandoned`, fixed reason codes, counts, deployment ID, and whether GitHub dispatch requests were accepted. The GitHub AI gate uses the same lease with `run_kind=recheck`; the daily email counts only `run_kind=scheduled` rows whose `finished_at` falls in the previous Japanese calendar day. No ticket text, Drive filename, customer identifier, or raw log goes into this table. Zero rows, missing 10-minute slots, or a missing table are explicitly unverified, never “zero incidents.” A skipped Railway tick has no run row and therefore appears as a missing slot rather than a healthy result. The report remains sendable before this migration is applied; its monitoring section says the result is unavailable.

The scheduled run finalizes its observation and releases the lease before asking GitHub to recheck it. Dispatch receipt flags are written by a separate, idempotent RPC after GitHub accepts each request. A failed or ambiguous dispatch leaves the observation actionable and the cron result nonzero; the flags do not assert that AI investigation or a repair has finished.

The worker checks the exact support queue via the fixed production snapshot helper, the legacy Drive intake folder, GitHub/Vercel deployment parity, and bounded Vercel log queries. On any actionable condition it dispatches `monitor-alert.yml`, which creates a deduplicated GitHub Issue with fixed reason codes. Current technical anomalies also dispatch `ai-repair.yml` for an isolated investigation and draft PR or issue. No ticket body or Drive filename is sent. A Vercel token, Drive API key, or snapshot failure results in a nonzero exit and no healthy verdict. The support GET may recover stale ticket locks and add recovery work logs, so do not run it concurrently with the desktop automation during cutover.

The Vercel log scan uses one fixed 24-hour window for both the entire production project and the current deployment. Current-deployment errors retain `production_log_*` reasons and may request AI investigation. Errors present only in the project-wide count use `historical_production_log_*` reasons: they alert the owner but do not request a repair against the current deployment. The alert's deployment ID is a current-state reference, not the historical log source. The collector runs the pinned Vercel CLI from this package's `node_modules/.bin`, including in GitHub Actions where that directory is not on `PATH`. One authenticated probe of the disabled reply action on 2026-09-16 returned 501 and is excluded only when its Vercel event ID and request metadata all match. Other 5xx responses remain actionable, and the raw 100-row limit is checked before the exclusion. Inconsistent or truncated results fail closed instead of looking healthy.

## Before cutover

1. Apply and verify `monitor-ledger.sql` in production, including `service_role` privileges. Apply `supabase-migration-support-automation-terminal.sql` and then `supabase-migration-support-automation-claim.sql` after the existing support schema and before deploying the API code that calls them. Both RPCs must be executable by `service_role` and unavailable to `anon`/`authenticated`; `npm run test:support-db` checks these grants, duplicate calls, compare-and-swap conflicts, and rollback on a forced work-log failure in a local PostgreSQL container. The current desktop SQLite lease and local state file cannot protect Railway runs; the new Supabase lease applies only to the remote scheduled `run` command. Do not run both desktop and remote monitors during cutover.
2. Add automatic code review, CI release gating, production verification, and customer response handling. The configured AI job investigates and drafts only.
3. Preserve the legacy Google Drive intake check and processing-result output. The old automation only flags new Drive items and stops for a dedicated duplicate-prevention helper; it does not process those items automatically. The connected Drive account confirms `コーチングbot/豊かさ/顧客の声/受付` (folder ID `16q1toSGCWB0WyI7zH2KAKNzvENL9FfLT`) and `処理結果` (folder ID `11nYD_FzHqnYKbOy2zPBge3Y_of2tM-m5`). The folder's public metadata can be read with the Drive API-only key; a read of one temporary child folder and then zero after its deletion was verified. The Mac-synced folder is unavailable in Railway, so cutover must use and verify the remote API path.
4. Configure the Railway secrets, GitHub repair credential, and Vercel access token. Run an initial production smoke and verify at least three scheduled executions and failure notification. Only then pause the desktop automation.

The Railway project already runs `yutakasa-daily-support-report`. The combined Railway definition preserves that service and proposes adding the monitor. The former daily-report entry point re-exports the same definition so either path describes both services. Set `GOOGLE_DRIVE_API_KEY` on the monitor service itself and read it back before cutover; do not expose the key through project-wide shared variables to the daily-report service. Retain the existing shared value until the monitor-specific value is confirmed. Check `railway config plan --file scripts/automation/.railway/railway.ts` before applying. Do not apply the monitor configuration until the code is merged, credentials are ready, and the cutover checks above pass.

## Private technical ticket repair bridge (disabled until release gates pass)

Apply `repair-release-ledger.sql`, then `support-automation-reply.sql`, `ticket-repair-bridge.sql`, `ticket-reply-draft.sql`, and `ticket-clarification.sql`; verify service-role-only RPC grants and run `bash scripts/automation/test-support-automation-reply-sql.sh`. The bridge handles only technical tickets without attachments or owner-decision terms. An atomic locked handoff creates a random work UUID and moves the ticket to `awaiting_repair`. A new customer message invalidates the old work. After a verified release, the scheduled review may save a private Terra-generated draft for the administrator. The Vercel flag `TICKET_REPLY_DRAFTS_ENABLED` defaults off; enable it only after the draft table and RPC migration has been applied and checked in production. The checked send API also rejects draft use while the flag is off. The review still moves the ticket to manual review and sends no customer message. The draft migration revokes the service role's repair-completion reply RPC permission until ticket-specific before/after evidence and an approval route are implemented. A separate clarification RPC may send one fixed request for missing screen, action, error, and time details, but only for an exact, short first technical report without attachments or earlier replies. Both the Railway worker and Vercel API flags `TICKET_CLARIFICATION_ENABLED` default off. Keep both off until synthetic production checks pass; the API rejects clarification calls unless its own flag is exactly `true`. Unsupported categories remain for a person to review.

The manual `ticket-clarification-smoke.yml` runs only on main and additionally requires repository variable `YUTAKASA_CLARIFICATION_SMOKE_ENABLED=true`. First apply `ticket-clarification-smoke-cleanup.sql` and verify its service-role-only EXECUTE grant. Run `bash scripts/automation/test-ticket-clarification-smoke-sql.sh` locally or in CI. Before writing, the one-shot job rejects any old `yutakasa-auto-smoke+*@example.invalid` identity or related ticket, chat, or OTP row and probes the deployed Vercel clarification flag. It then creates only an isolated `yutakasa-auto-smoke+UUID@example.invalid` subscriber and an exact `使えない` technical ticket, claims it by explicit ID, asks the fixed in-app question, checks the direct RPC retry is idempotent and the API retry is rejected, and confirms one admin message, one clarification ledger row, two expected logs, and no unrelated dependents. No OpenAI call, customer address, notification email, or payment is used. The guarded cleanup RPC atomically validates the marker, lock token, and exact ticket shape before deleting the synthetic subscriber and ticket; an always-running rescue step uses a mode-0600 job-local UUID file if the main process is interrupted. The rescue step remains available if the repository smoke variable is switched off during the job. After one successful run and zero-residue readback, set `YUTAKASA_CLARIFICATION_SMOKE_ENABLED=false` and return Vercel `TICKET_CLARIFICATION_ENABLED=false`; verify both values. Keep Railway `TICKET_CLARIFICATION_ENABLED=false` during this smoke; enable it only after the smoke succeeds and the production schedule can be observed. A skipped or failed job is not evidence of activation.

The Railway definition preserves `TICKET_REPAIR_BRIDGE_ENABLED` and leaves it off by default. Apply and verify all three migrations before enabling anything. Set GitHub repository variables `YUTAKASA_TICKET_REPAIR_ENABLED=true` and `YUTAKASA_TICKET_RECONCILE_ENABLED=true` first, verify that the jobs actually run, then set Railway `TICKET_REPAIR_BRIDGE_ENABLED=true`. The monitor's `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and scoped `GITHUB_DISPATCH_TOKEN` are required. The GitHub job needs `YUTAKASA_SUPABASE_URL`, `YUTAKASA_SUPABASE_SERVICE_ROLE_KEY`, the capped-project `YUTAKASA_OPENAI_API_KEY` and matching project/fingerprint variables, plus the scoped `YUTAKASA_REPAIR_GH_TOKEN`. GitHub receives only a random work UUID. The job reads private context from Supabase, calls the capped OpenAI project with `store:false` and no tools, rejects patches with customer-derived text or identifiers, and creates a draft PR with an opaque fixed title/body. If it cannot defend a patch, it creates a fixed-body issue and atomically marks the ticket `manual_review`. PR linking is compare-and-swap on the latest message, current ticket status, and job run ID. Railway checks the private work backlog before marking each observation healthy; a queued/skipped GitHub job produces `ticket_repair_work_pending` and an owner alert. The scheduler recovers timed-out final claims and invalid context becomes `manual_review` with an audit log.

Automatic merge remains independently gated by `YUTAKASA_AUTO_MERGE_ENABLED`. The strict main ruleset must require `source-repair-verify`, `ai-repair-independent-review`, and `Vercel`. Promotion checks the Vercel commit status for the exact PR head. Ticket PRs use the dedicated `codex/yutakasa-support-ai-*` branch namespace. Promotion first reads the private PR-number/head link for every candidate, then rechecks the ticket work UUID, exact PR head, latest customer message, ticket state, and decision flag just before merge; changing a PR title or body cannot turn a ticket repair into a generic anomaly. Because this classification is fail closed, apply the ticket bridge migration before enabling automatic merge for either repair path. A five-minute scheduled retry checks recently opened AI PRs when Vercel finishes after the other checks; it cannot bypass a failed check or a changed main SHA.

`ticket-completion.sql` adds a dormant, ticket-specific completion route for two
bounded chat symptoms: a sent message disappearing on reload, and a response
stopping mid-stream. Its private proof row binds one repair work ID, ticket,
latest user message and message digest, PR head, merge SHA, deployment, test
scenario digest, and distinct before-failure, after-success, and production-
success artifacts. It must be written only after a trusted scenario runner has
executed those three checks for the exact customer-reported conditions. Such a
runner is **not yet implemented**. Generic chat smoke, PR success, an AI draft,
and the release observation ledger cannot create a truthful proof row on their
own. No per-ticket owner approval is needed once that exact evidence is
available, but there is currently no production-eligible proof producer.

With `YUTAKASA_TICKET_COMPLETION_ENABLED=true`, the reconciliation workflow
tries the proof route before the existing manual review transition. The
database rechecks the ticket and latest customer message, technical category,
absence of attachments and owner-decision terms, exact PR/release/production
identity, and three consecutive healthy observations on the same deployment
spanning at least twenty minutes. One transaction inserts a fixed,
scenario-specific in-app reply, resolves the ticket, marks the job replied,
and writes an audit log; a retry returns the original message. No email is
sent by this path. A missing or stale proof remains manual review. Keep the
flag absent or `false` until the trusted runner, proof provenance check,
production synthetic test, and live readback have been verified. The old
support `reply` API still returns HTTP 409.

The reconcile workflow runs at minutes 7, 17, 27, 37, 47, and 57 UTC, avoiding GitHub's busiest top-of-hour schedule boundary while retaining ten-minute spacing. GitHub can still delay or omit a scheduled event, so this timing is not a delivery guarantee. It also has an explicit manual `workflow_dispatch` entry point. Its default `probe` mode only reads the number of due release reviews and expired final investigation claims; it never calls the recovery or review RPC, the AI model, or a customer send. `reconcile` mode runs the same guarded review path as the schedule and must be selected explicitly. Both modes require the main branch, the exact repository, and `YUTAKASA_TICKET_RECONCILE_ENABLED=true`. A successful probe proves the workflow can start and read its database; it does not prove the GitHub schedule fires or that a real repair completed.

`ai-repair-one-shot-smoke.yml` is a manual, main-only production check independent of the repair-release ledger. It pins checkout to the dispatch SHA, verifies that it is the Ready Vercel Production Alias SHA, and runs the synthetic support notification regression tests. It then exercises desktop and mobile chat and creates one UUID-marked technical ticket through the authenticated support API. The same request ID must return the original ticket on retry; the ticket must remain queued and be excluded by the monitor's read-only PostgREST filter. The internal support queue GET is deliberately avoided because it can recover real customers' stale locks. The administrator list excludes this synthetic ticket. Cleanup validates the synthetic account and exact ticket state and messages, refuses deletion if an administrator replied or attachments, work logs, repair jobs, links, drafts or clarifications exist, then conditionally deletes the ticket using its last `updated_at` before deleting the thread and subscriber. It reads back all dependent rows twice. This workflow does not set the scheduled observer flag or certify a repair release. A successful run proves the application guard path; the operator should separately check Resend for the synthetic subject marker before claiming provider-side zero sends.

`ticket-terra-issue-smoke.yml` is a separate manual, main-only proof while `YUTAKASA_TICKET_REPAIR_ENABLED=false` and `YUTAKASA_AUTO_MERGE_ENABLED=false`. Apply `ticket-terra-issue-smoke-cleanup.sql` first and read back its `service_role` EXECUTE grant and `anon`/`authenticated` denial; the SQL fixture runs in `test-support-automation-reply-sql.sh`. The workflow creates the reserved non-deliverable test account and ticket, claims it by explicit ID, creates one queued repair job through the live API, claims the private synthetic context with the actual GitHub run ID, calls the capped Terra project with only fixed `OK`, and uses `YUTAKASA_REPAIR_GH_TOKEN` to create and close one fixed synthetic Issue. The ownership-checked failure RPC moves the job and ticket to private manual review; an atomic cleanup RPC accepts only the exact synthetic account, two messages, known work logs, and queued/owned/failed job states with no PR or payment marker, then deletes the test rows and reads back zero twice. A mode-0600 job-local state file lets an `always()` rescue step repeat the guarded cleanup after process interruption. On provider failure, the workflow still attempts the manual-review transition and cleanup; an uncertain Issue outcome is not retried blindly. A successful run proves this issue path and scoped token's Issue permission. It does not prove Terra diagnosis of customer text, the token's Contents/Pull requests permissions, draft PR creation, CI, auto merge, production repair observation, or customer resolution. No repair or merge flag is enabled by the workflow. Independently check the email provider for zero synthetic notification sends before claiming that boundary.

The claimed synthetic ticket context is validated inside the workflow and is **not sent to Terra or GitHub**. Terra receives the fixed text `OK` only. This test does not run `ticket-repair-investigate.mjs` or prove that Terra can turn a ticket report into a code patch; that path requires a separate isolated staging test with a known defect before live repair is enabled.

For a Railway fallback, set the monitor-service-only `TICKET_RECONCILE_FALLBACK_ENABLED=true` only after the workflow's no-op probe succeeds and its scheduled behavior has been evaluated. The default is off. When enabled, the monitor makes read-only database queries for due release reviews and investigation claims past the final two-hour deadline. If either is due, the monitor records `ticket_reconcile_work_due`, checks recent GitHub runs to avoid a duplicate queued or running workflow, and dispatches `reconcile` with fixed inputs after releasing its monitor lease. Dispatch acceptance never counts as a completed review. A failed GitHub lookup or dispatch makes the cron exit nonzero and sends a fixed `ticket_reconcile_dispatch_failed` alert; no ticket body or work ID is sent to GitHub. The database RPCs recheck due conditions and ownership, so a delayed or duplicate GitHub run cannot send a customer reply.

The built-in GitHub Actions `GITHUB_TOKEN` cannot be used by Railway, and using it to create a PR would suppress the required PR workflow triggers. Retain a scoped dispatch token for Railway and a scoped repair token or GitHub App installation token for PR creation.

## Drive content and result PDF handoff (inactive)

`drive-intake-content.mjs` can fetch one unchanged, supported file from the
existing `受付` folder after checking its parent, modified time, size, and
checksum. `drive-result.mjs` renders a Japanese PDF from a structured release
record and uploads it to the existing `処理結果` folder. A durable exclusive
lease and a separate release-evidence check are required callbacks. Apply
`drive-result-ledger.sql` before activation: an event ID has one durable
publication reservation, and a timed-out POST leaves `posting` or `uncertain`
state. Later runs may confirm an existing Drive file but cannot issue another
POST for that event. The upload uses an event-ID-only stable filename, checks
the reservation before writing, and confirms the file's parent, name, size,
and hashes through Drive readback. The existing monitor reaches these modules
only through the disabled Drive scheduler. A new Drive item still raises
`drive_intake_items`; it is not marked processed or healthy.

`drive-intake-runtime.mjs` adds a disabled per-file caller: it claims a Drive
revision, renews that claim while it verifies the source bytes, binds the
source SHA-256 to a stable event ID and an independently verified release
record, then invokes the existing PDF publication ledger before marking the
source processed. An error or uncertain upload becomes `needs_review`;
another run cannot repeat the upload. The caller has no direct CLI entry point.
The old automation did not diagnose Drive files automatically, and this module
does not invent such a diagnosis. Drive metadata now carries its revision
version when Google supplies it. The processing caller requires that version
and stops before a claim if Google omits it, so an edited file cannot be
silently treated as an already processed revision.

`drive-release-binding.sql` adds a dormant, owner-recorded binding for one
exact file revision and content SHA-256 to one structured report and release
PR. The service role can only read the table; it has no report issuance or
approval permission. `drive-release-binding.mjs` supplies the caller's
`loadVerifiedResult` and `verifyReleaseEvidence` callbacks. It re-reads the
binding and release ledger, three consecutive healthy observations, current
GitHub main/Vercel production parity, and exact PR-head CI before publication.
`drive-release-evidence.mjs` checks the report digest, source revision, and
release evidence without reading customer content. The binding migration was
applied to production on 2026-09-17; readback found zero rows, RLS enabled,
service-role SELECT only, and no anon/authenticated SELECT. The SQL fixture is
local only.
There is still no trusted diagnosis/report issuer, owner approval interface,
OAuth credential, or synthetic end-to-end Drive proof. Keep processing and
publication flags off until those are implemented and verified.

`drive-processing-scheduler.mjs` is wired to the Railway monitor lease but is
disabled unless `YUTAKASA_DRIVE_SCHEDULED_ENABLED=true` as well as both Drive
processing and publishing flags. It lists fresh Drive metadata, requires a
revision version, and checks for an owner-verified binding by event ID before
claiming or downloading a file. Missing bindings are skipped without a claim
or content read; provider denial fails the monitor. At most one newly processed
file runs per tick. The monitor still counts every file in `受付` as actionable,
including processed files, until an independently verified completion-state
read is implemented. This deliberately avoids a false healthy result. The
scheduled flag is not set in Railway and must remain off before OAuth approval,
trusted report issuance, and synthetic end-to-end proof.

Content reads also require the exact `YUTAKASA_DRIVE_PROCESSING_ENABLED=true`
flag in their credential source. PDF publication additionally requires
`YUTAKASA_DRIVE_RESULT_PUBLISH_ENABLED=true`. Both default off. The OAuth
refresh helper used by content reads and PDF publication rejects a missing or
differently spelled processing flag before requesting a token. The existing
metadata-only monitor still uses its API key when one is configured.
Neither flag is configured in the production Railway service. Do not enable
them merely because OAuth credentials have been issued: the scheduled caller
only accepts reports with an owner-verified binding and does not generate a
diagnosis. A file in `受付` remains actionable.

The current `GOOGLE_DRIVE_API_KEY` is for public metadata only. Content and
upload require OAuth on the actual `181wyc@gmail.com` Drive account:
`GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET`, and
`GOOGLE_DRIVE_REFRESH_TOKEN` must be stored as monitor-service-only Railway
secrets after the account holder authorizes offline access. Existing and
future, not-yet-selected My Drive files require a grant covering continuing
access; a `drive.file` grant for files picked once does not establish that
coverage. The `https://www.googleapis.com/auth/drive` scope is restricted,
so review Google's production OAuth requirements with the account owner
before issuing a long-lived token. An External/Testing consent screen yields
a refresh token that expires after seven days. Do not alter folder sharing
or place OAuth credentials in the API-key variable.

The disabled scheduler binds `assertLease` to the current monitor owner and
uses the durable per-file intake claim. Before enabling it, verify the
publication ledger and run a
non-customer synthetic file through the real OAuth account, confirm Drive
readback and three monitor observations, and then enable the verified report
publisher. Missing credentials, missing evidence, unsupported file types, or
failed Drive operations must remain action-required.

`drive-intake-ledger.sql` and `drive-intake-ledger.mjs` provide that dormant
per-file claim. The key is an opaque Drive file ID plus its modified time;
when a Drive version is available it is recorded and must match on repeat
claims. A changed version at an unchanged modified time fails closed. One
worker gets a two-minute lease and UUID claim token. A second worker sees
`busy`. The owner must renew its lease before each external action and mark
`processed` only after all required effects are confirmed. If the worker
crashes or the result of an external action is unclear, the claim becomes
`needs_review`; later versions of that file remain blocked until a person
reconciles the outcome. No automatic retry can process the file twice. Older
versions return `stale`. The table stores no filename, file content, customer
email, or raw error text. The intake ledger migration was applied to
production on 2026-09-17; the table had zero rows and the RPC grants were
verified at rollout. It now has a disabled scheduled caller, with no real
OAuth, content retrieval, PDF publication, or customer notification verified.
`drive-intake-ledger.sqlcheck.sql` is a local test fixture with
synthetic IDs; do not run it on production. The test fixture rolls back its
rows so repeated local runs remain independent.
