# Isolated Terra ticket patch staging proof

`ticket-terra-patch-staging.yml` is a manual, main-only test. Its repository
variable `YUTAKASA_TERRA_PATCH_STAGING_ENABLED` is absent or false by default.
It also requires the real ticket-repair and auto-merge variables to remain
false. Enable this one-shot variable only for a reviewed manual run, then set
it back to false. The script checks all of these conditions itself.

Both jobs check out the current main SHA without saved Git credentials and
create a detached temporary worktree. Each makes one local commit that changes
the chat title boundary from `<= 21` to `< 21`. Nothing is pushed. A fixed
synthetic technical support context describes the resulting symptom. The
proposal job runs the existing ticket investigator with an in-memory RPC
fixture, checks the capped OpenAI project key, then sends the synthetic context
and the same nine source/test files it sends for a real ticket to
`gpt-5.6-terra`. All Supabase and GitHub calls are intercepted by fixed local
responses. Only the two OpenAI Responses requests reach the network. The
publisher is replaced with a local capture callback; no PR or Issue is
created.

The returned proposal passes the existing parser, allowed-file validator, and
customer-text leak check. This staging case additionally requires exactly
`src/lib/chat-thread.ts` and `src/lib/chat-thread.test.ts`. The proposal job
checks that the diff applies, then passes only the synthetic patch and SHA-256
manifest through a one-day artifact. It never executes generated code. The
separate verification job receives no OpenAI, GitHub repair, or database
secret. It checks the artifact SHA and main commit, applies the generated test
diff to the buggy checkout, runs the test file and requires one failure. It
resets to the seeded commit, applies the full diff, requires all tests to pass,
and checks the exact 21-character title with an independent oracle. Stdout
contains hashes, counts, and booleans. Both temporary worktrees are removed
even after failure.

This proves a bounded synthetic case of Terra generating an applicable patch
and regression test through the investigator's model path. It does not test a
real customer's report, production database, GitHub PR publishing permission,
CI on a model-created PR, merge, deployment, ticket-specific production
replay, notification, or customer completion. Its fake `draft_pr_linked`
response is local test plumbing and is never persisted as a production fact.
