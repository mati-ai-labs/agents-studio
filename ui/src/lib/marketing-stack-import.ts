import type { CompanySkillListItem } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { companySkillsApi } from "../api/companySkills";

export const MARKETING_STACK_IMPORT_EVENT = "paperclip:marketing-stack-import";

const STORAGE_PREFIX = "paperclip:marketing-stack-import:";

const MARKETING_STACK_IMPORT_SOURCES = [
  { id: "marketing-skills", label: "marketing skills", source: "coreyhaines31/marketingskills" },
  {
    id: "larry",
    label: "TikTok marketing skill",
    source: "https://clawhub.ai/api/v1/skills/larry/file?path=SKILL.md&ownerHandle=olliewazza",
  },
  { id: "brainstorm-ideas", label: "brainstorming skill", source: "borghei/Claude-Skills/brainstorm-ideas" },
  { id: "jobs-to-be-done", label: "jobs-to-be-done skill", source: "deanpeters/Product-Manager-Skills/jobs-to-be-done" },
  {
    id: "opportunity-solution-tree",
    label: "opportunity-solution-tree skill",
    source: "deanpeters/Product-Manager-Skills/opportunity-solution-tree",
  },
] as const;

type SourceState = "pending" | "running" | "completed" | "failed";

export interface MarketingStackAgentLink {
  agentId: string;
  desiredSkillRefs: readonly string[];
  skillSlugs: readonly string[];
}

export interface MarketingStackImportStatus {
  companyId: string;
  state: "running" | "completed" | "failed";
  completedSources: number;
  totalSources: number;
  activeSources: string[];
  failedSources: string[];
  linkedAgents: number;
  totalAgents: number;
  error: string | null;
  updatedAt: string;
}

interface StoredJob {
  companyId: string;
  state: MarketingStackImportStatus["state"];
  sourceStates: Record<string, { state: SourceState; error?: string }>;
  agentLinks: MarketingStackAgentLink[];
  linkedAgentIds: string[];
  error: string | null;
  updatedAt: string;
}

interface ActiveJob extends StoredJob {
  runPromise?: Promise<void>;
  linkPromise?: Promise<void>;
}

const activeJobs = new Map<string, ActiveJob>();

function storageKey(companyId: string) {
  return `${STORAGE_PREFIX}${companyId}`;
}

