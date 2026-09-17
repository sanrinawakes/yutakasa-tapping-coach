# One-shot synthetic ticket → Terra → linked draft PR proof

This workflow is dormant. It runs only by manual dispatch from the exact
`main` checkout while `YUTAKASA_BRIDGE_E2E_SMOKE_ENABLED=true` and the real
ticket-repair and auto-merge variables are both `false`. Reset the one-shot
variable after the run. The script repeats the flag, SHA, branch, and clean
checkout checks. It shares the observation concurrency group, so it cannot
overlap the existing synthetic handoff or release observation runs.

Before any synthetic row is created, the workflow checks that main still has
the fixed zero-width-only title defect, that the production Vercel SHA is this
main SHA, that strict required CI/ruleset protection is present, and that the
service-role-only cleanup RPC exists. The synthetic subscriber is a random
`yutakasa-auto-smoke+<uuid>@example.invalid` no-payment identity. The app
suppresses email for this reserved address and excludes it from ordinary
support queues. Its fixed technical ticket reports that a zero-width space
alone creates a blank-looking title. The real authenticated support API
creates that ticket and proves idempotency; the real claim/handoff APIs create
one private repair job. The real investigator claims its exact two-message
context, verifies the project's $20 cap and key fingerprint, and calls
`gpt-5.6-terra` without exposing customer data. It accepts only an actual
source-and-regression-test patch in `chat-thread.ts` and its test, and invokes
the existing publisher to create an opaque draft PR. There is no fallback
patch, Issue creation, production merge, or customer send.

For this fixed synthetic context only, the bridge adds an exact two-file
instruction to the Terra request after checking the claimed ticket contents.
The real capped-project probe keeps its original request and runs before this
scoped diagnosis request. The regular ticket investigator's prompt and allowed
files are unchanged.

The real link RPC must bind the PR number/head SHA to that exact ticket and
also create one pending release-ledger row and one ticket link. The smoke reads
those rows back and waits for successful exact-head source-repair CI,
independent Terra review, and Vercel preview. Success on the smoke additionally
requires a closed unmerged PR and absent branch. The scoped repair token is
used for PR/branch mutations; the job's built-in token has read-only
Actions/Contents/Pull requests access for evidence. Branch deletion uses an
atomic Git lease on the expected head SHA.

GitHub cleanup **precedes** database cleanup. If PR creation is uncertain,
the PR changes identity, the branch changes head, or either readback fails,
the database rows remain for investigation. A private job-local state file
supports an `always()` rescue step. After GitHub is confirmed clean, the
`cleanup_yutakasa_ticket_bridge_e2e_smoke` RPC locks the job, ticket,
subscriber, and release, verifies the exact marker, account, two messages,
work logs, job ownership, PR/head/link/release state, and absence of messages,
attachments, completion proofs/notices, payment metadata, and other
unexpected dependents. It deletes only those synthetic rows in one
transaction. The caller reads back their absence twice. Hard runner
termination may leave synthetic rows or the draft PR; never remove them by a
broad query.

The new cleanup migration must be applied to production and its service-role
EXECUTE/anon/authenticated denial read back **before** enabling this workflow.
The migration is included as code only; merging this PR does not apply it.
The first manual run must also confirm that the existing `$20` OpenAI project
cap, scoped GitHub token, Vercel deployment, and all real repair flags have the
expected values. The workflow proves one synthetic bridge path only. It does
not prove a customer-specific fix, production merge/deploy/observation,
completion notice, or reply. GitHub's PR/Actions/Vercel checks and database
row readback are separate evidence surfaces; provider email delivery remains
unproven until its event log is checked for zero synthetic sends.
