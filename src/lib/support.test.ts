import {
  detectSupportFileType,
  isSupportAutomationStatus,
  isSupportCategory,
  isSupportStatus,
  normalizeSupportText,
  parseClientRequestId,
  requiresOwnerDecision,
  sanitizeSupportFilename,
} from "./support";

describe("support helpers", () => {
  it("recognizes only configured categories and statuses", () => {
    expect(isSupportCategory("technical")).toBe(true);
    expect(isSupportCategory("refund")).toBe(false);
    expect(isSupportStatus("waiting_user")).toBe(true);
    expect(isSupportStatus("deleted")).toBe(false);
    expect(isSupportAutomationStatus("blocked_decision")).toBe(true);
    expect(isSupportAutomationStatus("running")).toBe(false);
  });

  it("normalizes line endings, whitespace and maximum length", () => {
    expect(normalizeSupportText("  a\r\nb\r c  ", 5)).toBe("a\nb");
  });

  it("requires an owner decision for money, contracts and legal issues", () => {
    expect(requiresOwnerDecision("billing", "確認", "お願いします")).toBe(true);
    expect(
      requiresOwnerDecision("technical", "二重請求", "返金を希望します")
    ).toBe(true);
    expect(
      requiresOwnerDecision("technical", "画面が止まる", "送信できません")
    ).toBe(false);
  });

  it("accepts valid UUIDs and rejects malformed request IDs", () => {
    expect(
      parseClientRequestId("2E4710DB-9274-4E4C-96C4-59DC97E21C8D")
    ).toBe("2e4710db-9274-4e4c-96c4-59dc97e21c8d");
    expect(parseClientRequestId("not-a-uuid")).toBeNull();
  });

  it.each([
    [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png"],
    [new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"],
    [
      new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
      "image/webp",
    ],
    [
      new Uint8Array([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]),
      "image/heic",
    ],
  ])("detects image bytes instead of trusting the filename", (bytes, expected) => {
    expect(detectSupportFileType(bytes)?.contentType).toBe(expected);
  });

  it("rejects scripts renamed to an image", () => {
    expect(detectSupportFileType(new TextEncoder().encode("<script>"))).toBeNull();
  });

  it("removes path characters from stored filenames", () => {
    expect(sanitizeSupportFilename("../相談\\画像?.png", "jpg")).toBe(
      "..-相談-画像-.jpg"
    );
  });
});
