import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useLocation, useSearchParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { oauthApi, type OAuthAuthorizeParams } from "../api/oauth";

/**
 * OAuth consent page for desktop apps such as Turia. The app opens
 * /oauth/authorize?client_id=…&redirect_uri=http://127.0.0.1:…&code_challenge=…
 * in the browser; the signed-in user picks which companies to grant, and we
 * send the browser back to the app's loopback redirect with a one-time code.
 */
export function OAuthAuthorizePage() {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const search = location.search;
  const params: OAuthAuthorizeParams = useMemo(
    () => ({
      clientId: searchParams.get("client_id") ?? "",
      redirectUri: searchParams.get("redirect_uri") ?? "",
      codeChallenge: searchParams.get("code_challenge") ?? "",
      codeChallengeMethod: searchParams.get("code_challenge_method") ?? "S256",
      responseType: searchParams.get("response_type") ?? "code",
      state: searchParams.get("state"),
    }),
    [searchParams],
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [redirecting, setRedirecting] = useState(false);

  const describeQuery = useQuery({
    queryKey: ["oauth-authorize", search],
    queryFn: () => oauthApi.describeAuthorize(search),
    retry: false,
  });

  const grantable = useMemo(
    () => (describeQuery.data?.companies ?? []).filter((company) => company.canGrant),
    [describeQuery.data],
  );
  useEffect(() => {
    // With a single company there is nothing to choose.
    if (grantable.length === 1) setSelected(new Set([grantable[0].id]));
  }, [grantable]);

  const decideMutation = useMutation({
    mutationFn: (decision: "approve" | "deny") =>
      oauthApi.decide({ ...params, decision, companyIds: decision === "approve" ? Array.from(selected) : [] }),
    onSuccess: ({ redirectUrl }) => {
      setRedirecting(true);
      window.location.assign(redirectUrl);
    },
  });

  // body is overflow:hidden app-wide, so this standalone page owns its scrolling.
  const shell = (children: React.ReactNode) => (
    <div className="h-dvh overflow-y-auto overscroll-contain">
      <div className="mx-auto max-w-xl px-4 py-10">
        <div className="rounded-lg border border-border bg-card p-6">{children}</div>
      </div>
    </div>
  );

  if (describeQuery.isLoading) {
    return shell(<p className="text-sm text-muted-foreground">Loading authorization request...</p>);
  }

  if (describeQuery.error || !describeQuery.data) {
    return shell(
      <>
        <h1 className="text-lg font-semibold">Authorization request is invalid</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {describeQuery.error instanceof Error ? describeQuery.error.message : "Start the connection again from the app."}
        </p>
      </>,
    );
  }

  const { client, user, companies } = describeQuery.data;

  if (describeQuery.data.requiresSignIn) {
    const next = `${location.pathname}${location.search}`;
    return shell(
      <>
        <h1 className="text-xl font-semibold">Sign in to connect {client.name}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Sign in to Agent Studio, then you will come back here to choose what {client.name} can access.
        </p>
        <Button asChild className="mt-4">
          <Link to={`/auth?next=${encodeURIComponent(next)}`}>Sign in</Link>
        </Button>
      </>,
    );
  }

  if (redirecting) {
    return shell(
      <>
        <h1 className="text-xl font-semibold">Returning to {client.name}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          You can close this tab once {client.name} shows it is connected.
        </p>
      </>,
    );
  }

  const toggle = (id: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  return shell(
    <>
      <h1 className="text-xl font-semibold">Connect {client.name} to Agent Studio</h1>
      <p className="mt-2 text-sm text-muted-foreground">{client.description}</p>
      {user && (
        <p className="mt-4 text-sm">
          Signed in as <span className="font-medium text-foreground">{user.email ?? user.name}</span>
        </p>
      )}

      <div className="mt-5">
        <div className="text-sm font-medium">Companies {client.name} can use</div>
        <p className="mt-1 text-xs text-muted-foreground">
          {client.name} will be able to see agents, create issues and assign them to agents, and read issue progress in
          the companies you choose.
        </p>
        {companies.length === 0 ? (
          <p className="mt-3 text-sm text-destructive">This account is not a member of any company yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-border rounded-md border border-border">
            {companies.map((company) => (
              <li key={company.id}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm">
                  <Checkbox
                    checked={selected.has(company.id)}
                    disabled={!company.canGrant}
                    onCheckedChange={(value) => toggle(company.id, value === true)}
                  />
                  <span className="min-w-0 flex-1 truncate">{company.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {company.canGrant ? company.membershipRole ?? "member" : "view only"}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>

      {decideMutation.error && (
        <p className="mt-4 text-sm text-destructive">
          {decideMutation.error instanceof Error ? decideMutation.error.message : "Could not complete authorization"}
        </p>
      )}

      <div className="mt-5 flex flex-wrap gap-3">
        <Button
          onClick={() => decideMutation.mutate("approve")}
          disabled={selected.size === 0 || decideMutation.isPending}
        >
          {decideMutation.isPending ? "Authorizing..." : `Authorize ${client.name}`}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => decideMutation.mutate("deny")}
          disabled={decideMutation.isPending}
        >
          Cancel
        </Button>
      </div>
    </>,
  );
}
