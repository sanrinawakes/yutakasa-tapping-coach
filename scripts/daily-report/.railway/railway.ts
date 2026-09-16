import { defineRailway, github, preserve, project, service } from "railway/iac";

const report = service("yutakasa-daily-support-report", {
  source: github("sanrinawakes/yutakasa-tapping-coach", { branch: "main" }),
  build: {
    builder: "DOCKERFILE",
    dockerfilePath: "/scripts/daily-report/Dockerfile",
    watchPatterns: ["scripts/daily-report/**"],
  },
  deploy: {
    startCommand: "node /app/daily-support-report.mjs",
    cronSchedule: "0 * * * *",
    restartPolicyType: "NEVER",
    numReplicas: 1,
  },
  env: {
    SUPABASE_URL: preserve(),
    SUPABASE_SERVICE_ROLE_KEY: preserve(),
    RESEND_API_KEY: preserve(),
    REPORT_RECIPIENT_1: preserve(),
    REPORT_RECIPIENT_2: preserve(),
  },
});

export default defineRailway(() =>
  project("yutakasa-support-automation", { resources: [report] }),
);
