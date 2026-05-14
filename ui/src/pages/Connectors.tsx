/**
 * @fileoverview Connectors page — UI for connecting Google Workspace, Notion, and Linear.
 *
 * Allows users to initiate OAuth connections, view connector status, and disconnect.
 *
 * Route: /connectors
 * @see App.tsx for route registration
 */
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToastActions } from "@/context/ToastContext";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Loader2,
  Link2,
  Link2Off,
  CheckCircle2,
  AlertCircle,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Connector type definitions
// ---------------------------------------------------------------------------

type ConnectorType = "google_workspace" | "notion" | "linear";
type ConnectorStatus = "disconnected" | "connecting" | "connected" | "error";

interface ConnectorRecord {
  id: string;
  type: ConnectorType;
  status: ConnectorStatus;
  displayName: string | null;
  lastError: string | null;
  connectedAt: string | null;
  disconnectedAt: string | null;
}

// ---------------------------------------------------------------------------
// Connector metadata
// ---------------------------------------------------------------------------

const CONNECTOR_META: Record<ConnectorType, {
  name: string;
  description: string;
  icon: string;
  scopes: string[];
}> = {
  google_workspace: {
    name: "Google Workspace",
    description: "Connect Gmail, Calendar, and Google Drive to let agents read and write your emails, meetings, and files.",
    icon: "G",
    scopes: ["Gmail read/send", "Calendar read/write", "Drive read/write"],
  },
  notion: {
    name: "Notion",
    description: "Connect your Notion workspace so agents can search, read, and create pages and databases.",
    icon: "N",
    scopes: ["Search pages", "Read content", "Create/update pages"],
  },
  linear: {
    name: "Linear",
    description: "Connect Linear to let agents create issues, update status, and manage sprint planning.",
    icon: "L",
    scopes: ["Read issues", "Create issues", "Update status"],
  },
};

const STATUS_CONFIG: Record<ConnectorStatus, {
  label: string;
  tone: string;
  icon: React.ReactNode;
}> = {
  disconnected: {
    label: "Disconnected",
    tone: "bg-muted text-muted-foreground",
    icon: <Link2Off className="h-3 w-3" />,
  },
  connecting: {
    label: "Connecting",
    tone: "bg-blue-100 text-blue-800",
    icon: <Loader2 className="h-3 w-3 animate-spin" />,
  },
  connected: {
    label: "Connected",
    tone: "bg-green-100 text-green-800",
    icon: <CheckCircle2 className="h-3 w-3" />,
  },
  error: {
    label: "Error",
    tone: "bg-red-100 text-red-800",
    icon: <AlertCircle className="h-3 w-3" />,
  },
};

// ---------------------------------------------------------------------------
// Connector card component
// ---------------------------------------------------------------------------

interface ConnectorCardProps {
  type: ConnectorType;
  connector: ConnectorRecord | null;
  onConnect: (type: ConnectorType) => void;
  onDisconnect: (type: ConnectorType) => void;
  isConnecting: boolean;
  isDisconnecting: boolean;
}

