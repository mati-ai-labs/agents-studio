import { describe, expect, it } from "vitest";
import {
  MARKETING_INNOVATION_WORKFLOW_DESCRIPTION,
  MARKETING_INNOVATION_WORKFLOW_TITLE,
  buildMarketingInnovationWorkflowContent,
  buildMarketingInnovationWorkflowVariables,
} from "./marketing-stack.js";

describe("marketing innovation workflow template", () => {
  it("keeps the launch-pack phases and mandatory attachment contract", () => {
    expect(MARKETING_INNOVATION_WORKFLOW_TITLE).toBe(
      "{{company_name}} Innovation Report + Venture Launch Pack",
    );
    expect(MARKETING_INNOVATION_WORKFLOW_DESCRIPTION).toContain("PHASE 9 — Three New Venture Concepts");
    expect(MARKETING_INNOVATION_WORKFLOW_DESCRIPTION).toContain("PHASE 10 — Landing Pages for the Three Ventures");
    expect(MARKETING_INNOVATION_WORKFLOW_DESCRIPTION).toContain("PHASE 11 — Ad Campaigns for the Three Ventures");
    expect(MARKETING_INNOVATION_WORKFLOW_DESCRIPTION).toContain("PHASE 12 — Social Content and Image-Generated Creative");
    expect(MARKETING_INNOVATION_WORKFLOW_DESCRIPTION).toContain("Mandatory Artifact Attachment Rule");
    expect(MARKETING_INNOVATION_WORKFLOW_DESCRIPTION).toContain("Never mark the issue done while any required artifact is missing or unattached.");
  });

  it("provides company-scoped defaults for every runtime placeholder", () => {
    const variables = buildMarketingInnovationWorkflowVariables({
      companyId: "company-123",
      companyName: "Acme",
      website: "https://acme.example",
      importantLinks: ["https://acme.example/about", "https://acme.example/pricing"],
      documentNames: ["brief.pdf"],
    });

    expect(Object.fromEntries(variables.map((variable) => [variable.name, variable.defaultValue]))).toEqual({
      company_name: "Acme",
      company_website: "https://acme.example",
      company_id: "company-123",
      important_links: "https://acme.example/about\nhttps://acme.example/pricing",
      uploaded_documents: "brief.pdf",
    });
    expect(variables.every((variable) => variable.required)).toBe(true);
  });

  it("materializes the saved workflow content for a company", () => {
    const content = buildMarketingInnovationWorkflowContent({
      companyId: "company-123",
      companyName: "Acme",
      website: "https://acme.example",
      importantLinks: ["https://acme.example/about"],
      documentNames: ["brief.pdf"],
    });

    expect(content.title).toBe("Acme Innovation Report + Venture Launch Pack");
    expect(content.description).toContain("# Acme Innovation Report + Venture Launch Pack");
    expect(content.description).toContain("- Company ID: company-123");
    expect(content.description).toContain("- Company website: https://acme.example");
    expect(content.description).toContain("https://acme.example/about");
    expect(content.description).toContain("brief.pdf");
    expect(content.description).not.toContain("{{company_name}}");
    expect(content.description).not.toContain("{{company_id}}");
  });
});
