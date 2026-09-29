import { describe, expect, it } from "vitest";
import { grantsForHumanRole, normalizeHumanRole } from "../services/company-member-roles.js";
import { isRestrictedOperatorAccess } from "../services/restricted-operator.js";

describe("restricted operator role", () => {
  it("applies from the instance role or any active restricted_operator membership", () => {
    expect(isRestrictedOperatorAccess(["restricted_operator"], [])).toBe(true);
    expect(isRestrictedOperatorAccess([], [{ membershipRole: "restricted_operator", status: "active" }])).toBe(true);
    expect(isRestrictedOperatorAccess(["instance_admin"], [{ membershipRole: "owner", status: "active" }])).toBe(false);
    expect(isRestrictedOperatorAccess([], [{ membershipRole: "restricted_operator", status: "archived" }])).toBe(false);
  });

  it("is a recognised company role with day-to-day grants", () => {
    expect(normalizeHumanRole("restricted_operator")).toBe("restricted_operator");
    expect(grantsForHumanRole("restricted_operator").map((grant) => grant.permissionKey).sort()).toEqual([
      "agents:create",
      "joins:approve",
      "tasks:assign",
      "users:invite",
      "users:manage_permissions",
    ]);
  });
});
