// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  importFromSource: vi.fn(),
  list: vi.fn(),
  syncSkills: vi.fn(),
}));

vi.mock("../api/companySkills", () => ({
  companySkillsApi: {
    importFromSource: mocks.importFromSource,
    list: mocks.list,
  },
}));

vi.mock("../api/agents", () => ({
  agentsApi: {
    syncSkills: mocks.syncSkills,
  },
}));

import {
  getMarketingStackImportStatus,
  registerMarketingStackAgents,
  startMarketingStackImport,
} from "./marketing-stack-import";

describe("marketing stack skill import", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.importFromSource.mockReset().mockResolvedValue({ imported: [], warnings: [] });
    mocks.list.mockReset().mockResolvedValue([
      { key: "customer-research", slug: "customer-research" },
      { key: "tiktok-app-marketing", slug: "tiktok-app-marketing" },
    ]);
    mocks.syncSkills.mockReset().mockResolvedValue({});
  });

  it("launches sources in the background and links registered agents", async () => {
    const companyId = "company-marketing-stack-test";

    expect(startMarketingStackImport(companyId).state).toBe("running");
    registerMarketingStackAgents(companyId, [
      {
        agentId: "agent-carousel",
        desiredSkillRefs: ["customer-research"],
        skillSlugs: ["tiktok-app-marketing"],
      },
    ]);

    await vi.waitFor(() => {
      expect(mocks.importFromSource).toHaveBeenCalledTimes(5);
      expect(mocks.syncSkills).toHaveBeenCalledWith(
        "agent-carousel",
        ["customer-research", "tiktok-app-marketing"],
        companyId,
      );
    });

    await vi.waitFor(() => {
      expect(getMarketingStackImportStatus(companyId)?.state).toBe("completed");
    });
  });
});
