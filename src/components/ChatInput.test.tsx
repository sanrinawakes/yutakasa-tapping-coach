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

  it("uses Enter for a newline and sends only from the send button", async () => {
    const onSendMessage = vi.fn();
    render(<ChatInput onSendMessage={onSendMessage} />);
    const input = screen.getByPlaceholderText("メッセージを入力...");

    fireEvent.change(input, { target: { value: "日本語" } });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229, isComposing: true });
    expect(onSendMessage).not.toHaveBeenCalled();

    fireEvent.compositionEnd(input);
    expect(fireEvent.keyDown(input, { key: "Enter", code: "Enter" })).toBe(true);
    fireEvent.change(input, { target: { value: "日本語\n改行後" } });
    expect(input).toHaveValue("日本語\n改行後");
    expect(onSendMessage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    await waitFor(() => {
      expect(onSendMessage).toHaveBeenCalledWith("日本語\n改行後");
    });
  });

  it("does not send the same message twice when the send button is clicked rapidly", () => {
    const onSendMessage = vi.fn(() => new Promise<boolean>(() => {}));
    render(<ChatInput onSendMessage={onSendMessage} />);
    const input = screen.getByPlaceholderText("メッセージを入力...");

    fireEvent.change(input, { target: { value: "二重送信しない" } });
    const sendButton = screen.getByRole("button", { name: "送信" });
    fireEvent.click(sendButton);
    fireEvent.click(sendButton);

    expect(onSendMessage).toHaveBeenCalledTimes(1);
  });
});
