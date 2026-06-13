import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { cn, formatDate, formatDateTime } from "@/lib/utils";
import { CalendarDays, FileText, Globe, Image as ImageIcon, Loader2, UserRound } from "lucide-react";
import { ImageGalleryModal } from "./ImageGalleryModal";
import { MarkdownBody } from "./MarkdownBody";
import type { Issue, IssueAttachment } from "@paperclipai/shared";
import { accessApi } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { authApi } from "@/api/auth";
import { useCompany } from "@/context/CompanyContext";
import { buildCompanyUserLabelMap } from "@/lib/company-members";
import { formatAssigneeUserLabel } from "@/lib/assignees";
import { queryKeys } from "@/lib/queryKeys";
import { StatusBadge } from "./StatusBadge";
import { PriorityIcon } from "./PriorityIcon";
import { IssueReferencePill } from "./IssueReferencePill";
import { Identity } from "./Identity";
import { Link } from "@/lib/router";
import { timeAgo } from "@/lib/timeAgo";

const DEFAULT_OUTPUT_SPLIT = 60; // percent for left panel
const MIN_LEFT_PCT = 30;
const MAX_LEFT_PCT = 80;
const STORAGE_KEY = "paperclip.issue-output.split";

function readStoredSplit(storageKey: string) {
  if (typeof window === "undefined") return DEFAULT_OUTPUT_SPLIT;
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (!stored) return DEFAULT_OUTPUT_SPLIT;
    const parsed = Number.parseInt(stored, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_OUTPUT_SPLIT;
    return Math.min(MAX_LEFT_PCT, Math.max(MIN_LEFT_PCT, parsed));
  } catch {
    return DEFAULT_OUTPUT_SPLIT;
  }
}

function writeStoredSplit(storageKey: string, leftPct: number) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, String(leftPct));
  } catch {
    // Storage unavailable — no-op
  }
}

interface OutputSplitPaneProps {
  left: ReactNode;
  right: ReactNode;
  storageKey?: string;
}

export function OutputSplitPane({
  left,
  right,
  storageKey = STORAGE_KEY,
}: OutputSplitPaneProps) {
  const [leftPct, setLeftPct] = useState(() => readStoredSplit(storageKey));
  const [isResizing, setIsResizing] = useState(false);
  const leftPctRef = useRef(leftPct);
  const dragState = useRef<{ startX: number; startPct: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stored = readStoredSplit(storageKey);
    leftPctRef.current = stored;
    setLeftPct(stored);
  }, [storageKey]);

  const commitPct = useCallback(
    (nextPct: number) => {
      const clamped = Math.min(MAX_LEFT_PCT, Math.max(MIN_LEFT_PCT, nextPct));
      leftPctRef.current = clamped;
      setLeftPct(clamped);
      writeStoredSplit(storageKey, clamped);
    },
    [storageKey],
  );

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragState.current = {
        startX: event.clientX,
        startPct: leftPctRef.current,
      };
      setIsResizing(true);
    },
    [],
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!dragState.current || !containerRef.current) return;
      const containerWidth = containerRef.current.offsetWidth;
      if (containerWidth === 0) return;
      const deltaX = event.clientX - dragState.current.startX;
      const deltaPct = (deltaX / containerWidth) * 100;
      const nextPct = dragState.current.startPct + deltaPct;
      const clamped = Math.min(MAX_LEFT_PCT, Math.max(MIN_LEFT_PCT, nextPct));
      leftPctRef.current = clamped;
      setLeftPct(clamped);
    },
    [],
  );

  const endResize = useCallback(() => {
    if (!dragState.current) return;
    dragState.current = null;
    setIsResizing(false);
    writeStoredSplit(storageKey, leftPctRef.current);
  }, [storageKey]);

  return (
    <div ref={containerRef} className="flex h-full w-full min-w-0 overflow-hidden">
      {/* Left panel */}
      <div
        className={cn(
          "min-w-0 overflow-auto h-full",
          !isResizing && "transition-[width] duration-100 ease-out",
        )}
        style={{ width: `${leftPct}%` }}
      >
        {left}
      </div>

      {/* Drag handle */}
      <div
        role="separator"
        aria-label="Resize output panel"
        aria-orientation="vertical"
        aria-valuemin={MIN_LEFT_PCT}
        aria-valuemax={MAX_LEFT_PCT}
        aria-valuenow={leftPct}
        tabIndex={0}
        className={cn(
          "w-2 shrink-0 cursor-col-resize touch-none outline-none",
          "relative flex items-center justify-center",
          "before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-transparent before:transition-colors",
          "hover:before:bg-border focus-visible:before:bg-ring",
          isResizing && "before:bg-ring",
        )}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onLostPointerCapture={endResize}
      >
        <div className="h-12 w-0.5 rounded-full bg-border" />
      </div>

      {/* Right panel */}
      <div
        className={cn(
          "min-w-0 overflow-auto h-full",
          !isResizing && "transition-[width] duration-100 ease-out",
        )}
        style={{ width: `${100 - leftPct}%` }}
      >
        {right}
      </div>
    </div>
  );
}

