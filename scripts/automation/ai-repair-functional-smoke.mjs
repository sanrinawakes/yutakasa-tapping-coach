#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const PRODUCTION_URL = "https://yutakasa-tapping-coach.vercel.app";
const TEST_ACCOUNT_MARKER = "yutakasa-ai-repair-smoke-v1";
const TEST_MESSAGE_MARKER = "__YUTAKASA_AI_REPAIR_SMOKE_V1__";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA = /^[a-f0-9]{40}$/u;
const DEPLOYMENT = /^dpl_[A-Za-z0-9]{8,160}$/u;
const PARTIAL_RESPONSE = "通信が途中で中断されたため";
const SYNTHETIC_EMAIL = /^yutakasa-auto-smoke\+([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})@example\.invalid$/iu;
const STALE_AFTER_MS = 30 * 60 * 1_000;
const PREFLIGHT_LIMIT_MS = 2 * 60 * 1_000;
const BROWSER_PHASE_LIMIT_MS = 4 * 60 * 1_000;

export class FunctionalSmokeError extends Error {
  constructor(code) {
    super(code);
    this.name = "FunctionalSmokeError";
    this.code = code;
  }
}

function fail(code) {
  throw new FunctionalSmokeError(code);
}

async function within(promise, milliseconds, code) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new FunctionalSmokeError(code)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function requiredConfiguration(env, release, deployment) {
  if (typeof env.JWT_SECRET !== "string" || env.JWT_SECRET.length < 32) fail("smoke_jwt_secret_not_configured");
  if (typeof env.SUPABASE_URL !== "string" || !/^https:\/\/[a-z0-9-]+\.supabase\.co$/u.test(env.SUPABASE_URL)) fail("smoke_database_not_configured");
  if (typeof env.SUPABASE_SERVICE_ROLE_KEY !== "string" || env.SUPABASE_SERVICE_ROLE_KEY.length < 20) fail("smoke_database_not_configured");
  if (!SHA.test(release?.merge_sha ?? "") || !DEPLOYMENT.test(deployment?.deploymentId ?? "") ||
      deployment?.mainSha !== release.merge_sha || deployment?.ready !== true) fail("smoke_release_evidence_invalid");
}

async function databaseRequest(env, fetchImpl, table, query, method = "GET", body = null) {
  const url = new URL(`/rest/v1/${table}`, env.SUPABASE_URL);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  let response;
  try {
    response = await within(fetchImpl(url, {
      method,
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        Accept: "application/json",
        ...(method !== "GET" ? { Prefer: "return=representation" } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    }), 15_000, "smoke_database_timeout");
  } catch {
    fail("smoke_database_request_failed");
  }
  if (![200, 201].includes(response.status)) fail(`smoke_database_http_${response.status}`);
  const text = await within(response.text(), 15_000, "smoke_database_body_timeout");
  if (Buffer.byteLength(text) > 128 * 1024) fail("smoke_database_response_too_large");
  let rows;
  try { rows = JSON.parse(text); } catch { fail("smoke_database_response_invalid"); }
  if (!Array.isArray(rows) || rows.length > 20) fail("smoke_database_rows_invalid");
  return rows;
}

function validateAccount(account, email, runId) {
  if (account?.email !== email || account?.status !== "active" ||
      account?.subscription_status !== "active" ||
      account?.myasp_data?.automation_test_identity !== TEST_ACCOUNT_MARKER ||
      account?.myasp_data?.source !== "system_monitor_no_payment" ||
      account?.myasp_data?.smoke_run_id !== runId ||
      account?.first_payment_date !== null) fail("smoke_identity_not_isolated");
}

async function listThreads(env, fetchImpl, email) {
  const rows = await databaseRequest(env, fetchImpl, "chat_threads", {
    user_email: `eq.${email}`,
    select: "id,user_email,title,created_at",
    limit: "20",
  });
  if (rows.some((row) => !UUID.test(row?.id ?? "") || row.user_email !== email)) fail("smoke_thread_identity_mismatch");
  return rows;
}

async function listMessages(env, fetchImpl, threadId) {
  if (!UUID.test(threadId)) fail("smoke_thread_id_invalid");
  return databaseRequest(env, fetchImpl, "chat_messages", {
    thread_id: `eq.${threadId}`,
    select: "id,thread_id,role,content,created_at",
    order: "created_at.asc,id.asc",
    limit: "20",
  });
}

async function assertMessagesSaved(env, fetchImpl, threadId, prompts) {
  const rows = await listMessages(env, fetchImpl, threadId);
  if (rows.length !== prompts.length * 2 ||
      rows.some((row) => !UUID.test(row?.id ?? "") || row.thread_id !== threadId ||
        !["user", "assistant"].includes(row.role) || typeof row.content !== "string")) {
    fail("smoke_database_save_incomplete");
  }
  const users = rows.filter((row) => row.role === "user");
  const assistants = rows.filter((row) => row.role === "assistant");
  if (assistants.length !== prompts.length || users.length !== prompts.length ||
      users.some((row, index) => row.content !== prompts[index]) ||
      assistants.some((row) => !row.content.trim() || row.content.includes(PARTIAL_RESPONSE))) {
    fail("smoke_database_save_incomplete");
  }
  return assistants;
}

function sessionToken(secret, email) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ email, iat: now, exp: now + 10 * 60 })).toString("base64url");
  const content = `${header}.${payload}`;
  return `${content}.${createHmac("sha256", secret).update(content).digest("base64url")}`;
}

