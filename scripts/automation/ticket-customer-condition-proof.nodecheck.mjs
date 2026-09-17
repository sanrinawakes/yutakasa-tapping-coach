import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { checkRecordedZeroWidthCondition, checkUiCondition,
  checkZeroWidthProductionEvidence, TicketConditionError,
  ZERO_WIDTH_CONDITION, sha256 } from "./ticket-customer-condition-proof.mjs";

const reject = (code) => (error) => error instanceof TicketConditionError && error.code === code;
const ticket = { category: "technical", subject: ZERO_WIDTH_CONDITION.subject };
const latestMessages = [{ id: "opaque", body: ZERO_WIDTH_CONDITION.body }];
const exact = { ticket, latestMessages, attachments: [], newerAdminMessages: [] };
const binding = { latestBodySha256: sha256(ZERO_WIDTH_CONDITION.body),
  subjectSha256: sha256(ZERO_WIDTH_CONDITION.subject) };
const evidence = { titleScenario: {
  scenarioKey: ZERO_WIDTH_CONDITION.scenarioKey,
  inputSha256: sha256(ZERO_WIDTH_CONDITION.input),
  expectedTitle: ZERO_WIDTH_CONDITION.expectedTitle,
  desktopBrowser: true, mobileBrowser: true, dbTitleVerified: true,
  uiTitleVerified: true, reloadTitleVerified: true,
  testDataCleaned: true, clientErrors: 0,
} };

test("the customer preset in the UI matches the trusted server condition", async () => {
  const json = JSON.parse(await readFile(new URL("../../src/lib/support-technical-scenarios.json",
    import.meta.url), "utf8"));
  assert.equal(checkUiCondition(json), true);
  assert.throws(() => checkUiCondition({ chat_title_zero_width: { ...json.chat_title_zero_width,
    body: "unrelated" } }), reject("ticket_condition_ui_contract_changed"));
});

test("only the exact one-message report without files or admin intervention can qualify", () => {
  assert.deepEqual(checkRecordedZeroWidthCondition(exact), {
    latestBodySha256: sha256(ZERO_WIDTH_CONDITION.body),
    subjectSha256: sha256(ZERO_WIDTH_CONDITION.subject),
    inputSha256: sha256(ZERO_WIDTH_CONDITION.input),
  });
  for (const altered of [
    { latestMessages: [{ body: `${ZERO_WIDTH_CONDITION.body} Chromeでだけ` }] },
    { latestMessages: [...latestMessages, ...latestMessages] },
    { ticket: { ...ticket, subject: "チャットが変" } },
    { attachments: [{ id: "file" }] },
    { newerAdminMessages: [{ id: "response" }] },
  ]) {
    assert.throws(() => checkRecordedZeroWidthCondition({ ...exact, ...altered }),
      reject("ticket_condition_not_exact"));
  }
});

test("production evidence requires the same input, browser, database, reload, and cleanup", () => {
  assert.match(checkZeroWidthProductionEvidence(evidence, binding), /^[a-f0-9]{64}$/u);
  for (const changed of [
    { inputSha256: sha256("visible text") },
    { dbTitleVerified: false }, { uiTitleVerified: false },
    { reloadTitleVerified: false }, { mobileBrowser: false },
    { testDataCleaned: false }, { clientErrors: 1 },
  ]) {
    assert.throws(() => checkZeroWidthProductionEvidence({ titleScenario: {
      ...evidence.titleScenario, ...changed } }, binding),
    reject("ticket_condition_production_not_replayed"));
  }
  assert.throws(() => checkZeroWidthProductionEvidence(evidence,
    { ...binding, latestBodySha256: sha256("other ticket") }),
  reject("ticket_condition_production_not_replayed"));
});