interface IssueOutputPanelProps {
  issue: Issue;
  childIssues?: Issue[];
  attachments: IssueAttachment[];
  isLoading?: boolean;
  onImageClick?: (src: string, attachments: IssueAttachment[]) => void;
  onUpdate?: (data: Record<string, unknown>) => void;
}

function issueDueDate(issue: Issue) {
  return (
    issue.monitorNextCheckAt ??
    issue.executionPolicy?.monitor?.nextCheckAt ??
    issue.scheduledRetry?.scheduledRetryAt ??
    null
  );
}

function StripField({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 space-y-1", className)}>
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm text-foreground">
        {children}
      </div>
    </div>
  );
}

export function IssuePropertiesStrip({ issue }: { issue: Issue }) {
  const { selectedCompanyId } = useCompany();
  const companyId = issue.companyId ?? selectedCompanyId;

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId;

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId!),
    queryFn: () => agentsApi.list(companyId!),
    enabled: !!companyId && (!!issue.assigneeAgentId || !!issue.createdByAgentId),
  });

  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId!),
    queryFn: () => accessApi.listUserDirectory(companyId!),
    enabled: !!companyId && (!!issue.assigneeUserId || !!issue.createdByUserId),
  });

  const userLabelMap = useMemo(
    () => buildCompanyUserLabelMap(companyMembers?.users),
    [companyMembers?.users],
  );

  const assigneeLabel = useMemo(() => {
    if (issue.assigneeAgentId) {
      return (
        agents?.find((agent) => agent.id === issue.assigneeAgentId)?.name ??
        issue.assigneeAgentId.slice(0, 8)
      );
    }
    return formatAssigneeUserLabel(
      issue.assigneeUserId,
      currentUserId,
      userLabelMap,
    ) ?? "Unassigned";
  }, [
    agents,
    currentUserId,
    issue.assigneeAgentId,
    issue.assigneeUserId,
    userLabelMap,
  ]);

  const dueDate = issueDueDate(issue);
  const dueLabel = dueDate ? formatDate(dueDate) : "No due date";
  const parentIdentifier = issue.ancestors?.[0]?.identifier;
  const parentTitle = issue.ancestors?.[0]?.title ?? issue.parentId?.slice(0, 8);
  const relatedIssues = useMemo(() => {
    const seen = new Set<string>();
    const related: Array<NonNullable<NonNullable<Issue["relatedWork"]>["outbound"]>[number]["issue"]> = [];
    for (const item of [
      ...(issue.relatedWork?.outbound ?? []),
      ...(issue.relatedWork?.inbound ?? []),
    ]) {
      if (!item.issue || seen.has(item.issue.id)) continue;
      seen.add(item.issue.id);
      related.push(item.issue);
    }
    return related;
  }, [issue.relatedWork?.inbound, issue.relatedWork?.outbound]);
  const creatorAgentName = issue.createdByAgentId
    ? agents?.find((agent) => agent.id === issue.createdByAgentId)?.name
    : null;
  const creatorUserLabel = formatAssigneeUserLabel(
    issue.createdByUserId,
    currentUserId,
    userLabelMap,
  );

  return (
    <div
      className={cn(
        "min-w-0 rounded-lg border border-border/70 bg-muted/20 p-4",
        "text-sm",
      )}
      aria-label="Issue summary"
    >
      <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
        <StripField label="Status">
          <StatusBadge status={issue.status} />
        </StripField>
        <StripField label="Priority">
          <PriorityIcon priority={issue.priority} showLabel />
        </StripField>

        <StripField label="Assignee">
          <UserRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">{assigneeLabel}</span>
        </StripField>
        <StripField label="Due Date">
          <CalendarDays className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">{dueLabel}</span>
        </StripField>

        <StripField label="Parent Task">
          {issue.parentId ? (
            <Link
              to={`/issues/${parentIdentifier ?? issue.parentId}`}
              className="min-w-0 truncate text-primary hover:underline"
            >
              {parentIdentifier ? `${parentIdentifier} ` : ""}
              {parentTitle}
            </Link>
          ) : (
            <span className="text-muted-foreground">No parent</span>
          )}
        </StripField>
        <StripField label="Blocking">
          <span>{(issue.blocks?.length ?? 0) > 0 ? "Yes" : "No"}</span>
          {(issue.blocks?.length ?? 0) > 0 ? (
            <span className="text-xs text-muted-foreground">({issue.blocks?.length})</span>
          ) : null}
        </StripField>

        <StripField label="Related to" className="sm:col-span-2">
          {relatedIssues.length > 0 ? (
            relatedIssues.map((related) => (
              <IssueReferencePill key={related.id} issue={related} />
            ))
          ) : (
            <span className="text-muted-foreground">No related issues</span>
          )}
        </StripField>

        <StripField label="Creator">
          {issue.createdByAgentId ? (
            <Link to={`/agents/${issue.createdByAgentId}`} className="min-w-0 hover:underline">
              <Identity name={creatorAgentName ?? issue.createdByAgentId.slice(0, 8)} size="sm" />
            </Link>
          ) : issue.createdByUserId ? (
            <>
              <UserRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">{creatorUserLabel ?? "User"}</span>
            </>
          ) : (
            <span className="text-muted-foreground">Unknown</span>
          )}
        </StripField>
        <StripField label="Timestamps">
          <span className="min-w-0 truncate">Created {formatDateTime(issue.createdAt)}</span>
          <span className="text-muted-foreground">·</span>
          <span className="min-w-0 truncate">Updated {timeAgo(issue.updatedAt)}</span>
        </StripField>
      </div>
    </div>
  );
}

