import { api } from "./client";

export type CompanyDashboard = {
  id: string;
  companyId: string;
  slug: string;
  name: string;
  description: string | null;
  status: "draft" | "active" | "archived" | string;
  currentVersion: number | null;
  allowedEmails: string[] | null;
  allowedRoutineIds: string[];
  builderAgentId: string | null;
  hasIngestToken: boolean;
  createdByUserId: string | null;
  createdByAgentId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CompanyDashboardVersion = {
  id: string;
  version: number;
  note: string | null;
  byteSize: number;
  sha256: string;
  issueId: string | null;
  issueIdentifier: string | null;
  createdByUserId: string | null;
  createdByAgentId: string | null;
  createdAt: string;
};

export type CompanyDashboardRequest = {
  id: string;
  kind: "build" | "change";
  request: string;
  createdByUserId: string | null;
  createdAt: string;
  issueId: string;
  issueIdentifier: string | null;
  issueStatus: string | null;
  issueTitle: string | null;
};

export type DashboardRecord = { key: string; data: unknown; updatedAt: string };
export type DashboardCollection = { collection: string; count: number; updatedAt: string };
export type DashboardFile = {
  id: string;
  name: string;
  contentType: string;
  byteSize: number;
  meta: Record<string, unknown> | null;
  updatedAt: string;
};

const base = (companyId: string, dashboardId: string) => `/companies/${companyId}/dashboards/${encodeURIComponent(dashboardId)}`;
const seg = encodeURIComponent;

export const dashboardsApi = {
  list: (companyId: string) => api.get<CompanyDashboard[]>(`/companies/${companyId}/dashboards`),
  get: (companyId: string, id: string) => api.get<CompanyDashboard>(base(companyId, id)),
  create: (companyId: string, data: { name: string; description?: string; builderAgentId?: string | null; allowedEmails?: string[] | null }) =>
    api.post<CompanyDashboard>(`/companies/${companyId}/dashboards`, data),
  update: (companyId: string, id: string, data: Partial<Pick<CompanyDashboard, "name" | "description" | "allowedEmails" | "allowedRoutineIds" | "builderAgentId">>) =>
    api.patch<CompanyDashboard>(base(companyId, id), data),
  remove: (companyId: string, id: string) => api.delete<void>(base(companyId, id)),
  html: (companyId: string, id: string, version?: number | null) =>
    api.get<{ version: number; html: string }>(`${base(companyId, id)}/html${version ? `?version=${version}` : ""}`),
  versions: (companyId: string, id: string) => api.get<CompanyDashboardVersion[]>(`${base(companyId, id)}/versions`),
  activateVersion: (companyId: string, id: string, version: number) =>
    api.post<CompanyDashboard>(`${base(companyId, id)}/versions/${version}/activate`, {}),
  rotateIngestToken: (companyId: string, id: string) => api.post<{ token: string }>(`${base(companyId, id)}/ingest-token`, {}),
  revokeIngestToken: (companyId: string, id: string) => api.delete<void>(`${base(companyId, id)}/ingest-token`),
  collections: (companyId: string, id: string) => api.get<DashboardCollection[]>(`${base(companyId, id)}/data`),
  listRecords: (companyId: string, id: string, collection: string, opts: { limit?: number; offset?: number } = {}) => {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.offset) params.set("offset", String(opts.offset));
    const q = params.toString();
    return api.get<DashboardRecord[]>(`${base(companyId, id)}/data/${seg(collection)}${q ? `?${q}` : ""}`);
  },
  getRecord: (companyId: string, id: string, collection: string, key: string) =>
    api.get<DashboardRecord>(`${base(companyId, id)}/data/${seg(collection)}/${seg(key)}`),
  putRecord: (companyId: string, id: string, collection: string, key: string, data: unknown) =>
    api.put<DashboardRecord>(`${base(companyId, id)}/data/${seg(collection)}/${seg(key)}`, { data }),
  deleteRecord: (companyId: string, id: string, collection: string, key: string) =>
    api.delete<{ deleted: number }>(`${base(companyId, id)}/data/${seg(collection)}/${seg(key)}`),
  files: (companyId: string, id: string) => api.get<DashboardFile[]>(`${base(companyId, id)}/files`),
  fileUrl: (companyId: string, id: string, fileId: string) => `/api${base(companyId, id)}/files/${seg(fileId)}/content`,
  draftRequest: (companyId: string, id: string, data: { kind: "build" | "change"; request: string }) =>
    api.post<{ title: string; description: string; assigneeAgentId: string | null }>(`${base(companyId, id)}/requests/draft`, data),
  recordRequest: (companyId: string, id: string, data: { kind: "build" | "change"; request: string; issueId: string }) =>
    api.post<CompanyDashboardRequest>(`${base(companyId, id)}/requests`, data),
  requests: (companyId: string, id: string) => api.get<CompanyDashboardRequest[]>(`${base(companyId, id)}/requests`),
};

export const dashboardKeys = {
  list: (companyId: string) => ["dashboards", companyId] as const,
  detail: (companyId: string, id: string) => ["dashboards", companyId, id] as const,
  html: (companyId: string, id: string, version: number | null) => ["dashboards", companyId, id, "html", version] as const,
  versions: (companyId: string, id: string) => ["dashboards", companyId, id, "versions"] as const,
  requests: (companyId: string, id: string) => ["dashboards", companyId, id, "requests"] as const,
  collections: (companyId: string, id: string) => ["dashboards", companyId, id, "collections"] as const,
};
