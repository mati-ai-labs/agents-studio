import { describe, expect, it } from "vitest";
import { buildRoutineAgentConnectionCommand } from "./routine-agent-connection";

describe("buildRoutineAgentConnectionCommand", () => {
  it("uses the source issue, caller run, and actual routine variable names", () => {
    const command = buildRoutineAgentConnectionCommand({
      connection: {
        webhookUrl: "https://agentstudio.example/api/routine-triggers/public/trigger/fire",
        webhookSecret: "secret-token",
      },
      variables: [
        {
          name: "micro_niche",
          label: "Micro-niche",
          type: "text",
          defaultValue: null,
          required: true,
          options: [],
        },
        {
          name: "source_data_pack",
          label: "Source data pack",
          type: "text",
          defaultValue: "Existing research",
          required: false,
          options: [],
        },
      ],
    });

    expect(command).toContain('SOURCE_ISSUE_ID="${PAPERCLIP_SOURCE_ISSUE_ID:-$PAPERCLIP_TASK_ID}"');
    expect(command).toContain('X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID');
    expect(command).toContain('"source_issue_id":"');
    expect(command).toContain('"micro_niche":"<micro_niche>"');
    expect(command).toContain('"source_data_pack":"Existing research"');
    expect(command).not.toContain("replace_with_your_variable");
  });
});
