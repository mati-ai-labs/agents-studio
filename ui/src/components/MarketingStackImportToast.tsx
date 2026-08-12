import { useEffect, useState } from "react";
import { useCompany } from "../context/CompanyContext";
import { useOptionalToastActions } from "../context/ToastContext";
import {
  getMarketingStackImportStatus,
  resumeMarketingStackImport,
  retryMarketingStackImport,
  subscribeMarketingStackImportStatus,
  type MarketingStackImportStatus,
} from "../lib/marketing-stack-import";

const TOAST_ID = "marketing-stack-import-status";

function statusBody(status: MarketingStackImportStatus) {
  if (status.state === "completed") {
    return `Imported ${status.completedSources} skill sources and linked them to ${status.linkedAgents} Marketing Stack agents.`;
  }

  if (status.state === "failed") {
    const failed = status.failedSources.length > 0
      ? ` Failed: ${status.failedSources.join(", ")}.`
      : " Some skills could not be linked.";
    return `${status.completedSources}/${status.totalSources} skill sources imported.${failed}`;
  }

  const active = status.activeSources.length > 0
    ? ` Importing ${status.activeSources.join(", ")}.`
    : " Linking imported skills to the agents.";
  const linked = status.totalAgents > 0
    ? ` Linked ${status.linkedAgents}/${status.totalAgents} agents.`
    : "";
  return `${status.completedSources}/${status.totalSources} skill sources imported.${active}${linked}`;
}

export function MarketingStackImportToast() {
  const { selectedCompanyId } = useCompany();
  const toastActions = useOptionalToastActions();
  const [status, setStatus] = useState<MarketingStackImportStatus | null>(null);

  useEffect(() => {
    if (!selectedCompanyId) {
      setStatus(null);
      return;
    }

    setStatus(
      resumeMarketingStackImport(selectedCompanyId)
      ?? getMarketingStackImportStatus(selectedCompanyId),
    );
    return subscribeMarketingStackImportStatus((next) => {
      if (next.companyId === selectedCompanyId) setStatus(next);
    });
  }, [selectedCompanyId]);

  useEffect(() => {
    if (!toastActions) return;
    if (!status || status.companyId !== selectedCompanyId) {
      toastActions.dismissToast(TOAST_ID);
      return;
    }

    const isRunning = status.state === "running";
    toastActions.pushToast({
      id: TOAST_ID,
      dedupeKey: `${TOAST_ID}:${status.updatedAt}:${status.state}:${status.completedSources}:${status.linkedAgents}`,
      title: isRunning
        ? "Setting up your Marketing Stack"
        : status.state === "completed"
          ? "Marketing Stack ready"
          : "Marketing Stack setup needs attention",
      body: statusBody(status),
      tone: isRunning ? "info" : status.state === "completed" ? "success" : "error",
      placement: "top",
      persistent: isRunning || status.state === "failed",
      isLoading: isRunning,
      ttlMs: status.state === "completed" ? 6000 : undefined,
      action: status.state === "failed"
        ? {
            label: "Retry import",
            onClick: () => retryMarketingStackImport(status.companyId),
          }
        : undefined,
    });
  }, [selectedCompanyId, status, toastActions]);

  return null;
}
