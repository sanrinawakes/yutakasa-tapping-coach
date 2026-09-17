import { createHash } from "node:crypto";

// The supported condition is deliberately exact. A free-text report may
// describe browser, account or network details that this runner cannot replay.
export const ZERO_WIDTH_CONDITION = Object.freeze({
  scenarioKey: "chat_title_zero_width",
  subject: "チャットの見出しが空白になる",
  body: "チャットでゼロ幅スペース（U+200B）だけのメッセージを送ると、会話一覧の見出しが空白になります。",
  input: "\u200b",
  expectedTitle: "新しいチャット",
});

export class TicketConditionError extends Error {
  constructor(code) { super(code); this.name = "TicketConditionError"; this.code = code; }
}
function fail(code) { throw new TicketConditionError(code); }
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function checkUiCondition(data) {
  const condition = data?.[ZERO_WIDTH_CONDITION.scenarioKey];
  if (!data || typeof data !== "object" || Array.isArray(data) ||
      Object.keys(data).length !== 1 || !condition ||
      Object.keys(condition).sort().join(",") !== "body,expectedTitle,input,subject" ||
      condition.subject !== ZERO_WIDTH_CONDITION.subject ||
      condition.body !== ZERO_WIDTH_CONDITION.body ||
      condition.input !== ZERO_WIDTH_CONDITION.input ||
      condition.expectedTitle !== ZERO_WIDTH_CONDITION.expectedTitle) {
    fail("ticket_condition_ui_contract_changed");
  }
  return true;
}

export function checkRecordedZeroWidthCondition({ ticket, latestMessages, attachments,
  newerAdminMessages }) {
  if (ticket?.category !== "technical" ||
      ticket?.subject !== ZERO_WIDTH_CONDITION.subject ||
      !Array.isArray(latestMessages) || latestMessages.length !== 1 ||
      latestMessages[0]?.body !== ZERO_WIDTH_CONDITION.body ||
      !Array.isArray(attachments) || attachments.length !== 0 ||
      !Array.isArray(newerAdminMessages) || newerAdminMessages.length !== 0) {
    fail("ticket_condition_not_exact");
  }
  return { latestBodySha256: sha256(ZERO_WIDTH_CONDITION.body),
    subjectSha256: sha256(ZERO_WIDTH_CONDITION.subject),
    inputSha256: sha256(ZERO_WIDTH_CONDITION.input) };
}

export function checkZeroWidthProductionEvidence(evidence, binding) {
  const title = evidence?.titleScenario;
  if (title?.scenarioKey !== ZERO_WIDTH_CONDITION.scenarioKey ||
      title?.inputSha256 !== sha256(ZERO_WIDTH_CONDITION.input) ||
      title?.expectedTitle !== ZERO_WIDTH_CONDITION.expectedTitle ||
      title?.desktopBrowser !== true || title?.mobileBrowser !== true ||
      title?.dbTitleVerified !== true || title?.uiTitleVerified !== true ||
      title?.reloadTitleVerified !== true || title?.testDataCleaned !== true ||
      title?.clientErrors !== 0 ||
      binding?.latestBodySha256 !== sha256(ZERO_WIDTH_CONDITION.body) ||
      binding?.subjectSha256 !== sha256(ZERO_WIDTH_CONDITION.subject)) {
    fail("ticket_condition_production_not_replayed");
  }
  return sha256(JSON.stringify(title));
}
