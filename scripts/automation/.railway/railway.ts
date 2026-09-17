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

const reportWatchdog = service("yutakasa-daily-report-watchdog", {
  source: github("sanrinawakes/yutakasa-tapping-coach", { branch: "main" }),
  build: {
    builder: "DOCKERFILE",
    dockerfilePath: "/scripts/daily-report/Watchdog.Dockerfile",
    watchPatterns: ["scripts/daily-report/**"],
  },
  deploy: {
    startCommand: "node /app/daily-support-report-watchdog.mjs",
    // GitHub checks at :25; this independent Railway run follows at :35.
    cronSchedule: "35 * * * *",
    restartPolicyType: "NEVER",
    numReplicas: 1,
  },
  env: {
    YUTAKASA_SUPABASE_URL: preserve(),
    YUTAKASA_SUPABASE_SERVICE_ROLE_KEY: preserve(),
    YUTAKASA_RESEND_API_KEY: preserve(),
    YUTAKASA_REPORT_RECIPIENT_1: preserve(),
    YUTAKASA_REPORT_RECIPIENT_2: preserve(),
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
    cronSchedule: "*/10 * * * *",
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
    TICKET_REPAIR_BRIDGE_ENABLED: preserve(),
    TICKET_RECONCILE_FALLBACK_ENABLED: preserve(),
    TICKET_COMPLETION_NOTICE_ENABLED: preserve(),
    TICKET_CLARIFICATION_ENABLED: preserve(),
    GOOGLE_DRIVE_API_KEY: preserve(),
  },
});

export default defineRailway(() =>
  project("yutakasa-support-automation", { resources: [report, monitor, reportWatchdog] }),
);
