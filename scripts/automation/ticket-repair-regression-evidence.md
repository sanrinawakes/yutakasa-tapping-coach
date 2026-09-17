# Ticket repair regression evidence (candidate only)

`ticket-repair-regression-evidence.yml` runs trusted code from `main`. It accepts
an opaque work UUID, a draft repair PR number, and one of two fixed technical
scenarios. It fetches the exact PR head, rejects all non-chat source/config
changes, and requires a newly added test with this exact title marker:

`repair-regression:<first 16 hex of SHA-256(work_id)>:<scenario_key>`

For `chat_send_reload_persistence`, the marker must be in
`src/app/chat/page.test.tsx`. For `chat_stream_completion`, it must be in
`src/app/api/chat/route.test.ts`. The action installs dependencies from the
trusted `main` lockfile, copies the new test into an isolated checkout of the
PR base, and runs that same test file in both the base and PR head. It accepts
only a single named failure on the base and a complete pass at the head. Test
processes receive no API keys or GitHub token, and the job uses the public
GitHub PR API without credentials. The public artifact contains
only opaque IDs, commit hashes, scenario/test digests, and counts. Raw support
messages are never fetched by this job.

The separate `ticket-repair-production-candidate.yml` workflow can run only
after that PR is merged and its merge SHA is still the current production
SHA. It downloads the exact before/after artifact from GitHub Actions,
checks the completed run, verifies the head test file is byte-for-byte the
same at the merge commit, and reads the private job/ticket/release linkage
without logging customer text. It requires one technical ticket with no
attachment or owner decision, the latest customer message to describe exactly
one of the two allowlisted symptoms, and no later administrator reply. It
checks the GitHub squash-merge parent, Vercel production alias and deployment
ID, and repeats these checks after a desktop/mobile browser run against an
isolated no-payment account. The existing E2E asserts a completed stream,
persisted messages, reload visibility, no client errors, and cleanup. The
output artifact has `customerConditionMatched:false`.

Neither artifact **is a customer-completion proof**. A passing new test can
still be unrelated to the customer's precise steps. The synthetic account
uses fixed prompts and browsers, while a free-text ticket does not carry a
server-attested replay contract for the customer's browser, account state,
steps, and failure trigger. The workflows deliberately never call
`record_yutakasa_ticket_completion_proof`; both emit
`ticketCompletionProofRecorded:false`. A future trusted producer may call that
RPC only after it independently:

1. Retrieves the current ticket privately, confirms the same latest user
   message and exact reproducible conditions, and rejects ambiguity.
2. Verifies this action's completed GitHub run/artifact, exact PR base/head,
   unchanged regression test source SHA, and independent review result.
3. After merge, verifies the actual Vercel deployment SHA/ID, replays that
   *same server-attested condition* against an isolated no-payment account,
   checks the persisted DB and browser state, and confirms synthetic cleanup
   and zero customer sends.
4. Records the before/after and production run IDs and artifact SHA-256 values
   through the guarded RPC. Any missing or conflicting fact leaves the ticket
   in manual review without a completion response.

The current chat functional smoke is a general health check. The new
production workflow ties its result to one release and ticket but does not
upgrade it to a ticket-specific proof. Neither workflow activates unattended
customer completion.
