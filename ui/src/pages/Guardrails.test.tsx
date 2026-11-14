// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import {
  Guardrails,
  GuardrailPolicyEditor,
  GuardrailSimulationResults,
  draftToPolicyPayload,
  type PolicyDraft,
  approvalPresetDraft,
  ruleDraft,
  validateDraft,
} from "./Guardrails";

const listPoliciesMock = vi.hoisted(() => vi.fn());
const createPolicyMock = vi.hoisted(() => vi.fn());
const updatePolicyMock = vi.hoisted(() => vi.fn());
const deletePolicyMock = vi.hoisted(() => vi.fn());
const simulateMock = vi.hoisted(() => vi.fn());
const listViolationsMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/guardrails", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/guardrails")>()),
  guardrailsApi: {
    listPolicies: (companyId: string) => listPoliciesMock(companyId),
    createPolicy: (companyId: string, payload: unknown) => createPolicyMock(companyId, payload),
    updatePolicy: (companyId: string, policyId: string, payload: unknown) =>
      updatePolicyMock(companyId, policyId, payload),
    deletePolicy: (companyId: string, policyId: string) => deletePolicyMock(companyId, policyId),
    simulate: (companyId: string, payload: unknown) => simulateMock(companyId, payload),
    listViolations: (companyId: string, query?: unknown) => listViolationsMock(companyId, query),
  },
}));

vi.mock("@/api/agents", () => ({
  agentsApi: { list: vi.fn().mockResolvedValue([]) },
}));

vi.mock("@/api/projects", () => ({
  projectsApi: { list: vi.fn().mockResolvedValue([]) },
}));