function trackClientErrors(page, errors) {
  page.on("pageerror", () => errors.push("pageerror"));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push("console_error");
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin === PRODUCTION_URL && url.pathname.startsWith("/api/") && response.status() >= 400) {
      errors.push("api_error");
    }
  });
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" &&
        (["/api/auth/send-otp", "/api/support/tickets"].includes(path) || path.startsWith("/storage/"))) {
      errors.push("unexpected_mail_or_support_request");
    }
  });
}

async function openPage(browser, deviceOptions, token, errors) {
  const context = await browser.newContext(deviceOptions);
  await context.addCookies([{
    name: "session", value: token, url: PRODUCTION_URL,
    httpOnly: true, secure: true, sameSite: "Lax",
  }]);
  await context.addInitScript(() => localStorage.setItem("yutakasa_welcome_seen", "1"));
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  trackClientErrors(page, errors);
  const response = await page.goto(`${PRODUCTION_URL}/chat`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  if (response?.status() !== 200 || new URL(page.url()).pathname !== "/chat") fail("smoke_chat_page_unavailable");
  await page.locator('textarea[placeholder="メッセージを入力..."]').waitFor();
  if (deviceOptions.isMobile) await page.getByRole("button", { name: "メニューを閉じる" }).click();
  return { context, page };
}

async function sendFromBrowser(page, prompt, expectedAssistantCount) {
  const input = page.locator('textarea[placeholder="メッセージを入力..."]');
  await input.fill(prompt);
  const pendingResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/chat" && response.request().method() === "POST",
  { timeout: 60_000 });
  await page.getByRole("button", { name: "送信" }).click();
  const response = await pendingResponse;
  if (response.status() !== 200) fail("smoke_chat_send_failed");
  const streamError = await within(response.finished(), 90_000, "smoke_chat_stream_timeout");
  if (streamError) fail("smoke_chat_stream_interrupted");
  const body = await within(response.text(), 10_000, "smoke_chat_stream_body_timeout");
  if (!body.trim() || body.includes(PARTIAL_RESPONSE)) fail("smoke_chat_stream_incomplete");
  await page.waitForFunction(() => {
    const input = document.querySelector('textarea[placeholder="メッセージを入力..."]');
    return input && !input.disabled;
  }, null, { timeout: 30_000 });
  await page.getByText(prompt, { exact: true }).waitFor({ timeout: 30_000 });
  const assistants = page.locator(".message-item.justify-start");
  await page.waitForFunction((count) => document.querySelectorAll(".message-item.justify-start").length === count,
    expectedAssistantCount, { timeout: 30_000 });
  const assistant = assistants.last();
  await assistant.waitFor({ timeout: 30_000 });
  const rendered = (await assistant.innerText()).trim();
  if (!rendered || rendered.includes(PARTIAL_RESPONSE)) fail("smoke_chat_render_incomplete");
  return rendered;
}

async function assertReload(page, prompt, expectedRendered, expectedAssistantCount) {
  const response = await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
  if (response?.status() !== 200 || new URL(page.url()).pathname !== "/chat") fail("smoke_chat_reload_failed");
  await page.getByText(prompt, { exact: true }).waitFor({ timeout: 30_000 });
  await page.waitForFunction((count) => document.querySelectorAll(".message-item.justify-start").length === count,
    expectedAssistantCount, { timeout: 30_000 });
  const assistant = page.locator(".message-item.justify-start").last();
  await assistant.waitFor({ timeout: 30_000 });
  if ((await assistant.innerText()).trim() !== expectedRendered) fail("smoke_chat_reload_mismatch");
}

