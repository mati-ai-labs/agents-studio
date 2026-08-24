import { describe, expect, it } from "vitest";
import { buildIssueCompletionSlackMessage } from "../services/issue-slack-completion.js";

describe("Slack issue completion message", () => {
  it("includes a clickable Paperclip issue link in the fallback and Block Kit text", () => {
    const issue = {
      identifier: "PAP-42",
      title: "Ship Slack links",
    } as Parameters<typeof buildIssueCompletionSlackMessage>[0]["issue"];

    const message = buildIssueCompletionSlackMessage({
      issue,
      slackCompletion: {
        channelId: "C123",
        channelName: "general",
        workspaceId: "T123",
        workspaceName: "Paperclip",
        channelType: "public",
      },
      workProducts: [],
      issueUrl: "https://paperclip.example/PAP/issues/PAP-42",
    });

    expect(message.text).toContain("<https://paperclip.example/PAP/issues/PAP-42|Open in Paperclip>");
    expect((message.blocks[0]?.text as { text?: string }).text).toContain(
      "<https://paperclip.example/PAP/issues/PAP-42|PAP-42 Ship Slack links>",
    );
  });
});
