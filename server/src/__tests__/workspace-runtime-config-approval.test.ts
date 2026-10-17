import { describe, expect, it } from "vitest";
import { workspaceRuntimeConfigApprovalPayloadSchema } from "@paperclipai/shared";

const ids = {
  projectId: "9adfbb6e-1d12-47aa-977a-d21e6737b977",
  workspaceId: "0aaba855-a0d4-4815-8ae0-14b785dbaf70",
};

describe("workspaceRuntimeConfigApprovalPayloadSchema", () => {
  it("accepts services with name and command, keeping extra service fields", () => {
    const parsed = workspaceRuntimeConfigApprovalPayloadSchema.parse({
      ...ids,
      workspaceRuntime: {
        services: [{ name: "web", command: "pnpm dev", cwd: "apps/web", expose: { type: "paperclip_preview" } }],
      },
    });
    expect(parsed.workspaceRuntime.services[0]).toMatchObject({ cwd: "apps/web", expose: { type: "paperclip_preview" } });
  });

  it("rejects empty services, missing commands and non-uuid ids", () => {
    expect(workspaceRuntimeConfigApprovalPayloadSchema.safeParse({ ...ids, workspaceRuntime: { services: [] } }).success).toBe(false);
    expect(workspaceRuntimeConfigApprovalPayloadSchema.safeParse({ ...ids, workspaceRuntime: { services: [{ name: "web" }] } }).success).toBe(false);
    expect(workspaceRuntimeConfigApprovalPayloadSchema.safeParse({ projectId: "x", workspaceId: "y", workspaceRuntime: { services: [{ name: "a", command: "b" }] } }).success).toBe(false);
  });
});
