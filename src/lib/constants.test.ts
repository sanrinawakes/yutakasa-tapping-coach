import { SYSTEM_INSTRUCTION } from "./constants";
import { isRetryableGeminiError } from "./gemini";

describe("AI response instructions", () => {
  it("gives the user's requested response length priority over the default detail level", () => {
    expect(SYSTEM_INSTRUCTION).toContain(
      "利用者が回答の長さや形式（「一文で」「短く」「箇条書きで」「詳しく」など）を指定した場合は、その指定を最優先してください。"
    );
    expect(SYSTEM_INSTRUCTION).toContain(
      "「一文で」と指定された場合は、前置きや追加質問を付けず、求められた答えだけを一文にまとめてください。"
    );
    expect(SYSTEM_INSTRUCTION).toContain(
      "長さや形式の指定がない場合は"
    );
  });

  it("limits detailed answers to an actionable length and structure", () => {
    expect(SYSTEM_INSTRUCTION).toContain(
      "「詳しく」「具体的に」と指定された回答でも400〜650文字に収めてください。700文字は絶対上限です"
    );
    expect(SYSTEM_INSTRUCTION).toContain("番号付きの実践手順3段階以内");
    expect(SYSTEM_INSTRUCTION).toContain("各手順は見出しと説明を合わせて1文");
    expect(SYSTEM_INSTRUCTION).toContain("一文はおおむね80文字以内");
    expect(SYSTEM_INSTRUCTION).toContain("最大2か所まで");
    expect(SYSTEM_INSTRUCTION).toContain("回答全体で合計2つまで");
    expect(SYSTEM_INSTRUCTION).toContain("引用符「」で囲む練習フレーズも合計2個まで");
    expect(SYSTEM_INSTRUCTION).toContain("よく理解できます");
    expect(SYSTEM_INSTRUCTION).toContain("回答直前の絶対条件");
  });

  it("grounds answers in the retrieved course excerpts", () => {
    expect(SYSTEM_INSTRUCTION).toContain("今回の相談に関連する講座抜粋");
    expect(SYSTEM_INSTRUCTION).toContain(
      "抜粋に根拠がないことを講座の教えとして断定せず"
    );
  });
});

describe("Gemini retry classification", () => {
  it.each([429, 500, 502, 503, 504])("retries HTTP %s", (status) => {
    expect(isRetryableGeminiError({ status })).toBe(true);
  });

  it("retries transient network failures", () => {
    expect(isRetryableGeminiError(new Error("Failed to fetch"))).toBe(true);
    expect(isRetryableGeminiError(new Error("socket ECONNRESET"))).toBe(true);
  });

  it("does not retry invalid requests", () => {
    expect(isRetryableGeminiError({ status: 400 })).toBe(false);
  });
});
