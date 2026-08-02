import { SYSTEM_INSTRUCTION } from "./constants";

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
});
