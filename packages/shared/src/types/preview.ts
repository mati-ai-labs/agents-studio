export type PreviewLeaseStatus = "active" | "expired" | "revoked";

export interface PreviewLease {
  id: string;
  companyId: string;
  runtimeServiceId: string;
  slug: string;
  status: PreviewLeaseStatus;
  url: string;
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
