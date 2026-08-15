import assert from "node:assert/strict";
import { streamChatCompletion, type ChatMessage } from "../src/lib/gemini";

const question = `受講者から届いた次の質問への返信文を考えてください。
タッピング中、最初に扱っていた相手よりも別の相手への怒りが強く出てきました。
① 今いちばん強く出ている相手へ対象を変える進め方で大丈夫ですか？
② 最初の相手への怒りは全くなくなり、その怒りがあったことも忘れていました。十分に感情を扱えたと考えてよいですか？
連絡に気づくのが1ヶ月以上遅れたので、申し訳ないという謝罪も入れてください。`;

async function readText(stream: ReadableStream<string>) {
  const reader = stream.getReader();
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return output;
    output += value;
  }
}

function assertReply(output: string, direct: boolean) {
  assert.match(output, /①/u);
  assert.match(output, /②/u);
  assert.match(output, /(?:1|１|一)\s*(?:か月|カ月|ケ月|ヶ月|箇月)(?:以上)?/u);
  assert.match(output, /(?:申し訳|お詫び|すみません)/u);
  assert.doesNotMatch(
    output,
    /(?:具体的な)?(?:質問|内容).{0,20}(?:確認|把握)でき(?:ません|ない)/u
  );
  assert.doesNotMatch(output, /自分には価値がない/u);
  assert.doesNotMatch(
    output,
    /(?:必ず|確実に).{0,30}(?:外れ|治(?:る|り)|改善|なくな|解消)/u
  );
  if (direct) {
    assert.match(output, /①[\s\S]{0,160}(?:はい|いいえ|大丈夫です|問題ありません)/u);
    assert.match(
      output,
      /②[\s\S]{0,160}(?:はい|いいえ|十分とは|忘れただけでは)/u
    );
  }
  const secondAnswer = output.slice(output.indexOf("②"));
  assert.match(secondAnswer.slice(0, 160), /はい/u);
  assert.match(
    secondAnswer,
    /(?:思い出|思い浮かべ|イメージ|対象.{0,20}考え)/u
  );
  assert.match(secondAnswer, /(?:数値|強度|測|確認)/u);
  assert.match(secondAnswer, /3\s*以下/u);
}

async function main() {
  const firstOutput = await readText(
    await streamChatCompletion([{ role: "user", content: question }])
  );
  assertReply(firstOutput, true);

  const correctionConversation: ChatMessage[] = [
    { role: "user", content: question },
    {
      role: "assistant",
      content: "怒りには複数の層があります。タッピングを続けてください。",
    },
    {
      role: "user",
      content: "1ヶ月以上経ってしまったニュアンスをもっと明確に入れて。",
    },
    { role: "assistant", content: "返信が遅くなり申し訳ありません。" },
    { role: "user", content: "①と②に答えてないやん。" },
    { role: "assistant", content: "質問をもう一度送ってください。" },
    {
      role: "user",
      content: "イエスかノーか、①と②に真面目に答えて。",
    },
  ];
  const correctionOutput = await readText(
    await streamChatCompletion(correctionConversation)
  );
  assertReply(correctionOutput, true);

  console.log("Initial draft reply:\n", firstOutput);
  console.log("Correction-turn draft reply:\n", correctionOutput);
  console.log("Live conversation quality verification passed:", {
    cases: 2,
    firstChars: Array.from(firstOutput).length,
    correctionChars: Array.from(correctionOutput).length,
  });
}

main().catch((error) => {
  console.error("Live conversation quality verification failed:", error);
  process.exitCode = 1;
});
