import React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConversationLaunchView } from "#/components/features/chat/conversation-launch-view";
import { NavigationProvider } from "#/context/navigation-context";
import { ActiveBackendProvider } from "#/contexts/active-backend-context";
import {
  setActiveSelection,
  setRegisteredBackends,
} from "#/api/backend-registry/active-store";
import { useConversationLaunchStore } from "#/stores/conversation-launch-store";
import { useConversationStore } from "#/stores/conversation-store";
import AgentServerConversationService from "#/api/conversation-service/agent-server-conversation-service.api";
import type { AppConversation } from "#/api/conversation-service/agent-server-conversation-service.types";

vi.mock(
  "#/api/conversation-service/agent-server-conversation-service.api",
  () => ({
    default: { batchGetAppConversations: vi.fn() },
  }),
);

vi.mock("#/components/features/chat/interactive-chat-box", () => ({
  InteractiveChatBox: () => <textarea disabled aria-label="Message" />,
}));

vi.mock(
  "#/components/features/conversation/conversation-main/conversation-main",
  () => ({
    ConversationMain: ({ children }: React.PropsWithChildren) => (
      <>{children}</>
    ),
  }),
);

const navigate = vi.fn();
let queryClient: QueryClient;
function view(id: string) {
  return (
    <QueryClientProvider client={queryClient}>
      <ActiveBackendProvider>
        <NavigationProvider
          value={{
            navigate,
            currentPath: `/conversations/${id}`,
            conversationId: id,
            isNavigating: false,
          }}
        >
          <ConversationLaunchView launchId={id} />
        </NavigationProvider>
      </ActiveBackendProvider>
    </QueryClientProvider>
  );
}
function begin() {
  return useConversationLaunchStore.getState().begin({
    backendId: "cloud",
    orgId: "org-1",
    message: "Please investigate",
    files: [],
  });
}

function makeConversation(id: string): AppConversation {
  return {
    id,
    created_by_user_id: null,
    selected_repository: null,
    selected_branch: null,
    git_provider: null,
    title: "Checking connectivity",
    trigger: null,
    pr_number: [],
    llm_model: null,
    metrics: null,
    created_at: "2026-11-19T01:17:20Z",
    updated_at: "2026-11-19T01:17:20Z",
    execution_status: null,
    sandbox_status: "RUNNING",
    conversation_url: "https://sandbox.example.test",
    session_api_key: null,
    sandbox_id: "sandbox-1",
    sub_conversation_ids: [],
  };
}

beforeEach(() => {
  navigate.mockClear();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  vi.mocked(
    AgentServerConversationService.batchGetAppConversations,
  ).mockReset();
  useConversationLaunchStore.setState({ launches: {} });
  useConversationStore.getState().clearAllFiles();
  useConversationStore.getState().clearMessageToSend();
  setRegisteredBackends([
    {
      id: "cloud",
      name: "Cloud",
      host: "https://example.test",
      apiKey: "",
      kind: "cloud",
    },
  ]);
  setActiveSelection({ backendId: "cloud", orgId: "org-1" });
});
afterEach(() => {
  setRegisteredBackends([]);
});

describe("pending conversation navigation", () => {
  it("shows the prompt immediately and follows an accepted start only when the user returns", () => {
    const id = begin();
    const page = render(view(id));
    expect(screen.getByText("Please investigate")).toBeVisible();
    expect(screen.getByRole("textbox")).toBeDisabled();
    page.unmount();
    act(() =>
      useConversationLaunchStore
        .getState()
        .update(id, { targetId: "task-123" }),
    );
    expect(navigate).not.toHaveBeenCalled();
    render(view(id));
    expect(navigate).toHaveBeenCalledExactlyOnceWith(
      "/conversations/task-123",
      { replace: true },
    );
  });

  it("waits for a new conversation to become readable before navigating", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const id = begin();
    vi.mocked(AgentServerConversationService.batchGetAppConversations)
      .mockResolvedValueOnce([])
      .mockResolvedValue([makeConversation("conversation-123")]);
    useConversationLaunchStore
      .getState()
      .update(id, { targetId: "conversation-123" });

    render(view(id));

    await waitFor(() =>
      expect(
        AgentServerConversationService.batchGetAppConversations,
      ).toHaveBeenCalledTimes(1),
    );
    expect(navigate).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledExactlyOnceWith(
        "/conversations/conversation-123",
        { replace: true },
      ),
    );
  });

  it("keeps a failed prompt and files available to edit", () => {
    const file = new File(["notes"], "notes.txt");
    const id = useConversationLaunchStore.getState().begin({
      backendId: "cloud",
      orgId: "org-1",
      message: "Read my notes",
      files: [file],
      attachments: {
        content: "Read my notes",
        files: [file],
        images: [],
        imagesMarkedUploadAsFile: [],
      },
    });
    const page = render(view(id));
    act(() =>
      useConversationLaunchStore
        .getState()
        .update(id, { error: "Cannot start" }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Cannot start");
    expect(screen.getByRole("textbox")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "BUTTON$EDIT" }));
    expect(useConversationStore.getState().messageToSend).toMatchObject({
      text: "Read my notes",
      target: "home",
    });
    expect(useConversationStore.getState().files).toEqual([file]);
    expect(navigate).toHaveBeenCalledWith("/conversations");
    expect(screen.getByText("Read my notes")).toBeVisible();
    page.unmount();
    expect(useConversationLaunchStore.getState().launches[id]).toBeUndefined();
  });

  it("does not reveal a pending prompt or redirect after switching organizations", () => {
    const id = begin();
    useConversationLaunchStore
      .getState()
      .update(id, { targetId: "task-private" });
    setActiveSelection({ backendId: "cloud", orgId: "org-2" });
    render(view(id));
    expect(screen.queryByText("Please investigate")).not.toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "COMMON$BACK" })).toBeVisible();
  });
});