vi.mock("@/api/goals", () => ({
  goalsApi: { list: vi.fn().mockResolvedValue([]) },
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "paperclip" },
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: vi.fn() }),
  useToast: () => ({ pushToast: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Radix's Select calls hasPointerCapture/setPointerCapture, which jsdom does
// not implement. Stub them so the trigger can be opened in a test.
if (typeof Element !== "undefined" && !Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = function hasPointerCapture() {
    return false;
  };
  Element.prototype.setPointerCapture = function setPointerCapture() {};
  Element.prototype.releasePointerCapture = function releasePointerCapture() {};
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function baseDraft(overrides: Partial<PolicyDraft> = {}): PolicyDraft {
  return {
    name: "No client PII outbound",
    description: "",
    scopeType: "company",
    scopeId: "",
    stage: "input",
    kind: "regex",
    action: "redact",
    severity: "high",
    enabled: true,
    patterns: "\\b\\d{3}-\\d{2}-\\d{4}\\b",
    values: "",
    piiTypes: [],
    secretTypes: [],
    toolNames: "",
    connectorTypes: "",
    argumentPatterns: "",
    fields: ["comment"],
    rule: "",
    ...overrides,
  };
}

function policyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "policy-1",
    companyId: "company-1",
    scopeType: "company",
    scopeId: null,
    stage: "input",
    name: "No client PII outbound",
    description: null,
    kind: "regex",
    matcher: { kind: "regex", patterns: ["\\b\\d{3}-\\d{2}-\\d{4}\\b"] },
    action: "redact",
    severity: "high",
    enabled: true,
    version: 1,
    createdAt: "2026-04-10T00:00:00.000Z",
    updatedAt: "2026-04-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("draftToPolicyPayload", () => {
  it("tags the matcher with the policy kind so it stays self-describing", () => {
    expect(draftToPolicyPayload(baseDraft({ kind: "regex" })).matcher).toEqual({
      kind: "regex",
      patterns: ["\\b\\d{3}-\\d{2}-\\d{4}\\b"],
      fields: ["comment"],
    });

    expect(draftToPolicyPayload(baseDraft({ kind: "pii", piiTypes: ["email"] })).matcher).toEqual({
      kind: "pii",
      piiTypes: ["email"],
      fields: ["comment"],
    });

    expect(
      draftToPolicyPayload(baseDraft({ kind: "secret", secretTypes: ["jwt"] })).matcher,
    ).toEqual({
      kind: "secret",
      secretTypes: ["jwt"],
      fields: ["comment"],
    });

    expect(
      draftToPolicyPayload(baseDraft({ kind: "allowlist", values: "a\nb" })).matcher,
    ).toEqual({
      kind: "allowlist",
      values: ["a", "b"],
      fields: ["comment"],
    });
  });

  it("splits restricted action argument patterns into path and pattern pairs", () => {
    const payload = draftToPolicyPayload(
      baseDraft({
        kind: "restricted_action",
        toolNames: "gmail_send",
        connectorTypes: "",
        argumentPatterns: "recipient=.*@external\\.com\nto=someone",
      }),
    );

    expect(payload.matcher).toEqual({
      kind: "restricted_action",
      toolNames: ["gmail_send"],
      argumentPatterns: [
        { path: "recipient", pattern: ".*@external\\.com" },
        { path: "to", pattern: "someone" },
      ],
    });
  });

  it("omits the scope id for a company-scoped policy", () => {
    const payload = draftToPolicyPayload(baseDraft({ scopeType: "company" }));
    expect(payload.scopeId).toBeNull();
  });
});

describe("GuardrailPolicyEditor", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("swaps the matcher fields to match the policy kind", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <GuardrailPolicyEditor
          draft={baseDraft({ kind: "allowlist" })}
          fieldErrors={{}}
          formError={null}
          isPending={false}
          submitLabel="Create policy"
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("Allowed values");
    expect(container.textContent).not.toContain("Patterns");
    expect(container.textContent).toContain("Fields to match");

    await act(async () => {
      root.unmount();
    });

    const restrictedRoot = createRoot(container);
    await act(async () => {
      restrictedRoot.render(
        <GuardrailPolicyEditor
          draft={baseDraft({ kind: "restricted_action" })}
          fieldErrors={{}}
          formError={null}
          isPending={false}
          submitLabel="Create policy"
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("Tool names");
    expect(container.textContent).toContain("Connector types");
    expect(container.textContent).toContain("Argument patterns");
    // A restricted action matches the tool, not free text, so there is no
    // field restriction to pick.
    expect(container.textContent).not.toContain("Fields to match");

    await act(async () => {
      restrictedRoot.unmount();
    });
  });

  it("offers the credential kinds a secret policy can select", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <GuardrailPolicyEditor
          draft={baseDraft({ kind: "secret" })}
          fieldErrors={{}}
          formError={null}
          isPending={false}
          submitLabel="Create policy"
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("Credential kinds to match");
    expect(container.textContent).toContain("provider_api_key");
    expect(container.textContent).toContain("jwt");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders the errors the shared schema produced against the field they belong to", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <GuardrailPolicyEditor
          draft={baseDraft()}
          fieldErrors={{
            name: "Name is required",
            "matcher.patterns": "Add at least one pattern",
          }}
          formError="Fix the highlighted fields and try again."
          isPending={false}
          submitLabel="Create policy"
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
    });
    await flushReact();

    const alerts = Array.from(container.querySelectorAll('[role="alert"]')).map(
      (node) => node.textContent,
    );
    expect(alerts).toContain("Name is required");
    expect(alerts).toContain("Add at least one pattern");
    expect(alerts).toContain("Fix the highlighted fields and try again.");

    await act(async () => {
      root.unmount();
    });
  });
});

