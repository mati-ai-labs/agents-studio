import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe } from "lucide-react";
import {
  instanceSettingsApi,
  type InstancePreviewSettingsView,
  type PatchInstancePreviewSettings,
  type PreviewEventRecord,
} from "@/api/instanceSettings";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function certificateLabel(certificate: InstancePreviewSettingsView["certificate"]) {
  if (!certificate) return "Set a preview domain first";
  switch (certificate.status) {
    case "valid":
      return `Valid until ${formatDate(certificate.expiresAt)}`;
    case "expired":
      return `Expired ${formatDate(certificate.expiresAt)}`;
    case "not_issued":
      return "Not issued yet";
    default:
      return `Unreachable${certificate.error ? `: ${certificate.error}` : ""}`;
  }
}

function eventLabel(event: PreviewEventRecord | null, emptyLabel: string) {
  if (!event) return emptyLabel;
  return event.ok ? `OK · ${formatDate(event.at)}` : `Failed · ${formatDate(event.at)}`;
}

export function InstancePreviewsSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [domain, setDomain] = useState("");
  const [dnsZone, setDnsZone] = useState("");
  const [dnsToken, setDnsToken] = useState("");
  const [testResult, setTestResult] = useState<{ ok: boolean; record: string; error: string | null } | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Instance Settings" }, { label: "Previews" }]);
  }, [setBreadcrumbs]);

  const previewsQuery = useQuery({
    queryKey: queryKeys.instance.previewSettings,
    queryFn: () => instanceSettingsApi.getPreviews(),
  });

  useEffect(() => {
    if (!previewsQuery.data) return;
    setDomain(previewsQuery.data.domain ?? "");
    setDnsZone(previewsQuery.data.dnsZone ?? "");
  }, [previewsQuery.data?.domain, previewsQuery.data?.dnsZone]);

  const updateMutation = useMutation({
    mutationFn: (patch: PatchInstancePreviewSettings) => instanceSettingsApi.updatePreviews(patch),
    onSuccess: (data) => {
      setActionError(null);
      setDnsToken("");
      queryClient.setQueryData(queryKeys.instance.previewSettings, data);
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to update preview settings.");
    },
  });

  const testMutation = useMutation({
    mutationFn: () => instanceSettingsApi.testPreviewsDns(),
    onSuccess: async (result) => {
      setActionError(null);
      setTestResult(result);
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.previewSettings });
    },
    onError: (error) => {
      setTestResult(null);
      setActionError(error instanceof Error ? error.message : "DNS test failed.");
    },
  });

  if (previewsQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading preview settings...</div>;
  }
  if (previewsQuery.error || !previewsQuery.data) {
    return (
      <div className="text-sm text-destructive">
        {previewsQuery.error instanceof Error ? previewsQuery.error.message : "Failed to load preview settings."}
      </div>
    );
  }

  const data = previewsQuery.data;
  const domainDirty = domain.trim() !== (data.domain ?? "") || dnsZone.trim() !== (data.dnsZone ?? "");
  const canTest = Boolean(data.domain && data.dnsZone && data.dnsTokenConfigured);
  const enabledIds = new Set(data.enabledCompanyIds);

  function toggleCompany(companyId: string, enabled: boolean) {
    const next = new Set(enabledIds);
    if (enabled) next.add(companyId);
    else next.delete(companyId);
    updateMutation.mutate({ enabledCompanyIds: Array.from(next) });
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Globe className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Previews</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Preview links for agent work are served at <code>&lt;name&gt;.{data.domain ?? "<preview domain>"}</code> with
          one wildcard certificate that renews automatically. Turn previews on for each company that should be able to
          share them.
        </p>
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      <section className="rounded-xl border border-border bg-card p-5 space-y-4">
        <div className="space-y-1.5">
          <h2 className="text-sm font-semibold">Domain and DNS</h2>
          <p className="text-sm text-muted-foreground">
            The preview domain needs a wildcard A record (<code>*.{data.domain ?? "preview.example.com"}</code>) pointing
            at this server. The DNS API token is used only to answer certificate challenges and is stored encrypted.
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1.5 text-sm">
            <span className="font-medium">Preview domain</span>
            <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="preview.example.com" />
          </label>
          <label className="space-y-1.5 text-sm">
            <span className="font-medium">DNS zone (Hostinger)</span>
            <Input value={dnsZone} onChange={(e) => setDnsZone(e.target.value)} placeholder="example.com" />
          </label>
        </div>
        <div className="flex justify-end">
          <Button
            size="sm"
            disabled={!domainDirty || updateMutation.isPending}
            onClick={() => updateMutation.mutate({ domain: domain.trim() || null, dnsZone: dnsZone.trim() || null })}
          >
            Save domain
          </Button>
        </div>
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium">Hostinger API token</span>
          <div className="flex gap-2">
            <Input
              type="password"
              autoComplete="off"
              value={dnsToken}
              onChange={(e) => setDnsToken(e.target.value)}
              placeholder={data.dnsTokenConfigured ? "Saved — enter a new token to replace it" : "hPanel → Profile → API"}
            />
            <Button
              size="sm"
              disabled={!dnsToken.trim() || updateMutation.isPending}
              onClick={() => updateMutation.mutate({ dnsToken: dnsToken.trim() })}
            >
              Save token
            </Button>
          </div>
        </label>
        <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-background px-3 py-3">
          <div className="text-sm">
            <div className="font-medium">Test DNS connection</div>
            <div className="text-muted-foreground">
              Writes a temporary TXT record, waits until it is published, then removes it. Can take up to two minutes.
            </div>
            {testResult && (
              <div className={testResult.ok ? "mt-1 text-emerald-600" : "mt-1 text-destructive"}>
                {testResult.ok ? `Works — ${testResult.record} was published and removed.` : testResult.error}
              </div>
            )}
          </div>
          <Button size="sm" variant="outline" disabled={!canTest || testMutation.isPending} onClick={() => testMutation.mutate()}>
            {testMutation.isPending ? "Testing..." : "Test"}
          </Button>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5 space-y-3">
        <h2 className="text-sm font-semibold">Status</h2>
        <div className="grid gap-3 md:grid-cols-3">
          <StatusBox label="Certificate" value={certificateLabel(data.certificate)} />
          <StatusBox label="Last DNS test" value={eventLabel(data.lastDnsTest, "Not run")} />
          <StatusBox label="Last certificate challenge" value={eventLabel(data.lastChallenge, "None yet")} />
        </div>
        {[data.lastDnsTest, data.lastChallenge].some((event) => event && !event.ok && event.error) && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {[data.lastDnsTest, data.lastChallenge].find((event) => event && !event.ok && event.error)?.error}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-border bg-card p-5 space-y-3">
        <div className="space-y-1.5">
          <h2 className="text-sm font-semibold">Companies</h2>
          <p className="text-sm text-muted-foreground">
            Agents in enabled companies can expose previews. Others get a clear "previews are not enabled" error.
          </p>
        </div>
        {data.companies.length === 0 ? (
          <div className="text-sm text-muted-foreground">No companies yet.</div>
        ) : (
          <div className="divide-y divide-border rounded-lg border border-border">
            {data.companies.map((company) => (
              <div key={company.id} className="flex items-center justify-between gap-4 px-3 py-2.5">
                <span className="text-sm font-medium">{company.name}</span>
                <ToggleSwitch
                  checked={company.previewsEnabled}
                  onCheckedChange={(checked) => toggleCompany(company.id, checked)}
                  disabled={updateMutation.isPending || !data.domain}
                  aria-label={`Toggle previews for ${company.name}`}
                />
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function StatusBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-background px-3 py-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-2 text-sm font-medium">{value}</div>
    </div>
  );
}
