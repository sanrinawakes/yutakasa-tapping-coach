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

const monitor = service("yutakasa-support-monitor", {
  source: github("sanrinawakes/yutakasa-tapping-coach", { branch: "main" }),
  build: {
    builder: "DOCKERFILE",
    dockerfilePath: "/scripts/automation/Dockerfile",
    watchPatterns: ["scripts/automation/**"],
  },
  deploy: {
    startCommand: "node /app/remote-monitor.mjs run",
    cronSchedule: "17 * * * *",
    restartPolicyType: "NEVER",
    numReplicas: 1,
  },
  env: {
    SUPABASE_URL: preserve(),
    SUPABASE_SERVICE_ROLE_KEY: preserve(),
    JWT_SECRET: preserve(),
    CRON_SECRET: preserve(),
    VERCEL_TOKEN: preserve(),
    GITHUB_DISPATCH_TOKEN: preserve(),
    GOOGLE_DRIVE_API_KEY: "${{ shared.GOOGLE_DRIVE_API_KEY }}",
  },
});

export default defineRailway(() =>
  project("yutakasa-support-automation", { resources: [report, monitor] }),
);
