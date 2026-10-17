import { describe, expect, it } from "vitest";
import {
  buildSlackProgressMessage,
  markdownToSlackMrkdwn,
  normalizeAgentCommentBody,
} from "../services/slack-message-builder.js";

const issue = { id: "a08fd520-037a-4707-8774-d9fbbc9617fe", identifier: "LCH-4" };

describe("normalizeAgentCommentBody", () => {
  it("unwraps a JSON-quoted body with escaped quotes", () => {
    expect(normalizeAgentCommentBody('"**Aditya\'s items**\\n\\n- Pipeline \\"C\\" indicator (open)"'))
      .toBe('**Aditya\'s items**\n\n- Pipeline "C" indicator (open)');
  });

  it("unwraps a quoted body with real newlines that is not valid JSON", () => {
    expect(normalizeAgentCommentBody('"**Items**\n\n- Pipeline \\"C\\" indicator"'))
      .toBe('**Items**\n\n- Pipeline "C" indicator');
  });

  it("leaves a plain body alone apart from stray escaped quotes", () => {
    expect(normalizeAgentCommentBody("Done. Pipeline \\\"C\\\" shipped.")).toBe('Done. Pipeline "C" shipped.');
  });
});

describe("markdownToSlackMrkdwn", () => {
  it("converts bold, headings, links and bullets", () => {
    expect(markdownToSlackMrkdwn("## Ack\n**Due Mon**\n- one\n  * two\nSee [LCH-4](https://x.test/LCH/issues/LCH-4)"))
      .toBe("*Ack*\n*Due Mon*\n• one\n  • two\nSee <https://x.test/LCH/issues/LCH-4|LCH-4>");
  });
});

describe("buildSlackProgressMessage", () => {
  it("posts only the cleaned body, without an agent/issue header", () => {
    const text = buildSlackProgressMessage({
      issue,
      agentName: "CEO",
      body: '"**Aditya\'s items**:\n\n- Dashboard filter fix (open)\n- Pipeline \\"C\\" indicator (open)"',
    });
    expect(text).toBe("*Aditya's items*:\n\n• Dashboard filter fix (open)\n• Pipeline \"C\" indicator (open)");
  });
});
