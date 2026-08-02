import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ChatSidebar from "./ChatSidebar";

vi.mock("./ThemeProvider", () => ({
  useTheme: () => ({ theme: "light", toggleTheme: vi.fn() }),
}));

describe("ChatSidebar", () => {
  const thread = {
    id: "thread-1",
    user_email: "member@example.com",
    title: "仕事への不安",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T01:00:00.000Z",
  };

  it("shows history, the signed-in email and a title editor", async () => {
    const onRenameThread = vi.fn().mockResolvedValue(undefined);
    render(
      <ChatSidebar
        threads={[thread]}
        currentThreadId={thread.id}
        onSelectThread={vi.fn()}
        onCreateThread={vi.fn()}
        onDeleteThread={vi.fn()}
        onRenameThread={onRenameThread}
        onLogout={vi.fn()}
        currentUserEmail="member@example.com"
        isOpen
        onToggle={vi.fn()}
      />
    );

    expect(screen.getByText("会話履歴")).toBeInTheDocument();
    expect(screen.getByText("member@example.com")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "題名を変更" }));
    const input = screen.getByLabelText("会話の題名");
    fireEvent.change(input, { target: { value: "新しい題名" } });
    fireEvent.click(screen.getByRole("button", { name: "題名を保存" }));

    await waitFor(() => {
      expect(onRenameThread).toHaveBeenCalledWith("thread-1", "新しい題名");
    });
  });

  it("uses separate mobile controls for opening and closing the menu", () => {
    const props = {
      threads: [thread],
      currentThreadId: thread.id,
      onSelectThread: vi.fn(),
      onCreateThread: vi.fn(),
      onDeleteThread: vi.fn(),
      onRenameThread: vi.fn(),
      onLogout: vi.fn(),
      currentUserEmail: "member@example.com",
      onToggle: vi.fn(),
    };
    const { rerender } = render(<ChatSidebar {...props} isOpen />);

    expect(
      screen.getByRole("button", { name: "メニューを閉じる" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "メニューを開く" })
    ).not.toBeInTheDocument();

    rerender(<ChatSidebar {...props} isOpen={false} />);

    expect(
      screen.getByRole("button", { name: "メニューを開く" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "メニューを閉じる" })
    ).not.toBeInTheDocument();
  });

  it("does not show an empty history while conversations are still loading", () => {
    render(
      <ChatSidebar
        threads={[]}
        currentThreadId={null}
        onSelectThread={vi.fn()}
        onCreateThread={vi.fn()}
        onDeleteThread={vi.fn()}
        onRenameThread={vi.fn()}
        onLogout={vi.fn()}
        currentUserEmail={null}
        isLoadingThreads
        isOpen
        onToggle={vi.fn()}
      />
    );

    expect(screen.getByText("読込中")).toBeInTheDocument();
    expect(screen.getByText("会話履歴を読み込んでいます")).toBeInTheDocument();
    expect(screen.queryByText("0件")).not.toBeInTheDocument();
    expect(screen.queryByText("チャットを始めましょう")).not.toBeInTheDocument();
  });
});
