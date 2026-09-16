# AI repair workflow setup

The Railway monitor may dispatch `.github/workflows/ai-repair.yml` only with its fixed `reason_codes` JSON array and `deployment_id`. The workflow re-runs the production monitor on `main`. A stale deployment, cleared anomaly, ticket-only queue, malformed input, parity failure, or missing credential stops AI execution. Only current technical reason codes enter the AI job. No customer ticket text or raw production log is sent to OpenAI by this workflow.

## OpenAI monthly limit

1. Create a **dedicated** OpenAI API project for Yutakasa automation. Set its project hard spend limit to **USD 20 per month**, and confirm the UI says enforcement is active. An alert or soft budget is insufficient. Record the project ID, amount, enforcement state, and verification date in the deployment evidence without recording a key.
2. Create a project-scoped API key in that project with restricted `Responses (/v1/responses): Write` permission. Add it as the GitHub Actions secret `YUTAKASA_OPENAI_API_KEY`. Do not use a key from another project. The currently configured key is user-owned and will need replacement if its owner loses project access.
3. Set repository variables `YUTAKASA_OPENAI_PROJECT_ID` and `YUTAKASA_OPENAI_CAP_CONFIRMED_PROJECT_ID` to the same verified project ID, and `YUTAKASA_OPENAI_CAP_CONFIRMED_USD` to `20`. These variables are an activation attestation; the provider's hard limit is the actual spend control. A project limit change later requires re-verification and variable review.

The workflow never creates a key or changes billing. It requires the verified variables before starting the billable job. An OpenAI Admin API key is not stored in GitHub Actions.

## GitHub and production credentials

- GitHub Actions secrets for the isolated live recheck job: `YUTAKASA_SUPABASE_URL`, `YUTAKASA_SUPABASE_SERVICE_ROLE_KEY`, `YUTAKASA_CRON_SECRET`, `YUTAKASA_VERCEL_TOKEN`, `YUTAKASA_GOOGLE_DRIVE_CLIENT_ID`, `YUTAKASA_GOOGLE_DRIVE_CLIENT_SECRET`, and `YUTAKASA_GOOGLE_DRIVE_REFRESH_TOKEN`. They are never present in the Codex or PR publishing jobs. `YUTAKASA_CRON_SECRET` currently stores the app's production `JWT_SECRET` because its `CRON_SECRET` is not a valid automation token; the support route accepts either configured secret.
- `YUTAKASA_REPAIR_GH_TOKEN`: a separate fine-grained GitHub credential with access only to `sanrinawakes/yutakasa-tapping-coach` and `Contents: write`, `Pull requests: write`, `Issues: write`. The token belongs only to the publishing job, never to Codex. Use a credential whose PR creation triggers repository CI without manual workflow approval; GitHub's built-in `GITHUB_TOKEN` is unsuitable for this requirement.
- The Railway dispatch credential should only have `Actions: write` on this repository. It is distinct from the repair publishing credential.
- The dispatch identity must have write access to the repository for the official `openai/codex-action` security check. Do not enable `allow-users: '*'` or `allow-bots: true`.

## Behavior and release gate

Codex runs read-only with no repository write token, no production secrets, and no customer content. It returns either a patch for existing `src/` files or an empty patch. A separate job validates the patch and creates a **draft PR**; an empty patch creates a tracked issue. The workflow never merges, deploys, responds to customers, or changes production data. A PR must pass the repository's required CI, independent review, deployment checks, and live verification before anyone calls the incident repaired.

GitHub Actions workflow failure notification and an operator response route are required before cutover. Verify one safe synthetic dispatch that reaches the no-anomaly path without an API call, then use an approved staging anomaly to test PR or issue creation. Do not fabricate a production anomaly to exercise billing.