export function IssueOutputPanel({
  issue,
  attachments,
  isLoading,
  onImageClick,
}: IssueOutputPanelProps) {
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryIndex, setGalleryIndex] = useState(0);
  const [docViewerAttachment, setDocViewerAttachment] =
    useState<IssueAttachment | null>(null);

  const isImageAttachment = (attachment: IssueAttachment) =>
    attachment.contentType.startsWith("image/");

  const imageAttachments = attachments.filter(isImageAttachment);
  const documentAttachments = attachments.filter((a) => !isImageAttachment(a));

  const handleImageClick = useCallback(
    (attachment: IssueAttachment) => {
      const idx = imageAttachments.findIndex((a) => a.id === attachment.id);
      setGalleryIndex(idx >= 0 ? idx : 0);
      setGalleryOpen(true);
      if (onImageClick) {
        onImageClick(attachment.contentPath, imageAttachments);
      }
    },
    [imageAttachments, onImageClick],
  );

  const handleDocumentClick = useCallback((attachment: IssueAttachment) => {
    setDocViewerAttachment(attachment);
  }, []);

  const isMarkdown = (attachment: IssueAttachment) =>
    attachment.contentType === "text/markdown" ||
    attachment.originalFilename?.toLowerCase().endsWith(".md") ||
    attachment.originalFilename?.toLowerCase().endsWith(".markdown");

  const isHtml = (attachment: IssueAttachment) =>
    attachment.contentType === "text/html" ||
    attachment.originalFilename?.toLowerCase().endsWith(".html") ||
    attachment.originalFilename?.toLowerCase().endsWith(".htm");

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <>
      <div className="min-w-0 max-w-full space-y-5 overflow-x-hidden p-4">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-foreground">Artifacts</h2>
            <p className="text-xs text-muted-foreground">
              Generated images and documents from this issue.
            </p>
          </div>
          <span className="shrink-0 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
            {attachments.length}
          </span>
        </div>

        {isLoading && attachments.length === 0 ? (
          <div className="flex items-center justify-center rounded-xl border border-dashed border-border bg-muted/20 py-16 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            Loading artifacts...
          </div>
        ) : attachments.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/20 px-5 py-16 text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-background text-muted-foreground shadow-sm ring-1 ring-border">
              <ImageIcon className="h-6 w-6" />
            </div>
            <p className="text-sm font-medium text-foreground">
              Start working to generate artifacts
            </p>
            <p className="mt-1 max-w-56 text-xs text-muted-foreground">
              Images, previews, and documents created by the run will appear here.
            </p>
          </div>
        ) : (
          <div className="min-w-0 space-y-5">
            {/* Image grid */}
            {imageAttachments.length > 0 && (
              <div className="min-w-0 space-y-3">
                <h3 className="text-xs font-semibold text-foreground">
                  Images ({imageAttachments.length})
                </h3>
                <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                  {imageAttachments.map((attachment) => (
                    <div
                      key={attachment.id}
                      className="group relative aspect-[4/3] overflow-hidden rounded-xl border border-border bg-accent/10 shadow-sm cursor-pointer"
                      onClick={() => handleImageClick(attachment)}
                    >
                      <img
                        src={attachment.contentPath}
                        alt={attachment.originalFilename ?? "image"}
                        className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
                        loading="lazy"
                      />
                      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-end">
                        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-2.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <p className="text-xs font-medium text-white truncate leading-tight">
                            {attachment.originalFilename ?? "image"}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Document list */}
            {documentAttachments.length > 0 && (
              <div className="min-w-0 space-y-3">
                <h3 className="text-xs font-semibold text-foreground">
                  Documents ({documentAttachments.length})
                </h3>
                <div className="grid min-w-0 gap-2">
                  {documentAttachments.map((attachment) => {
                    const isMd = isMarkdown(attachment);
                    const isHtmlFile = isHtml(attachment);
                    return (
                      <button
                        key={attachment.id}
                        type="button"
                        onClick={() => handleDocumentClick(attachment)}
                        className={cn(
                          "flex w-full min-w-0 items-center gap-3 rounded-xl border border-border bg-background p-4 shadow-sm",
                          "hover:bg-accent/40 hover:shadow transition-all text-left",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        )}
                      >
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                          {isMd ? (
                            <FileText className="h-5 w-5 text-amber-600" />
                          ) : isHtmlFile ? (
                            <Globe className="h-5 w-5 text-blue-500" />
                          ) : (
                            <FileText className="h-5 w-5 text-muted-foreground" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold truncate">
                            {attachment.originalFilename ?? attachment.id}
                          </p>
                          <p className="min-w-0 truncate text-[11px] text-muted-foreground">
                            {attachment.contentType} ·{" "}
                            {formatSize(attachment.byteSize ?? 0)}
                          </p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Image gallery modal */}
      <ImageGalleryModal
        images={imageAttachments}
        initialIndex={galleryIndex}
        open={galleryOpen}
        onOpenChange={setGalleryOpen}
      />

      {/* Document viewer modal */}
      {docViewerAttachment && (
        <DocumentViewerModal
          attachment={docViewerAttachment}
          open={!!docViewerAttachment}
          onOpenChange={(open) => {
            if (!open) setDocViewerAttachment(null);
          }}
        />
      )}
    </>
  );
}

interface DocumentViewerModalProps {
  attachment: IssueAttachment;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function DocumentViewerModal({
  attachment,
  open,
  onOpenChange,
}: DocumentViewerModalProps) {
  const isMd =
    attachment.contentType === "text/markdown" ||
    attachment.originalFilename?.toLowerCase().endsWith(".md") ||
    attachment.originalFilename?.toLowerCase().endsWith(".markdown");

  const isHtml =
    attachment.contentType === "text/html" ||
    attachment.originalFilename?.toLowerCase().endsWith(".html") ||
    attachment.originalFilename?.toLowerCase().endsWith(".htm");

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4",
        "data-[state=open]:animate-in data-[state=closed]:animate-out",
        "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        "data-[state=closed]:duration-200",
      )}
      data-state={open ? "open" : "closed"}
      onClick={() => onOpenChange(false)}
    >
      <div
        className="bg-background rounded-xl border border-border shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="min-w-0 flex-1 mr-4">
            <h3 className="text-sm font-semibold truncate">
              {attachment.originalFilename ?? "Document"}
            </h3>
            <p className="text-xs text-muted-foreground">
              {attachment.contentType}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <a
              href={attachment.contentPath}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              onClick={(e) => e.stopPropagation()}
            >
              Open in new tab
            </a>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto min-h-0">
          {isMd ? (
            <MarkdownDocViewer contentPath={attachment.contentPath} />
          ) : isHtml ? (
            <HtmlDocViewer contentPath={attachment.contentPath} />
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
              <p>
                Cannot preview this file type.{" "}
                <a
                  href={attachment.contentPath}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  Open in new tab
                </a>
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface HtmlDocViewerProps {
  contentPath: string;
}

function HtmlDocViewer({ contentPath }: HtmlDocViewerProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setHtml(null);

    fetch(contentPath)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load: ${res.status}`);
        return res.text();
      })
      .then((text) => {
        if (cancelled) return;
        setHtml(text);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [contentPath]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        Loading document...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        <p>
          Failed to load document.{" "}
          <a
            href={contentPath}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            Open in new tab
          </a>
        </p>
      </div>
    );
  }

  return (
    <iframe
      srcDoc={html ?? undefined}
      className="w-full h-full border-0 min-h-[60vh]"
      title="HTML document preview"
      sandbox="allow-scripts allow-same-origin"
    />
  );
}

interface MarkdownDocViewerProps {
  contentPath: string;
}

function MarkdownDocViewer({ contentPath }: MarkdownDocViewerProps) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent(null);

    fetch(contentPath)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load: ${res.status}`);
        return res.text();
      })
      .then((text) => {
        if (cancelled) return;
        setContent(text);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : "Failed to load document",
        );
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [contentPath]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        Loading document...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-destructive text-sm">
        {error}
      </div>
    );
  }

  if (!content) return null;

  return (
    <div className="p-6 prose prose-sm dark:prose-invert max-w-none">
      <MarkdownBody>{content}</MarkdownBody>
    </div>
  );
}