async function cleanupAndVerify(env, fetchImpl, email, runId) {
  const accounts = await databaseRequest(env, fetchImpl, "subscribers", {
    email: `eq.${email}`,
    select: "id,email,status,subscription_status,first_payment_date,myasp_data",
    limit: "2",
  });
  if (accounts.length > 1) fail("smoke_cleanup_identity_ambiguous");
  if (accounts.length === 1) {
    validateAccount(accounts[0], email, runId);
    if (!UUID.test(accounts[0].id ?? "")) fail("smoke_cleanup_identity_ambiguous");
  }
  const threads = await listThreads(env, fetchImpl, email);
  for (const thread of threads) {
    const deleted = await databaseRequest(env, fetchImpl, "chat_threads", {
      id: `eq.${thread.id}`,
      user_email: `eq.${email}`,
      select: "id",
    }, "DELETE");
    if (deleted.length !== 1 || deleted[0]?.id !== thread.id) fail("smoke_cleanup_delete_unconfirmed");
  }
  const otps = await databaseRequest(env, fetchImpl, "otp_codes", {
    email: `eq.${email}`, select: "id", limit: "2",
  });
  if (otps.length !== 0) fail("smoke_unexpected_otp_data");
  if (accounts.length === 1) {
    const deleted = await databaseRequest(env, fetchImpl, "subscribers", {
      id: `eq.${accounts[0].id}`,
      email: `eq.${email}`,
      "myasp_data->>smoke_run_id": `eq.${runId}`,
      select: "id",
    }, "DELETE");
    if (deleted.length !== 1 || deleted[0]?.id !== accounts[0].id) fail("smoke_cleanup_subscriber_unconfirmed");
  }
  // The FK must cascade. Check twice so a late stream completion cannot count as cleaned data.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
    if ((await listThreads(env, fetchImpl, email)).length !== 0) fail("smoke_cleanup_threads_remaining");
    if ((await databaseRequest(env, fetchImpl, "subscribers", {
      email: `eq.${email}`, select: "id", limit: "2",
    })).length !== 0) fail("smoke_cleanup_subscriber_remaining");
    for (const thread of threads) {
      if ((await listMessages(env, fetchImpl, thread.id)).length !== 0) fail("smoke_cleanup_messages_remaining");
    }
  }
}

/** Only old, exact, no-payment synthetic identities can be reaped. */
export async function reapStaleSyntheticIdentities(env, fetchImpl, nowMs = Date.now()) {
  const accounts = await databaseRequest(env, fetchImpl, "subscribers", {
    email: "like.yutakasa-auto-smoke*",
    select: "id,email,status,subscription_status,first_payment_date,myasp_data,created_at",
    limit: "4",
  });
  if (accounts.length > 3) fail("smoke_stale_identity_limit_exceeded");
  const stale = [];
  // Validate every candidate before deleting any row. A recent or malformed
  // candidate may belong to a still-running check or an unrelated account.
  for (const account of accounts) {
    const match = SYNTHETIC_EMAIL.exec(account?.email ?? "");
    if (!match || !UUID.test(account?.id ?? "")) fail("smoke_stale_identity_ambiguous");
    const runId = match[1];
    validateAccount(account, account.email, runId);
    const createdAt = Date.parse(account.created_at ?? "");
    if (!Number.isFinite(createdAt) || createdAt > nowMs || nowMs - createdAt < STALE_AFTER_MS) {
      fail("smoke_synthetic_identity_still_recent");
    }
    stale.push({ email: account.email, runId });
  }
  const threads = await databaseRequest(env, fetchImpl, "chat_threads", {
    user_email: "like.yutakasa-auto-smoke*",
    select: "id,user_email",
    limit: "20",
  });
  const validEmails = new Set(stale.map((account) => account.email));
  if (threads.some((thread) => !UUID.test(thread?.id ?? "") || !validEmails.has(thread.user_email))) {
    fail("smoke_stale_threads_ambiguous");
  }
  const otps = await databaseRequest(env, fetchImpl, "otp_codes", {
    email: "like.yutakasa-auto-smoke*",
    select: "id,email",
    limit: "20",
  });
  if (otps.length !== 0) fail("smoke_stale_otp_ambiguous");
  for (const account of stale) await cleanupAndVerify(env, fetchImpl, account.email, account.runId);
  return { reaped: stale.length };
}

