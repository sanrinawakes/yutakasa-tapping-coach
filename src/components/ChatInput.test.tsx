import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ChatInput from "./ChatInput";

describe("ChatInput", () => {
  it("labels the daily remaining count without looking like an AI citation", () => {
    render(
      <ChatInput
        onSendMessage={vi.fn()}
        remainingMessages={12}
        dailyLimit={15}
      />
    );

    expect(
      screen.getByText("本日の残り利用回数: 12回（上限15回）")
    ).toBeInTheDocument();
  });

  it("does not send while Japanese text conversion is being confirmed", async () => {
    const onSendMessage = vi.fn();
    render(<ChatInput onSendMessage={onSendMessage} />);
    const input = screen.getByPlaceholderText("メッセージを入力...");

    fireEvent.change(input, { target: { value: "日本語" } });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229, isComposing: true });
    expect(onSendMessage).not.toHaveBeenCalled();

    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    await waitFor(() => {
      expect(onSendMessage).toHaveBeenCalledWith("日本語");
    });
  });

  it("does not send the same message twice when Enter is pressed rapidly", () => {
    const onSendMessage = vi.fn(() => new Promise<boolean>(() => {}));
    render(<ChatInput onSendMessage={onSendMessage} />);
    const input = screen.getByPlaceholderText("メッセージを入力...");

    fireEvent.change(input, { target: { value: "二重送信しない" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    expect(onSendMessage).toHaveBeenCalledTimes(1);
  });
});