describe("GuardrailSimulationResults", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("shows each policy that would fire, the action it takes and the excerpt that matched", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <GuardrailSimulationResults
          result={{
            action: "block",
            decisive: {
              policyId: "policy-1",
              policyName: "Block outbound PII",
              kind: "pii",
              action: "block",
              severity: "critical",
              scopeType: "company",
              scopeId: null,
              policyVersion: 3,
              matchedField: "any",
              excerpt: "call 555-12-3456 now",
            },
            matches: [
              {
                policyId: "policy-1",
                policyName: "Block outbound PII",
                kind: "pii",
                action: "block",
                severity: "critical",
                scopeType: "company",
                scopeId: null,
                policyVersion: 3,
                matchedField: "any",
                excerpt: "call 555-12-3456 now",
              },
              {
                policyId: "policy-2",
                policyName: "Redact secrets",
                kind: "secret",
                action: "redact",
                severity: "medium",
                scopeType: "agent",
                scopeId: "agent-1",
                policyVersion: 1,
                matchedField: "tool_result",
                excerpt: "token=[REDACTED]",
              },
            ],
            redactedText: null,
          }}
        />,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("Block");
    expect(container.textContent).toContain("Block outbound PII");
    expect(container.textContent).toContain("Redact secrets");
    expect(container.textContent).toContain("call 555-12-3456 now");
    expect(container.textContent).toContain("2 policies would fire");
    expect(container.textContent).toContain("Decided by");
    expect(container.textContent).toContain("One agent");

    await act(async () => {
      root.unmount();
    });
  });

  it("says so when no policy would fire", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <GuardrailSimulationResults
          result={{ action: "allow", decisive: null, matches: [], redactedText: null }}
        />,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("No policy would fire on this sample.");
    expect(container.textContent).toContain("Allow");

    await act(async () => {
      root.unmount();
    });
  });

  it("shows the redacted text when the outcome was a redaction", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <GuardrailSimulationResults
          result={{
            action: "redact",
            decisive: null,
            matches: [],
            redactedText: "call [REDACTED] now",
          }}
        />,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("Redacted sample");
    expect(container.textContent).toContain("call [REDACTED] now");

    await act(async () => {
      root.unmount();
    });
  });
});