/** Run only from a trusted main checkout, with no PR code or production secrets in the browser. */
export async function runProductionFunctionalSmoke({
  release, deployment, env = process.env, fetchImpl = globalThis.fetch,
  chromiumImpl = null, browserPhaseLimitMs = BROWSER_PHASE_LIMIT_MS,
} = {}) {
  requiredConfiguration(env, release, deployment);
  if (!Number.isSafeInteger(browserPhaseLimitMs) || browserPhaseLimitMs < 1) fail("smoke_browser_limit_invalid");
  const preflightStartedAt = Date.now();
  await reapStaleSyntheticIdentities(env, fetchImpl);
  if (Date.now() - preflightStartedAt > PREFLIGHT_LIMIT_MS) fail("smoke_preflight_timeout");
  const runId = randomUUID();
  const email = `yutakasa-auto-smoke+${runId}@example.invalid`;
  const existing = await databaseRequest(env, fetchImpl, "subscribers", {
    email: `eq.${email}`,
    select: "id",
    limit: "2",
  });
  if (existing.length !== 0) fail("smoke_preexisting_identity");
  if ((await listThreads(env, fetchImpl, email)).length !== 0) fail("smoke_prior_test_data_remaining");

  const errors = [];
  const token = sessionToken(env.JWT_SECRET, email);
  const prompts = [];
  const marker = `${TEST_MESSAGE_MARKER} ${randomUUID()}`;
  let browser;
  let primaryError;
  let completed = false;
  let phaseExpired = false;
  let phaseTimer;
  try {
    const inserted = await databaseRequest(env, fetchImpl, "subscribers", {
      select: "id,email,status,subscription_status,first_payment_date,myasp_data",
    }, "POST", {
      email,
      name: "System monitor test identity (no customer, no payment)",
      status: "active",
      subscription_status: "active",
      first_payment_date: null,
      myasp_data: {
        automation_test_identity: TEST_ACCOUNT_MARKER,
        source: "system_monitor_no_payment",
        smoke_run_id: runId,
      },
    });
    if (inserted.length !== 1) fail("smoke_identity_insert_unconfirmed");
    validateAccount(inserted[0], email, runId);
    // The workflow itself has a ten-minute deadline. End browser work after
    // four minutes so the finally block has time to remove test data.
    phaseTimer = setTimeout(() => {
      phaseExpired = true;
      if (browser) void browser.close().catch(() => undefined);
    }, Math.min(browserPhaseLimitMs, BROWSER_PHASE_LIMIT_MS));
    const assertBrowserTime = () => { if (phaseExpired) fail("smoke_browser_phase_timeout"); };
    const chromium = chromiumImpl ?? (await import("playwright")).chromium;
    // ubuntu-24.04 GitHub hosted runners provide stable Chrome. Avoid downloading
    // a full browser on every ten-minute scheduled observation.
    browser = await chromium.launch({ headless: true, channel: "chrome" });
    assertBrowserTime();
    const desktop = await openPage(browser, { viewport: { width: 1440, height: 900 } }, token, errors);
    assertBrowserTime();
    try {
      const prompt = `${marker} desktop：動作確認です。短く返答してください。`;
      prompts.push(prompt);
      const rendered = await sendFromBrowser(desktop.page, prompt, 1);
      assertBrowserTime();
      const threads = await listThreads(env, fetchImpl, email);
      if (threads.length !== 1) fail("smoke_thread_count_invalid");
      await assertMessagesSaved(env, fetchImpl, threads[0].id, prompts);
      assertBrowserTime();
      await assertReload(desktop.page, prompt, rendered, 1);
      assertBrowserTime();
    } finally {
      await within(desktop.context.close(), 30_000, "smoke_browser_context_close_timeout");
    }

    assertBrowserTime();

    const { devices } = await import("playwright");
    const mobile = await openPage(browser, devices["Pixel 7"], token, errors);
    assertBrowserTime();
    try {
      const prompt = `${marker} mobile：もう一度、短く返答してください。`;
      prompts.push(prompt);
      const rendered = await sendFromBrowser(mobile.page, prompt, 2);
      assertBrowserTime();
      const threads = await listThreads(env, fetchImpl, email);
      if (threads.length !== 1) fail("smoke_thread_count_invalid");
      await assertMessagesSaved(env, fetchImpl, threads[0].id, prompts);
      assertBrowserTime();
      await assertReload(mobile.page, prompt, rendered, 2);
      assertBrowserTime();
    } finally {
      await within(mobile.context.close(), 30_000, "smoke_browser_context_close_timeout");
    }
    assertBrowserTime();
    if (errors.length !== 0) fail("smoke_client_error");
    completed = true;
  } catch (error) {
    primaryError = error;
  } finally {
    clearTimeout(phaseTimer);
    if (browser) {
      try { await within(browser.close(), 30_000, "smoke_browser_close_timeout"); }
      catch { primaryError ??= new FunctionalSmokeError("smoke_browser_close_failed"); }
    }
    try { await cleanupAndVerify(env, fetchImpl, email, runId); }
    catch { primaryError = new FunctionalSmokeError("smoke_cleanup_incomplete"); }
  }
  if (primaryError) throw primaryError;
  assert.equal(completed, true);
  return {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    mergeSha: release.merge_sha,
    deploymentId: deployment.deploymentId,
    desktopBrowser: true,
    mobileBrowser: true,
    streamComplete: true,
    databaseSaved: true,
    reloadPersisted: true,
    testDataCleaned: true,
    clientErrors: 0,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.error("Run through the trusted AI repair observer with a verified release and deployment.");
  process.exitCode = 1;
}
