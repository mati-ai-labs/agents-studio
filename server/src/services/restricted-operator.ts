import { RESTRICTED_OPERATOR_ROLE } from "@paperclipai/shared";

/**
 * A user is a restricted operator when they hold the `restricted_operator`
 * instance role, or the `restricted_operator` company role in any active
 * membership. The restriction applies instance-wide and overrides instance admin.
 */
export function isRestrictedOperatorAccess(
  instanceRoles: Iterable<string>,
  memberships: ReadonlyArray<{ membershipRole?: string | null; status?: string | null }>,
): boolean {
  for (const role of instanceRoles) {
    if (role === RESTRICTED_OPERATOR_ROLE) return true;
  }
  return memberships.some(
    (membership) =>
      membership.membershipRole === RESTRICTED_OPERATOR_ROLE
      && (membership.status == null || membership.status === "active"),
  );
}
