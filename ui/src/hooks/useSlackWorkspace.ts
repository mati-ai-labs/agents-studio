import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@/api/client";
import { connectorsApi, type ConnectorRecord, type SlackChannel } from "@/api/connectors";

type UseSlackWorkspaceOptions = {
  companyId?: string | null;
  enabled?: boolean;
};

async function loadSlackConnector(companyId: string): Promise<ConnectorRecord | null> {
  try {
    return await connectorsApi.get("slack", companyId);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export function useSlackWorkspace(options: UseSlackWorkspaceOptions) {
  const companyId = options.companyId ?? null;
  const enabled = options.enabled !== false && Boolean(companyId);

  const connectorQuery = useQuery({
    queryKey: ["connectors", companyId, "slack"],
    queryFn: () => loadSlackConnector(companyId!),
    enabled,
  });

  const connector = connectorQuery.data ?? null;
  const channelsQuery = useQuery({
    queryKey: ["connectors", companyId, "slack", "channels"],
    queryFn: () => connectorsApi.listSlackChannels(companyId!),
    enabled: enabled && connector?.status === "connected",
  });

  return {
    connector,
    connectorError: connectorQuery.error,
    connectorLoading: connectorQuery.isLoading,
    connectorFetching: connectorQuery.isFetching,
    channels: channelsQuery.data ?? ([] as SlackChannel[]),
    channelsError: channelsQuery.error,
    channelsLoading: channelsQuery.isLoading,
    channelsFetching: channelsQuery.isFetching,
    refetchChannels: channelsQuery.refetch,
  };
}
