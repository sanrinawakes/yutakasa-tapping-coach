import { safeLoginDestination } from "./login-destination";

describe("safeLoginDestination", () => {
  it("keeps an internal destination", () => {
    expect(safeLoginDestination("/admin/support?status=open")).toBe(
      "/admin/support?status=open"
    );
  });

  it.each([
    null,
    "",
    "https://example.com",
    "//example.com/path",
    "///example.com/path",
    "/\\example.com/path",
  ])(
    "falls back to chat for %s",
    (value) => {
      expect(safeLoginDestination(value)).toBe("/chat");
    }
  );
});
