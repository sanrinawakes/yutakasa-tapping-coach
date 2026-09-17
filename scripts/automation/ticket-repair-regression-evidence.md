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

This artifact **is not a customer-completion proof**. A passing test can still
be unrelated to the customer's precise steps, and a local pass does not prove
the production behavior. The action deliberately never calls
`record_yutakasa_ticket_completion_proof` and sets
`ticketCompletionProofRecorded:false`. A later trusted producer may call that
RPC only after it independently:

1. Retrieves the current ticket privately, confirms the same latest user
   message and exact reproducible conditions, and rejects ambiguity.
2. Verifies this action's completed GitHub run/artifact, exact PR base/head,
   unchanged regression test source SHA, and independent review result.
3. After merge, verifies the actual Vercel deployment SHA/ID, runs the same
   condition against an isolated no-payment account, checks the persisted DB
   and browser state, and confirms synthetic cleanup and zero customer sends.
4. Records the before/after and production run IDs and artifact SHA-256 values
   through the guarded RPC. Any missing or conflicting fact leaves the ticket
   in manual review without a completion response.

The current chat functional smoke is a general health check. Its result must
not be used as the ticket-specific production artifact. The producer is
therefore safe to run but does not activate unattended customer completion.
