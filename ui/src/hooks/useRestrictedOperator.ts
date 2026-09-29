import { useQuery } from "@tanstack/react-query";
import { accessApi } from "@/api/access";
import { queryKeys } from "@/lib/queryKeys";

/**
 * True when the signed-in board user holds the `restricted_operator` instance
 * role: prompts/instructions and skills are hidden and company creation is
 * unavailable. The server enforces the same rules; this only shapes the UI.
 */
export function useRestrictedOperator(): boolean {
  const { data } = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    retry: false,
    staleTime: 60_000,
  });
  return data?.isRestricted === true;
}
