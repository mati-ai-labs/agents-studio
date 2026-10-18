export type PreviewLeaseStatus = "active" | "expired" | "revoked";

export interface PreviewLease {
  id: string;
  companyId: string;
  runtimeServiceId: string;
  slug: string;
  status: PreviewLeaseStatus;
  /** Link for reviewers: `https://<slug>.<preview domain>/` when configured, else `pathUrl`. */
  url: string;
  /** `<Agent Studio>/preview/<slug>`; agents can call it with their API key to check the app. */
  pathUrl: string;
  expiresAt: Date;
  lastAccessedAt: Date | null;
  expiredAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePreviewLease {
  runtimeServiceId: string;
}
