# Scoped GitHub draft PR permission proof

`ticket-token-pr-smoke.yml` is manual and default off. It requires repository
variable `YUTAKASA_TOKEN_PR_SMOKE_ENABLED=true` while the real ticket repair
and auto-merge variables remain false. The code independently checks these
conditions and the exact main checkout SHA. Reset the one-shot variable to
false after the full workflow finishes.

The workflow uses the existing `YUTAKASA_REPAIR_GH_TOKEN` only for branch and
PR mutations. It uses a read-only built-in token for PR, ruleset, CI, and
status evidence. Its checkout does not retain either token. It checks the
strict main ruleset, then creates
one branch named `codex/yutakasa-token-smoke-<run>-<attempt>`. That namespace
is outside both automatic repair promotion namespaces. The fixed diff adds a
comment to `src/lib/chat-thread.ts` and one harmless normalization assertion
to `src/lib/chat-thread.test.ts`. It contains no customer, model, billing, or
production database data. The script uses the scoped token to push the branch
and create a draft PR with fixed title/body. It then waits for successful
`source-repair-verify`, the non-AI scope check from
`ai-repair-independent-review`, and exact-head Vercel preview status. The
remote automation CI workflow is path-filtered to automation files and is
not expected for this two-file diff.

The final `always()` step resolves only the PR with that exact branch, title,
body, base, and recorded head SHA. It closes an open draft, atomically deletes
the branch with a Git force-with-lease requiring that exact head SHA, and reads
back the closed PR and absent branch.
A failed or uncertain create is looked up by branch rather than retried. If
someone changes the PR or branch, cleanup fails without deleting it; an
operator must investigate the leftover. A hard runner termination before the
final step can also leave the branch or PR and requires an explicit cleanup.

Success proves Contents/Pull requests permissions and that this token's PR
triggers the required CI and Vercel preview. It does not call Terra, link a
private ticket, enable repair/auto-merge, merge to main, deploy to production,
record ticket-specific proof, or send a customer reply. It does not prove the
real repair publisher's exact patch path; the earlier isolated Terra staging
smoke covers proposal and validation, and a later linked synthetic case is
needed to connect the two.
