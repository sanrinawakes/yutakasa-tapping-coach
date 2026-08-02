import { responseTokenLimitFor, SYSTEM_INSTRUCTION } from "./constants";

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

  it("uses bounded generation limits for each requested level of detail", () => {
    expect(responseTokenLimitFor("一文で教えてください")).toBe(160);
    expect(responseTokenLimitFor("要点だけ短く教えてください")).toBe(360);
    expect(responseTokenLimitFor("理由も含めて具体的に教えてください")).toBe(1200);
    expect(responseTokenLimitFor("どうすればよいですか？")).toBe(800);
  });

  it("limits detailed answers to an actionable length and structure", () => {
    expect(SYSTEM_INSTRUCTION).toContain(
      "「詳しく」「具体的に」と指定された回答でも500〜900文字"
    );
    expect(SYSTEM_INSTRUCTION).toContain("手順は原則3段階以内");
    expect(SYSTEM_INSTRUCTION).toContain("最大2か所まで");
  });
});