function ConnectorCard({
  type,
  connector,
  onConnect,
  onDisconnect,
  isConnecting,
  isDisconnecting,
}: ConnectorCardProps) {
  const meta = CONNECTOR_META[type];
  const status = connector?.status ?? "disconnected";
  const statusCfg = STATUS_CONFIG[status];
  const displayName = connector?.displayName;
  const lastError = connector?.lastError;

  const canConnect = status === "disconnected" || status === "error";
  const canDisconnect = status === "connected" || status === "connecting" || status === "error";

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-4">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-lg font-bold">
              {meta.icon}
            </div>
            <div>
              <CardTitle className="text-base">{meta.name}</CardTitle>
              <div className="flex items-center gap-1.5 mt-0.5">
                <Badge className={cn("text-xs gap-1", statusCfg.tone)}>
                  {statusCfg.icon}
                  {statusCfg.label}
                </Badge>
                {displayName && (
                  <span className="text-xs text-muted-foreground">{displayName}</span>
                )}
              </div>
            </div>
          </div>
        </div>
        <CardDescription className="mt-2">{meta.description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pt-0">
        {/* Scopes list */}
        <div className="flex flex-wrap gap-1">
          {meta.scopes.map((scope) => (
            <span
              key={scope}
              className="inline-flex items-center rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground"
            >
              {scope}
            </span>
          ))}
        </div>

        {/* Error message */}
        {status === "error" && lastError && (
          <div className="rounded-md bg-red-50 border border-red-200 p-2 text-xs text-red-700 flex items-start gap-2">
            <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
            <span>{lastError}</span>
          </div>
        )}

        {/* Last connected */}
        {connector?.connectedAt && (
          <p className="text-xs text-muted-foreground">
            Connected {new Date(connector.connectedAt).toLocaleDateString()}
          </p>
        )}

        {/* Actions */}
        <div className="flex gap-2 mt-auto">
          {canConnect && (
            <Button
              size="sm"
              className="gap-2"
              onClick={() => onConnect(type)}
              disabled={isConnecting}
            >
              {isConnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
              {status === "connecting" ? "Connecting..." : "Connect"}
            </Button>
          )}
          {canDisconnect && (
            <Button
              size="sm"
              variant="outline"
              className="gap-2"
              onClick={() => onDisconnect(type)}
              disabled={isDisconnecting}
            >
              {isDisconnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2Off className="h-4 w-4" />}
              Disconnect
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main Connectors page
// ---------------------------------------------------------------------------

export function Connectors() {
  const { selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const [searchParams, setSearchParams] = useSearchParams();

  const [connectors, setConnectors] = useState<ConnectorRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [connectingType, setConnectingType] = useState<ConnectorType | null>(null);
  const [disconnectingType, setDisconnectingType] = useState<ConnectorType | null>(null);
  const [disconnectDialogType, setDisconnectDialogType] = useState<ConnectorType | null>(null);

  // Show toast for OAuth callback results
  const connected = searchParams.get("connected");
  const errorParam = searchParams.get("error");

  useEffect(() => {
    if (connected) {
      pushToast({
        title: `${CONNECTOR_META[connected as ConnectorType]?.name ?? connected} connected`,
        tone: "success",
      });
      // Clean up URL
      setSearchParams({});
    }
  }, [connected]);

  useEffect(() => {
    if (errorParam) {
      const errorMessages: Record<string, string> = {
        invalid_state: "OAuth state mismatch — please try again.",
        missing_params: "Missing OAuth parameters — please try again.",
        callback_failed: "Failed to complete OAuth — please try again.",
        unknown_type: "Unknown connector type.",
      };
      pushToast({
        title: "Connection failed",
        body: errorMessages[errorParam] ?? "An error occurred during OAuth.",
        tone: "error",
      });
      setSearchParams({});
    }
  }, [errorParam]);

  // Fetch connectors on mount
  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/instance/settings/heartbeats" },
      { label: "Connectors" },
    ]);
    fetchConnectors();
  }, [selectedCompany?.name]);

  async function fetchConnectors() {
    setIsLoading(true);
    try {
      const res = await fetch("/api/connectors", { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { connectors: ConnectorRecord[] };
      setConnectors(data.connectors);
    } catch (err) {
      pushToast({ title: "Failed to load connectors", body: String(err), tone: "error" });
    } finally {
      setIsLoading(false);
    }
  }

  async function handleConnect(type: ConnectorType) {
    setConnectingType(type);
    try {
      const res = await fetch(`/api/connectors/${type}/connect`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json() as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json() as { authorizationUrl: string };
      // Redirect to OAuth authorization URL
      window.location.href = data.authorizationUrl;
    } catch (err) {
      pushToast({
        title: "Failed to start connection",
        body: String(err),
        tone: "error",
      });
      setConnectingType(null);
    }
  }

  async function handleDisconnect(type: ConnectorType) {
    setDisconnectDialogType(null);
    setDisconnectingType(type);
    try {
      const res = await fetch(`/api/connectors/${type}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json() as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      pushToast({
        title: "Disconnected",
        body: `${CONNECTOR_META[type].name} has been disconnected.`,
        tone: "info",
      });
      await fetchConnectors();
    } catch (err) {
      pushToast({ title: "Failed to disconnect", body: String(err), tone: "error" });
    } finally {
      setDisconnectingType(null);
    }
  }

  function getConnector(type: ConnectorType): ConnectorRecord | null {
    return connectors.find((c) => c.type === type) ?? null;
  }

  const connectorTypes: ConnectorType[] = ["google_workspace", "notion", "linear"];

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Link2 className="h-6 w-6 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Connectors</h1>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        Connect your external tools to enable agents to read and write data on your behalf.
        Credentials are encrypted and stored securely.
      </p>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {connectorTypes.map((type) => (
            <ConnectorCard
              key={type}
              type={type}
              connector={getConnector(type)}
              onConnect={handleConnect}
              onDisconnect={(t) => setDisconnectDialogType(t)}
              isConnecting={connectingType === type}
              isDisconnecting={disconnectingType === type}
            />
          ))}
        </div>
      )}

      {/* Disconnect confirmation dialog */}
      <Dialog open={!!disconnectDialogType} onOpenChange={(open) => !open && setDisconnectDialogType(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect connector?</DialogTitle>
            <DialogDescription>
              This will remove the stored credentials. You can reconnect at any time.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDisconnectDialogType(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => disconnectDialogType && handleDisconnect(disconnectDialogType)}
              disabled={!!disconnectingType}
            >
              {disconnectingType ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}