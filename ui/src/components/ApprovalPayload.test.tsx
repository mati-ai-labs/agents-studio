// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalPayloadRenderer, approvalLabel } from "./ApprovalPayload";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("approvalLabel", () => {
  it("uses payload titles for generic board approvals", () => {
    expect(
      approvalLabel("request_board_approval", {
        title: "Reply with an ASCII frog",
      }),
    ).toBe("Board Approval: Reply with an ASCII frog");
  });
});

describe("ApprovalPayloadRenderer", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders request_board_approval payload fields without falling back to raw JSON", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          payload={{
            title: "Reply with an ASCII frog",
            summary: "Board asked for approval before posting the frog.",
            recommendedAction: "Approve the frog reply.",
            nextActionOnApproval: "Post the frog comment on the issue.",
            risks: ["The frog might be too powerful."],
            proposedComment: "(o)<",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Reply with an ASCII frog");
    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).toContain("Approve the frog reply.");
    expect(container.textContent).toContain("Post the frog comment on the issue.");
    expect(container.textContent).toContain("The frog might be too powerful.");
    expect(container.textContent).toContain("(o)<");
    expect(container.textContent).not.toContain("\"recommendedAction\"");

    act(() => {
      root.unmount();
    });
  });

  it("can hide the repeated title when the card header already shows it", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          hidePrimaryTitle
          payload={{
            title: "Reply with an ASCII frog",
            summary: "Board asked for approval before posting the frog.",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).not.toContain("TitleReply with an ASCII frog");

    act(() => {
      root.unmount();
    });
  });

  it("renders a guardrail_action approval as the parked tool call, not as a CEO strategy", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="guardrail_action"
          payload={{
            title: "Approve guarded tool action: github:merge_pr",
            tool: "github:merge_pr",
            policyName: "Merges need a human",
            stage: "action",
            arguments: { repo: "mati-ai-labs/agents-studio", number: 48 },
          }}
        />,
      );
    });
    expect(container.textContent).toContain("github:merge_pr");
    expect(container.textContent).toContain("Merges need a human");
    expect(container.textContent).toContain("Tool call (before it runs)");
    expect(container.textContent).toContain("mati-ai-labs/agents-studio");
    expect(approvalLabel("guardrail_action", { toolName: "x" })).toBe("Guardrail");
    act(() => root.unmount());
  });

  it("shows the parked studio request and what happened after approval", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="guardrail_action"
          payload={{
            studioAction: true,
            summary: "CEO wants to: Create a sub-issue.",
            tool: "paperclip:issue.create_subissue",
            policyName: "Agents need my approval for decisions",
            stage: "action",
            request: { method: "POST", path: "/companies/c1/issues", body: { title: "x" } },
            arguments: { title: "x", parentId: "p1" },
            execution: { executed: true, status: 201, created: 'LCH-500 "x"' },
          }}
        />,
      );
    });
    expect(container.textContent).toContain("CEO wants to: Create a sub-issue.");
    expect(container.textContent).toContain("POST /companies/c1/issues");
    expect(container.textContent).toContain('Carried out: LCH-500 "x"');
    act(() => root.unmount());
  });
});

