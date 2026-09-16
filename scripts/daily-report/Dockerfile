FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY --chown=node:node scripts/daily-report/daily-support-report.mjs ./
COPY --chown=node:node scripts/daily-report/daily-report-reliability.mjs ./

USER node
CMD ["node", "/app/daily-support-report.mjs"]