function readStoredJob(companyId: string): StoredJob | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey(companyId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredJob>;
    if (
      parsed.companyId !== companyId
      || !parsed.sourceStates
      || !Array.isArray(parsed.agentLinks)
      || !Array.isArray(parsed.linkedAgentIds)
    ) {
      return null;
    }
    return {
      companyId,
      state: parsed.state === "completed" || parsed.state === "failed" ? parsed.state : "running",
      sourceStates: parsed.sourceStates,
      agentLinks: parsed.agentLinks,
      linkedAgentIds: parsed.linkedAgentIds,
      error: typeof parsed.error === "string" ? parsed.error : null,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

function sourceStateRecord(): StoredJob["sourceStates"] {
  return Object.fromEntries(
    MARKETING_STACK_IMPORT_SOURCES.map((source) => [source.id, { state: "pending" as const }]),
  );
}

function createJob(companyId: string): ActiveJob {
  return {
    companyId,
    state: "running",
    sourceStates: sourceStateRecord(),
    agentLinks: [],
    linkedAgentIds: [],
    error: null,
    updatedAt: new Date().toISOString(),
  };
}

function getOrLoadJob(companyId: string) {
  const active = activeJobs.get(companyId);
  if (active) return active;
  const stored = readStoredJob(companyId);
  if (!stored) return null;
  activeJobs.set(companyId, stored);
  return stored;
}

function statusFor(job: StoredJob): MarketingStackImportStatus {
  const sourceStates = Object.values(job.sourceStates);
  const completedSources = sourceStates.filter((entry) => entry.state === "completed").length;
  const activeSources = MARKETING_STACK_IMPORT_SOURCES
    .filter((source) => job.sourceStates[source.id]?.state === "running")
    .map((source) => source.label);
  const failedSources = MARKETING_STACK_IMPORT_SOURCES
    .filter((source) => job.sourceStates[source.id]?.state === "failed")
    .map((source) => source.label);

  return {
    companyId: job.companyId,
    state: job.state,
    completedSources,
    totalSources: MARKETING_STACK_IMPORT_SOURCES.length,
    activeSources,
    failedSources,
    linkedAgents: job.linkedAgentIds.length,
    totalAgents: job.agentLinks.length,
    error: job.error,
    updatedAt: job.updatedAt,
  };
}

function persistAndNotify(job: ActiveJob) {
  job.updatedAt = new Date().toISOString();
  if (typeof window !== "undefined") {
    try {
      const { runPromise: _runPromise, linkPromise: _linkPromise, ...stored } = job;
      window.localStorage.setItem(storageKey(job.companyId), JSON.stringify(stored));
    } catch {
      // Status remains available in memory when storage is unavailable.
    }
    window.dispatchEvent(
      new CustomEvent<MarketingStackImportStatus>(MARKETING_STACK_IMPORT_EVENT, {
        detail: statusFor(job),
      }),
    );
  }
}

export function getMarketingStackImportStatus(companyId: string): MarketingStackImportStatus | null {
  const job = getOrLoadJob(companyId);
  return job ? statusFor(job) : null;
}

export function subscribeMarketingStackImportStatus(listener: (status: MarketingStackImportStatus) => void) {
  if (typeof window === "undefined") return () => undefined;
  const onUpdate = (event: Event) => {
    const status = (event as CustomEvent<MarketingStackImportStatus>).detail;
    if (status) listener(status);
  };
  const onStorage = (event: StorageEvent) => {
    if (!event.key?.startsWith(STORAGE_PREFIX) || !event.newValue) return;
    try {
      const stored = JSON.parse(event.newValue) as StoredJob;
      listener(statusFor(stored));
    } catch {
      // Ignore malformed storage written by an older client.
    }
  };
  window.addEventListener(MARKETING_STACK_IMPORT_EVENT, onUpdate);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(MARKETING_STACK_IMPORT_EVENT, onUpdate);
    window.removeEventListener("storage", onStorage);
  };
}

function availableSkillRefs(skills: CompanySkillListItem[]) {
  const refs = new Set<string>();
  for (const skill of skills) {
    refs.add(skill.key);
    refs.add(skill.slug);
  }
  return refs;
}

function resolveLinkSkills(link: MarketingStackAgentLink, skills: CompanySkillListItem[]) {
  const bySlug = new Map(skills.map((skill) => [skill.slug, skill.key]));
  const available = availableSkillRefs(skills);
  const desired = link.desiredSkillRefs.filter((ref) => available.has(ref));
  for (const slug of link.skillSlugs) {
    const key = bySlug.get(slug);
    if (key) desired.push(key);
  }
  return Array.from(new Set(desired));
}

async function linkAgentsOnce(job: ActiveJob) {
  if (job.agentLinks.length === 0) return;
  const skills = await companySkillsApi.list(job.companyId);
  const failures: string[] = [];

  await Promise.all(job.agentLinks.map(async (link) => {
    const desiredSkills = resolveLinkSkills(link, skills);
    if (desiredSkills.length === 0) return;
    try {
      await agentsApi.syncSkills(link.agentId, desiredSkills, job.companyId);
      if (!job.linkedAgentIds.includes(link.agentId)) {
        job.linkedAgentIds.push(link.agentId);
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : `Failed to link skills to ${link.agentId}`);
    }
  }));

  if (failures.length > 0) {
    job.error = failures.join("; ");
    job.state = "failed";
  }
  persistAndNotify(job);
}

function queueAgentLinking(job: ActiveJob) {
  job.linkPromise = (job.linkPromise ?? Promise.resolve())
    .then(() => linkAgentsOnce(job))
    .finally(() => {
      job.linkPromise = undefined;
    });
  return job.linkPromise;
}

async function runJob(job: ActiveJob) {
  const pendingSources = MARKETING_STACK_IMPORT_SOURCES.filter(
    (source) => job.sourceStates[source.id]?.state !== "completed",
  );

  await Promise.all(pendingSources.map(async (source) => {
    job.sourceStates[source.id] = { state: "running" };
    persistAndNotify(job);
    try {
      await companySkillsApi.importFromSource(job.companyId, source.source);
      job.sourceStates[source.id] = { state: "completed" };
      persistAndNotify(job);
      await queueAgentLinking(job);
    } catch (error) {
      job.sourceStates[source.id] = {
        state: "failed",
        error: error instanceof Error ? error.message : "Skill import failed",
      };
      job.error = `${source.label}: ${job.sourceStates[source.id].error}`;
      persistAndNotify(job);
    }
  }));

  await queueAgentLinking(job);
  const hasFailures = Object.values(job.sourceStates).some((entry) => entry.state === "failed")
    || Boolean(job.error && job.linkedAgentIds.length < job.agentLinks.length);
  job.state = hasFailures ? "failed" : "completed";
  if (!hasFailures) job.error = null;
  persistAndNotify(job);
}

function launchJob(job: ActiveJob) {
  if (job.runPromise) return;
  job.state = "running";
  persistAndNotify(job);
  job.runPromise = runJob(job)
    .catch((error) => {
      job.state = "failed";
      job.error = error instanceof Error ? error.message : "Marketing Stack import failed";
      persistAndNotify(job);
    })
    .finally(() => {
      job.runPromise = undefined;
    });
}

export function startMarketingStackImport(companyId: string) {
  const existing = getOrLoadJob(companyId);
  if (existing) {
    if (existing.state === "failed") retryMarketingStackImport(companyId);
    else if (existing.state === "running") launchJob(existing);
    return statusFor(existing);
  }

  const job = createJob(companyId);
  activeJobs.set(companyId, job);
  persistAndNotify(job);
  launchJob(job);
  return statusFor(job);
}

export function resumeMarketingStackImport(companyId: string) {
  const job = getOrLoadJob(companyId);
  if (job?.state === "running") launchJob(job);
  return job ? statusFor(job) : null;
}

export function retryMarketingStackImport(companyId: string) {
  const job = getOrLoadJob(companyId) ?? createJob(companyId);
  job.sourceStates = sourceStateRecord();
  job.state = "running";
  job.error = null;
  job.linkedAgentIds = [];
  activeJobs.set(companyId, job);
  persistAndNotify(job);
  launchJob(job);
  return statusFor(job);
}

export function registerMarketingStackAgents(companyId: string, links: MarketingStackAgentLink[]) {
  const job = getOrLoadJob(companyId) ?? createJob(companyId);
  job.agentLinks = links;
  job.linkedAgentIds = job.linkedAgentIds.filter((agentId) => links.some((link) => link.agentId === agentId));
  activeJobs.set(companyId, job);
  persistAndNotify(job);
  void queueAgentLinking(job);
  if (job.state === "running") launchJob(job);
  return statusFor(job);
}