describe("Guardrails", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    listPoliciesMock.mockResolvedValue([policyRow()]);
    listViolationsMock.mockResolvedValue([]);
    createPolicyMock.mockResolvedValue(policyRow());
    updatePolicyMock.mockResolvedValue(policyRow({ version: 2 }));
    deletePolicyMock.mockResolvedValue(policyRow());
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderPage() {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <Guardrails />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    return root;
  }

  it("lists the policies for the current company", async () => {
    const root = await renderPage();

    expect(listPoliciesMock).toHaveBeenCalledWith("company-1");
    expect(container.textContent).toContain("No client PII outbound");
    expect(container.textContent).toContain("Regex");
    expect(container.textContent).toContain("Whole company");

    await act(async () => {
      root.unmount();
    });
  });

  it("shows how many times each policy has fired", async () => {
    listViolationsMock.mockResolvedValue([
      {
        id: "violation-1",
        companyId: "company-1",
        policyId: "policy-1",
        policyVersion: 1,
        stage: "input",
        actionTaken: "block",
        actorAgentId: "agent-1",
        heartbeatRunId: "run-1",
        subjectKind: "issue_comment",
        subjectId: null,
        matchedExcerpt: "the blocked text",
        resolved: false,
        createdAt: "2026-04-10T00:00:00.000Z",
      },
      {
        id: "violation-2",
        companyId: "company-1",
        policyId: "policy-1",
        policyVersion: 1,
        stage: "output",
        actionTaken: "redact",
        actorAgentId: "agent-1",
        heartbeatRunId: null,
        subjectKind: "tool_result",
        subjectId: null,
        matchedExcerpt: null,
        resolved: false,
        createdAt: "2026-04-11T00:00:00.000Z",
      },
    ]);

    const root = await renderPage();

    expect(container.textContent).toContain("2 fires");
    expect(container.textContent).toContain("last ");

    await act(async () => {
      root.unmount();
    });
  });

  it("shows a policy that has never fired as having no fires", async () => {
    const root = await renderPage();

    expect(container.textContent).toContain("0 fires");

    await act(async () => {
      root.unmount();
    });
  });

  it("evaluates the unsaved draft alongside the saved policies when simulating", async () => {
    simulateMock.mockResolvedValue({
      action: "block",
      decisive: null,
      matches: [],
      redactedText: null,
    });

    const root = await renderPage();

    // Select a policy, then open it in the editor so there is a draft to test.
    const policyButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("No client PII outbound"),
    );
    expect(policyButton).toBeTruthy();
    await act(async () => {
      policyButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const editButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "Edit",
    );
    expect(editButton).toBeTruthy();
    await act(async () => {
      editButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const simulationTab = Array.from(container.querySelectorAll('[role="tab"]')).find(
      (tab) => tab.textContent === "Simulation",
    );
    await act(async () => {
      simulationTab?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    });
    await flushReact();

    const sampleInput = document.body.querySelector<HTMLTextAreaElement>(
      "#guardrail-simulate-sample",
    );
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(sampleInput, "call 555-12-3456 now");
      sampleInput?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();

    const simulateButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "Simulate",
    );
    await act(async () => {
      simulateButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(simulateMock).toHaveBeenCalledWith("company-1", {
      stage: "input",
      subject: "call 555-12-3456 now",
      subjectFields: { comment: "call 555-12-3456 now" },
      policyIds: ["policy-1"],
      candidatePolicy: expect.objectContaining({
        kind: "regex",
        action: "redact",
        matcher: expect.objectContaining({ kind: "regex" }),
      }),
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("rejects a draft the shared schema does not accept and does not call the API", async () => {
    const root = await renderPage();

    const newPolicyButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "New policy",
    );
    expect(newPolicyButton).toBeTruthy();

    await act(async () => {
      newPolicyButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    // The new-policy draft starts blank, so the shared schema rejects the
    // empty name and the empty pattern list.
    const createButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "Create policy",
    );
    expect(createButton).toBeTruthy();

    await act(async () => {
      createButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(createPolicyMock).not.toHaveBeenCalled();
    const alerts = Array.from(document.body.querySelectorAll('[role="alert"]')).map(
      (node) => node.textContent,
    );
    expect(alerts).toContain("Fix the highlighted fields and try again.");

    await act(async () => {
      root.unmount();
    });
  });

  it("shows the API's own validation errors inline against the field they belong to", async () => {
    createPolicyMock.mockRejectedValue(
      new ApiError("Validation error", 400, {
        error: "Validation error",
        details: [{ path: ["name"], message: "Name is required" }],
      }),
    );

    const root = await renderPage();

    const newPolicyButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "New policy",
    );
    await act(async () => {
      newPolicyButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const nameInput = document.body.querySelector<HTMLInputElement>("#guardrail-name");
    expect(nameInput).toBeTruthy();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(nameInput, "A policy name");
      nameInput?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();

    const createButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "Create policy",
    );
    await act(async () => {
      createButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const alerts = Array.from(document.body.querySelectorAll('[role="alert"]')).map(
      (node) => node.textContent,
    );
    expect(alerts).toContain("Name is required");

    await act(async () => {
      root.unmount();
    });
  });

  it("simulates a sample and renders the policies that would fire", async () => {
    simulateMock.mockResolvedValue({
      action: "block",
      decisive: {
        policyId: "policy-1",
        policyName: "Block outbound PII",
        kind: "pii",
        action: "block",
        severity: "critical",
        scopeType: "company",
        scopeId: null,
        policyVersion: 3,
        matchedField: "any",
        excerpt: "call 555-12-3456 now",
      },
      matches: [
        {
          policyId: "policy-1",
          policyName: "Block outbound PII",
          kind: "pii",
          action: "block",
          severity: "critical",
          scopeType: "company",
          scopeId: null,
          policyVersion: 3,
          matchedField: "any",
          excerpt: "call 555-12-3456 now",
        },
      ],
      redactedText: null,
    });

    const root = await renderPage();

    const simulationTab = Array.from(container.querySelectorAll('[role="tab"]')).find(
      (tab) => tab.textContent === "Simulation",
    );
    expect(simulationTab).toBeTruthy();

    // Radix activates a tab on mousedown, not click.
    await act(async () => {
      simulationTab?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    });
    await flushReact();

    const sampleInput = document.body.querySelector<HTMLTextAreaElement>(
      "#guardrail-simulate-sample",
    );
    expect(sampleInput).toBeTruthy();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(sampleInput, "call 555-12-3456 now");
      sampleInput?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();

    const simulateButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "Simulate",
    );
    expect(simulateButton).toBeTruthy();

    await act(async () => {
      simulateButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(simulateMock).toHaveBeenCalledWith("company-1", {
      stage: "input",
      subject: "call 555-12-3456 now",
      subjectFields: { comment: "call 555-12-3456 now" },
      policyIds: ["policy-1"],
      candidatePolicy: null,
    });
    expect(document.body.textContent).toContain("Block outbound PII");
    expect(document.body.textContent).toContain("call 555-12-3456 now");

    await act(async () => {
      root.unmount();
    });
  });

  it("simulates an output sample and reports the action each policy would take", async () => {
    simulateMock.mockResolvedValue({
      action: "redact",
      decisive: {
        policyId: "policy-2",
        policyName: "Redact provider tokens",
        kind: "secret",
        action: "redact",
        severity: "medium",
        scopeType: "company",
        scopeId: null,
        policyVersion: 1,
        matchedField: "tool_result",
        excerpt: "sk-ant-0123456789abcdef",
      },
      matches: [
        {
          policyId: "policy-2",
          policyName: "Redact provider tokens",
          kind: "secret",
          action: "redact",
          severity: "medium",
          scopeType: "company",
          scopeId: null,
          policyVersion: 1,
          matchedField: "tool_result",
          excerpt: "sk-ant-0123456789abcdef",
        },
      ],
      redactedText: "the key is [REDACTED]",
    });

    const root = await renderPage();

    const simulationTab = Array.from(container.querySelectorAll('[role="tab"]')).find(
      (tab) => tab.textContent === "Simulation",
    );
    await act(async () => {
      simulationTab?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    });
    await flushReact();

    // The stage is a Radix Select, so drive it the way Radix does: open the
    // trigger, then pick the option with a pointerup.
    const stageTrigger = document.body.querySelector<HTMLElement>("#guardrail-simulate-stage");
    expect(stageTrigger).toBeTruthy();

    await act(async () => {
      stageTrigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      stageTrigger?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      stageTrigger?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    });
    await flushReact();

    const outputOption = Array.from(document.body.querySelectorAll('[role="option"]')).find(
      (option) => option.textContent === "Output",
    );
    expect(outputOption).toBeTruthy();

    await act(async () => {
      outputOption?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
      outputOption?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    });
    await flushReact();

    const sampleInput = document.body.querySelector<HTMLTextAreaElement>(
      "#guardrail-simulate-sample",
    );
    expect(sampleInput).toBeTruthy();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(sampleInput, "the key is sk-ant-0123456789abcdef");
      sampleInput?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();

    const simulateButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "Simulate",
    );
    expect(simulateButton).toBeTruthy();

    await act(async () => {
      simulateButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(simulateMock).toHaveBeenCalledWith("company-1", {
      stage: "output",
      subject: "the key is sk-ant-0123456789abcdef",
      subjectFields: { comment: "the key is sk-ant-0123456789abcdef" },
      policyIds: [],
      candidatePolicy: null,
    });
    expect(document.body.textContent).toContain("Redact provider tokens");
    expect(document.body.textContent).toContain("sk-ant-0123456789abcdef");
    expect(document.body.textContent).toContain("the key is [REDACTED]");

    await act(async () => {
      root.unmount();
    });
  });

  it("simulates the sample against the saved policies for the stage", async () => {
    listPoliciesMock.mockResolvedValue([
      policyRow({ id: "policy-input", stage: "input" }),
      policyRow({ id: "policy-output", stage: "output" }),
      policyRow({ id: "policy-disabled", enabled: false }),
    ]);
    simulateMock.mockResolvedValue({
      action: "allow",
      decisive: null,
      matches: [],
      redactedText: null,
    });

    const root = await renderPage();

    const simulationTab = Array.from(container.querySelectorAll('[role="tab"]')).find(
      (tab) => tab.textContent === "Simulation",
    );
    await act(async () => {
      simulationTab?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    });
    await flushReact();

    const sampleInput = document.body.querySelector<HTMLTextAreaElement>(
      "#guardrail-simulate-sample",
    );
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(sampleInput, "call 555-12-3456 now");
      sampleInput?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();

    const simulateButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "Simulate",
    );
    await act(async () => {
      simulateButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    // Only the enabled policies for the simulated stage are evaluated. The
    // endpoint evaluates nothing but the policies it is handed, so leaving
    // them out would hide every saved policy from the author.
    expect(simulateMock).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ policyIds: ["policy-input"] }),
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("tells the simulator which field the sample is written to", async () => {
    simulateMock.mockResolvedValue({
      action: "allow",
      decisive: null,
      matches: [],
      redactedText: null,
    });

    const root = await renderPage();

    const simulationTab = Array.from(container.querySelectorAll('[role="tab"]')).find(
      (tab) => tab.textContent === "Simulation",
    );
    await act(async () => {
      simulationTab?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    });
    await flushReact();

    const sampleInput = document.body.querySelector<HTMLTextAreaElement>(
      "#guardrail-simulate-sample",
    );
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(sampleInput, "call 555-12-3456 now");
      sampleInput?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();

    const simulateButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "Simulate",
    );
    await act(async () => {
      simulateButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    // A policy restricted to a named field only fires on that field, so the
    // sample has to carry the field it would land in.
    expect(simulateMock).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ subjectFields: { comment: "call 555-12-3456 now" } }),
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("links a violation back to the run that triggered it", async () => {
    listViolationsMock.mockResolvedValue([
      {
        id: "violation-1",
        companyId: "company-1",
        policyId: "policy-1",
        policyVersion: 2,
        stage: "output",
        actionTaken: "block",
        actorAgentId: "agent-1",
        heartbeatRunId: "run-1",
        subjectKind: "tool_result",
        subjectId: null,
        matchedExcerpt: "the blocked text",
        resolved: false,
        createdAt: new Date().toISOString(),
      },
    ]);

    const root = await renderPage();

    const violationsTab = Array.from(container.querySelectorAll('[role="tab"]')).find(
      (tab) => tab.textContent === "Violations",
    );
    expect(violationsTab).toBeTruthy();

    // Radix activates a tab on mousedown, not click.
    await act(async () => {
      violationsTab?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    });
    await flushReact();

    expect(document.body.textContent).toContain("the blocked text");
    // The policy is named rather than shown as a raw id.
    expect(document.body.textContent).toContain("No client PII outbound");
    const runLink = Array.from(document.body.querySelectorAll("a")).find(
      (link) => link.textContent === "View run",
    );
    // The router prefixes the href with the company prefix.
    expect(runLink?.getAttribute("href")).toContain("/agents/agent-1/runs/run-1");

    await act(async () => {
      root.unmount();
    });
  });
});

describe("approval preset for agent decisions", () => {
  it("builds a valid require_approval policy over the studio actions", () => {
    const draft = approvalPresetDraft();
    const validation = validateDraft(draft);
    expect(validation.fieldErrors).toEqual({});
    expect(validation.payload).not.toBeNull();
    const payload = draftToPolicyPayload(draft);
    expect(payload).toMatchObject({
      stage: "action",
      kind: "restricted_action",
      action: "require_approval",
      matcher: { kind: "restricted_action" },
    });
    expect((payload.matcher as { toolNames: string[] }).toolNames).toEqual(
      expect.arrayContaining(["paperclip:issue.create", "paperclip:issue.create_subissue", "paperclip:agent.update"]),
    );
  });
});

describe("plain-English rule policies", () => {
  it("builds a valid action-stage rule policy", () => {
    const draft = { ...ruleDraft(), name: "Models are mine", rule: "Never change another agent's model or effort." };
    const validation = validateDraft(draft);
    expect(validation.fieldErrors).toEqual({});
    expect(validation.payload).toMatchObject({
      stage: "action",
      kind: "rule",
      action: "block",
      matcher: { kind: "rule", rule: "Never change another agent's model or effort." },
    });
  });

  it("rejects an empty rule", () => {
    const validation = validateDraft({ ...ruleDraft(), name: "x", rule: "" });
    expect(validation.payload).toBeNull();
    expect(Object.keys(validation.fieldErrors).join(",")).toContain("matcher.rule");
  });
});

