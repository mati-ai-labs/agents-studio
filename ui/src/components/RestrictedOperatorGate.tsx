import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate } from "@/lib/router";
import { accessApi } from "@/api/access";
import { queryKeys } from "@/lib/queryKeys";

/** Redirects restricted operators away from prompt/skill/import-export pages. */
export function RestrictedOperatorGate({ children }: { children: ReactNode }) {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    retry: false,
    staleTime: 60_000,
  });
  if (isLoading) return null;
  if (data?.isRestricted) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}
