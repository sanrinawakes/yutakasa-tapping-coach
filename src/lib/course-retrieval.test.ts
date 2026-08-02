import {
  getCourseContentMetadata,
  resetCourseSearchIndex,
  selectCourseContext,
} from "./course-retrieval";

function contextFor(message: string) {
  return selectCourseContext([{ role: "user", content: message }]);
}

describe("course content retrieval", () => {
  afterEach(() => {
    resetCourseSearchIndex();
  });

  it("loads every course source while sending only a bounded relevant context", () => {
    const metadata = getCourseContentMetadata();
    const context = contextFor(
      "お金を受け取ることに罪悪感があります。タッピングの進め方を具体的に教えてください。"
    );

    expect(metadata.sourceCount).toBe(42);
    expect(metadata.sourceChars).toBeGreaterThan(400_000);
    expect(context.chunkIds.length).toBeGreaterThan(0);
    expect(context.chunkIds.length).toBeLessThanOrEqual(4);
    expect(context.selectedChars).toBeLessThanOrEqual(13_000);
    expect(context.selectedChars).toBeLessThan(context.sourceChars / 10);
    expect(context.content).not.toContain("関連抜粋");
    expect(context.content).not.toMatch(/【\s*\d+(?:[-ー―−]\d+)?(?:回)?\s*】/u);
    expect(context.titles.some((title) => /第17回|第19回/u.test(title))).toBe(
      true
    );
    expect(context.titles.some((title) => /第1回/u.test(title))).toBe(true);
  });

  it.each([
    ["借金やローンへの不安を手放したい", /第12回/u],
    [
      "借金の返済を考えると不安で動けません。今夜できるタッピングを具体的に教えてください。",
      /第12回/u,
    ],
    ["お金持ちになることへの抵抗があります", /第20回|第21回/u],
    ["家族から受け継いだ価値観を変えたい", /第6回/u],
    ["大きな目標設定が怖いです", /第14回|第15回/u],
  ])("retrieves the matching lesson for %s", (query, expectedTitle) => {
    expect(contextFor(query).titles.some((title) => expectedTitle.test(title))).toBe(
      true
    );
  });

  it("gives an explicitly requested lesson priority", () => {
    const context = contextFor("講座の第7回について説明してください");

    expect(context.titles[0]).toMatch(/第7回/u);
  });

  it("puts a detected topic lesson before general tapping material", () => {
    const context = contextFor(
      "借金の返済を考えると不安です。今夜できるタッピングを教えてください。"
    );

    expect(context.titles[0]).toMatch(/第12回/u);
    expect(context.titles.some((title) => /第1回/u.test(title))).toBe(true);
  });
});
