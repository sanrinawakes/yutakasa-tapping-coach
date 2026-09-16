FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    CI=1 \
    VERCEL_TELEMETRY_DISABLED=1 \
    PATH="/app/node_modules/.bin:${PATH}"

WORKDIR /app
COPY scripts/automation/package.json scripts/automation/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY --chown=node:node scripts/automation/remote-monitor.mjs scripts/automation/remote-production.mjs scripts/automation/yutakasa-production-snapshot.mjs scripts/automation/dispatch-repair.mjs scripts/automation/ticket-repair-dispatch.mjs scripts/automation/drive-intake.mjs scripts/automation/support-worker.mjs scripts/automation/monitor-ledger.mjs ./

USER node
CMD ["node", "/app/remote-monitor.mjs", "run"]
