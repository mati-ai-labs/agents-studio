import { api } from "./client";

export type OAuthGrantableCompany = {
  id: string;
  name: string;
  issuePrefix: string | null;
  membershipRole: string | null;
  canGrant: boolean;
};

export type OAuthAuthorizeDescription = {
  client: { id: string; name: string; description: string };
  requiresSignIn: boolean;
  user: { id: string; name: string | null; email: string | null } | null;
  companies: OAuthGrantableCompany[];
};

export type OAuthAuthorizeParams = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  responseType: string;
  state: string | null;
};

export const oauthApi = {
  describeAuthorize: (search: string) => api.get<OAuthAuthorizeDescription>(`/oauth/authorize${search}`),
  decide: (input: OAuthAuthorizeParams & { decision: "approve" | "deny"; companyIds: string[] }) =>
    api.post<{ redirectUrl: string }>("/oauth/authorize", input),
};
