import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type {
  EvalAgentAction,
  EvalBundle,
  EvalCheckSpec,
  EvalPolicyLabel,
  EvalScenarioFile,
} from "@paperclipai/shared";

/**
 * Scenario files are JSON so they can be read without a YAML dependency, and
 * so a scenario is diffable in a pull request.
 */
export const SCENARIO_FILE_SUFFIX = ".scenario.json";

export class EvalScenarioParseError extends Error {
  constructor(
    message: string,
    readonly filePath: string,
  ) {
    super(`${filePath}: ${message}`);
    this.name = "EvalScenarioParseError";
  }
}

function assertString(
  value: unknown,
  field: string,
  filePath: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new EvalScenarioParseError(`"${field}" must be a non-empty string`, filePath);
  }
}

function assertObject(
  value: unknown,
  field: string,
  filePath: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EvalScenarioParseError(`"${field}" must be an object`, filePath);
  }
}

function parseScenario(raw: unknown, filePath: string): EvalScenarioFile {
  assertObject(raw, "scenario", filePath);
  const value = raw;

  assertString(value.id, "id", filePath);
  assertString(value.description, "description", filePath);
  if (typeof value.version !== "number") {
    throw new EvalScenarioParseError('"version" must be a number', filePath);
  }
  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string")) {
    throw new EvalScenarioParseError('"tags" must be an array of strings', filePath);
  }
  if (!Array.isArray(value.checks)) {
    throw new EvalScenarioParseError('"checks" must be an array', filePath);
  }
  if (!Array.isArray(value.script)) {
    throw new EvalScenarioParseError('"script" must be an array', filePath);
  }

  assertObject(value.task, "task", filePath);
  const taskValue = value.task;
  assertString(taskValue.title, "task.title", filePath);
  assertString(taskValue.description, "task.description", filePath);

  assertObject(value.bundle, "bundle", filePath);
  const bundleValue = value.bundle;
  assertString(bundleValue.id, "bundle.id", filePath);
  assertString(bundleValue.adapter, "bundle.adapter", filePath);
  assertString(bundleValue.model, "bundle.model", filePath);
  assertString(bundleValue.promptTemplate, "bundle.promptTemplate", filePath);
  if (!Array.isArray(bundleValue.skills) || bundleValue.skills.some((s) => typeof s !== "string")) {
    throw new EvalScenarioParseError('"bundle.skills" must be an array of strings', filePath);
  }

  return {
    version: value.version,
    id: value.id,
    description: value.description,
    tags: value.tags as string[],
    bundle: bundleValue as unknown as EvalBundle,
    task: taskValue as EvalScenarioFile["task"],
    seedPolicy: value.seedPolicy as EvalScenarioFile["seedPolicy"],
    script: value.script as EvalAgentAction[],
    checks: value.checks as EvalCheckSpec[],
    policyLabels: value.policyLabels as EvalPolicyLabel[] | undefined,
    violationClass: value.violationClass as EvalScenarioFile["violationClass"],
  };
}

export function loadScenarioFile(filePath: string): EvalScenarioFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new EvalScenarioParseError(
      `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      filePath,
    );
  }
  return parseScenario(raw, filePath);
}

/**
 * Load every scenario in a directory.
 *
 * Scenarios are loaded eagerly and sorted by path so a run is reproducible:
 * the order scenarios execute in never depends on filesystem ordering.
 */
export function loadScenarios(directory: string): EvalScenarioFile[] {
  const entries = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(SCENARIO_FILE_SUFFIX))
    .map((entry) => path.join(directory, entry.name))
    .sort();

  const scenarios = entries.map((filePath) => loadScenarioFile(filePath));
  const seen = new Set<string>();
  for (const scenario of scenarios) {
    if (seen.has(scenario.id)) {
      throw new EvalScenarioParseError(`duplicate scenario id "${scenario.id}"`, directory);
    }
    seen.add(scenario.id);
  }
  return scenarios;
}
