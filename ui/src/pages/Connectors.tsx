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
  KeyRound,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { connectorsApi, type ConnectorRecord, type ConnectorType } from "@/api/connectors";

// ---------------------------------------------------------------------------
// Connector type definitions
// ---------------------------------------------------------------------------

type ConnectorStatus = "disconnected" | "connecting" | "connected" | "error";

// ---------------------------------------------------------------------------
// Connector metadata
// ---------------------------------------------------------------------------

const CONNECTOR_META: Record<ConnectorType, {
  name: string;
  description: string;
  icon: string;
  scopes: string[];
  mode: "oauth" | "manual";
}> = {
  google_workspace: {
    name: "Google Workspace",
    description: "Connect Gmail, Calendar, and Google Drive to let agents read and write your emails, meetings, and files.",
    icon: "G",
    scopes: ["Gmail read/send", "Calendar read/write", "Drive read/write"],
    mode: "oauth",
  },
  notion: {
    name: "Notion",
    description: "Connect your Notion workspace so agents can search, read, and create pages and databases.",
    icon: "N",
    scopes: ["Search pages", "Read content", "Create/update pages"],
    mode: "oauth",
  },
  linear: {
    name: "Linear",
    description: "Connect Linear to let agents create issues, update status, and manage sprint planning.",
    icon: "L",
    scopes: ["Read issues", "Create issues", "Update status"],
    mode: "oauth",
  },
  jira: {
    name: "Jira",
    description: "Provide Jira base URL and token so Paperclip can inject Jira MCP at run time.",
    icon: "J",
    scopes: ["Search issues", "Read issue details", "Create/update issues"],
    mode: "manual",
  },
  github: {
    name: "GitHub",
    description: "Provide a GitHub personal access token so Paperclip can inject GitHub MCP at run time.",
    icon: "GH",
    scopes: ["Repo read/write (as token allows)", "Pull requests", "Tasks"],
    mode: "manual",
  },
  aws: {
    name: "AWS S3",
    description: "Provide AWS credentials so agents can deploy websites to S3 and manage cloud resources.",
    icon: "S3",
    scopes: ["S3 read/write", "STS session tokens", "Bucket management"],
    mode: "manual",
  },
  hostinger: {
    name: "Hostinger",
    description: "Provide your Hostinger API token so agents can manage DNS records and hosting settings.",
    icon: "H",
    scopes: ["DNS management", "Domain records", "Hosting access"],
    mode: "manual",
  },
  surge: {
    name: "Surge.sh",
    description: "Provide your Surge.sh login token so agents can deploy static websites to the Surge CDN with one CLI command.",
    icon: "⚡",
    scopes: ["Static site deploy", "Custom domains", "CDN publish"],
    mode: "manual",
  },
  meta_ads: {
    name: "Meta Ads",
    description: "Connect a Meta (Facebook) Ads account so agents can read campaign performance, update budgets, and manage creatives through the Meta Ads MCP server.",
    icon: "M",
    scopes: ["ads_management", "ads_read", "business_management"],
    mode: "oauth",
  },
  slack: {
    name: "Slack",
    description: "Connect a Slack workspace so agents can read channels, send messages, and collaborate through Slack.",
    icon: "#",
    scopes: ["channels:read", "channels:history", "chat:write", "users:read", "team:read"],
    mode: "oauth",
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
  onConfigure: (type: ConnectorType) => void;
  onDisconnect: (type: ConnectorType) => void;
  isConnecting: boolean;
  isDisconnecting: boolean;
}

function ConnectorCard({
  type,
  connector,
  onConnect,
  onConfigure,
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
  const isManual = meta.mode === "manual";

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
              onClick={() => (isManual ? onConfigure(type) : onConnect(type))}
              disabled={isConnecting}
            >
              {isConnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : (isManual ? <KeyRound className="h-4 w-4" /> : <Link2 className="h-4 w-4" />)}
              {isManual ? "Configure" : "Connect"}
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
  const [configureDialogType, setConfigureDialogType] = useState<ConnectorType | null>(null);
  const [configBaseUrl, setConfigBaseUrl] = useState("");
  const [configEmail, setConfigEmail] = useState("");
  const [configAccessToken, setConfigAccessToken] = useState("");
  const [configAwsAccessKey, setConfigAwsAccessKey] = useState("");
  const [configAwsSecretKey, setConfigAwsSecretKey] = useState("");
  const [configAwsRegion, setConfigAwsRegion] = useState("us-east-1");
  const [configAwsBucketName, setConfigAwsBucketName] = useState("");
  const [configHostingerToken, setConfigHostingerToken] = useState("");
  const [configHostingerDomain, setConfigHostingerDomain] = useState("");
  const [configSurgeToken, setConfigSurgeToken] = useState("");
  const [configSurgeDomain, setConfigSurgeDomain] = useState("");
  const [isConfiguring, setIsConfiguring] = useState(false);
  const companyId = selectedCompany?.id ?? null;

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
    void fetchConnectors();
  }, [selectedCompany?.name, companyId]);

  async function fetchConnectors() {
    if (!companyId) {
      setConnectors([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      const data = await connectorsApi.list(companyId);
      setConnectors(data);
    } catch (err) {
      pushToast({ title: "Failed to load connectors", body: String(err), tone: "error" });
    } finally {
      setIsLoading(false);
    }
  }

  async function handleConnect(type: ConnectorType) {
    if (!companyId) return;
    setConnectingType(type);
    try {
      const res = await fetch(`/api/connectors/${type}/connect?companyId=${encodeURIComponent(companyId)}`, {
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
    if (!companyId) return;
    setDisconnectDialogType(null);
    setDisconnectingType(type);
    try {
      await connectorsApi.disconnect(type, companyId);
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

  const connectorTypes: ConnectorType[] = [
    "google_workspace", "jira", "github", "notion", "linear", "aws", "hostinger", "surge", "meta_ads", "slack",
  ];

  function openConfigureDialog(type: ConnectorType) {
    const existing = getConnector(type);
    const existingConfig = (existing?.config ?? {}) as Record<string, unknown>;
    setConfigureDialogType(type);
    setConfigBaseUrl(typeof existingConfig.baseUrl === "string" ? existingConfig.baseUrl : "");
    setConfigEmail(typeof existingConfig.email === "string" ? existingConfig.email : "");
    setConfigAccessToken("");
    setConfigAwsAccessKey(typeof existingConfig.awsAccessKeyId === "string" ? existingConfig.awsAccessKeyId : "");
    setConfigAwsSecretKey(typeof existingConfig.awsSecretAccessKey === "string" ? existingConfig.awsSecretAccessKey : "");
    setConfigAwsRegion(typeof existingConfig.region === "string" ? existingConfig.region : "us-east-1");
    setConfigAwsBucketName(typeof existingConfig.bucketName === "string" ? existingConfig.bucketName : "");
    setConfigHostingerToken(typeof existingConfig.apiToken === "string" ? existingConfig.apiToken : "");
    setConfigHostingerDomain(typeof existingConfig.domain === "string" ? existingConfig.domain : "");
    setConfigSurgeToken("");
    setConfigSurgeDomain(typeof existingConfig.default_domain === "string" ? existingConfig.default_domain : "");
  }

  async function handleConfigureSubmit() {
    if (!configureDialogType || !companyId) return;
    setIsConfiguring(true);
    try {
      if (configureDialogType === "jira") {
        await connectorsApi.configure(
          "jira",
          { baseUrl: configBaseUrl, email: configEmail, accessToken: configAccessToken },
          companyId,
        );
      } else if (configureDialogType === "github") {
        await connectorsApi.configure(
          "github",
          { accessToken: configAccessToken },
          companyId,
        );
      } else if (configureDialogType === "aws") {
        await connectorsApi.configure(
          "aws",
          { awsAccessKeyId: configAwsAccessKey, awsSecretAccessKey: configAwsSecretKey, region: configAwsRegion, bucketName: configAwsBucketName },
          companyId,
        );
      } else if (configureDialogType === "hostinger") {
        await connectorsApi.configure(
          "hostinger",
          { apiToken: configHostingerToken, domain: configHostingerDomain },
          companyId,
        );
      } else if (configureDialogType === "surge") {
        await connectorsApi.configure(
          "surge",
          { token: configSurgeToken, default_domain: configSurgeDomain },
          companyId,
        );
      }
      pushToast({
        title: "Connector configured",
        body: `${CONNECTOR_META[configureDialogType].name} credentials saved.`,
        tone: "success",
      });
      setConfigureDialogType(null);
      setConfigEmail("");
      setConfigAccessToken("");
      setConfigAwsAccessKey("");
      setConfigAwsSecretKey("");
      setConfigAwsRegion("us-east-1");
      setConfigAwsBucketName("");
      setConfigHostingerToken("");
      setConfigSurgeToken("");
      setConfigSurgeDomain("");
      await fetchConnectors();
    } catch (err) {
      pushToast({ title: "Failed to configure connector", body: String(err), tone: "error" });
    } finally {
      setIsConfiguring(false);
    }
  }

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
              onConfigure={openConfigureDialog}
              onDisconnect={(t) => setDisconnectDialogType(t)}
              isConnecting={connectingType === type}
              isDisconnecting={disconnectingType === type}
            />
          ))}
        </div>
      )}

      {/* Manual configure dialog (Jira/GitHub) */}
      <Dialog open={!!configureDialogType} onOpenChange={(open) => !open && setConfigureDialogType(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Configure {configureDialogType ? CONNECTOR_META[configureDialogType].name : "connector"}
            </DialogTitle>
            <DialogDescription>
              Credentials are encrypted at rest in Paperclip.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {configureDialogType === "jira" && (
              <>
                <label className="block space-y-1">
                  <span className="text-sm font-medium">Jira Base URL</span>
                  <input
                    className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none"
                    value={configBaseUrl}
                    onChange={(e) => setConfigBaseUrl(e.target.value)}
                    placeholder="https://your-company.atlassian.net"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-sm font-medium">Jira Email</span>
                  <input
                    className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none"
                    value={configEmail}
                    onChange={(e) => setConfigEmail(e.target.value)}
                    placeholder="you@company.com"
                  />
                </label>
              </>
            )}
            {(configureDialogType === "jira" || configureDialogType === "github") && (
              <label className="block space-y-1">
                <span className="text-sm font-medium">
                  {configureDialogType === "jira" ? "Jira Access Token" : "GitHub Personal Access Token"}
                </span>
                <input
                  className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none"
                  type="password"
                  value={configAccessToken}
                  onChange={(e) => setConfigAccessToken(e.target.value)}
                  placeholder={configureDialogType === "jira" ? "Atlassian token" : "ghp_..."}
                />
              </label>
            )}

            {configureDialogType === "aws" && (
              <>
                <label className="block space-y-1">
                  <span className="text-sm font-medium">AWS Access Key ID</span>
                  <input
                    className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none"
                    value={configAwsAccessKey}
                    onChange={(e) => setConfigAwsAccessKey(e.target.value)}
                    placeholder="AKIA..."
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-sm font-medium">AWS Secret Access Key</span>
                  <input
                    className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none"
                    type="password"
                    value={configAwsSecretKey}
                    onChange={(e) => setConfigAwsSecretKey(e.target.value)}
                    placeholder="..."
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-sm font-medium">AWS Region</span>
                  <input
                    className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none"
                    value={configAwsRegion}
                    onChange={(e) => setConfigAwsRegion(e.target.value)}
                    placeholder="us-east-1"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-sm font-medium">S3 Bucket Name</span>
                  <input
                    className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none"
                    value={configAwsBucketName}
                    onChange={(e) => setConfigAwsBucketName(e.target.value)}
                    placeholder="my-landing-page-bucket"
                  />
                </label>
              </>
            )}

            {configureDialogType === "hostinger" && (
              <>
                <label className="block space-y-1">
                  <span className="text-sm font-medium">Hostinger API Token</span>
                  <input
                    className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none"
                    type="password"
                    value={configHostingerToken}
                    onChange={(e) => setConfigHostingerToken(e.target.value)}
                    placeholder="..."
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-sm font-medium">Primary Domain</span>
                  <input
                    className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none"
                    type="text"
                    value={configHostingerDomain}
                    onChange={(e) => setConfigHostingerDomain(e.target.value)}
                    placeholder="mydomain.com"
                  />
                </label>
              </>
            )}

            {configureDialogType === "surge" && (
              <>
                <label className="block space-y-1">
                  <span className="text-sm font-medium">Surge.sh Login Token</span>
                  <input
                    className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none"
                    type="password"
                    value={configSurgeToken}
                    onChange={(e) => setConfigSurgeToken(e.target.value)}
                    placeholder="surge token output"
                  />
                  <span className="text-xs text-muted-foreground block">
                    Generate via <code className="rounded bg-muted px-1 py-0.5">surge login &amp;&amp; surge token</code> on your local machine, then paste here.
                  </span>
                </label>
                <label className="block space-y-1">
                  <span className="text-sm font-medium">Default Subdomain (optional)</span>
                  <input
                    className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none"
                    type="text"
                    value={configSurgeDomain}
                    onChange={(e) => setConfigSurgeDomain(e.target.value)}
                    placeholder="my-landing-page"
                  />
                  <span className="text-xs text-muted-foreground block">
                    Will be published as <code className="rounded bg-muted px-1 py-0.5">{configSurgeDomain || "my-landing-page"}.surge.sh</code>.
                  </span>
                </label>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfigureDialogType(null)}>
              Cancel
            </Button>
            <Button
              onClick={handleConfigureSubmit}
              disabled={
                isConfiguring ||
                (configureDialogType === "jira" && (!configBaseUrl.trim() || !configEmail.trim())) ||
                (configureDialogType === "github" && !configAccessToken.trim()) ||
                (configureDialogType === "aws" && (!configAwsAccessKey.trim() || !configAwsSecretKey.trim() || !configAwsBucketName.trim())) ||
                (configureDialogType === "hostinger" && (!configHostingerToken.trim() || !configHostingerDomain.trim())) ||
                (configureDialogType === "surge" && !configSurgeToken.trim())
              }
            >
              {isConfiguring ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
