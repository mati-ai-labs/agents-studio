import type { RoutineTriggerSecretMaterial, RoutineVariable } from "@paperclipai/shared";

const SOURCE_ISSUE_MARKER = "__PAPERCLIP_SOURCE_ISSUE_ID__";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function variableExample(variable: RoutineVariable): string | number | boolean {
  if (variable.defaultValue !== null) return variable.defaultValue;
  return `<${variable.name}>`;
}

export function buildRoutineAgentConnectionCommand(input: {
  connection: RoutineTriggerSecretMaterial;
  variables: RoutineVariable[];
}): string {
  const payload = JSON.stringify({
    source_issue_id: SOURCE_ISSUE_MARKER,
    variables: Object.fromEntries(
      input.variables.map((variable) => [variable.name, variableExample(variable)]),
    ),
  });
  const [beforeSourceIssue, afterSourceIssue] = payload.split(SOURCE_ISSUE_MARKER);

  return [
    'SOURCE_ISSUE_ID="${PAPERCLIP_SOURCE_ISSUE_ID:-$PAPERCLIP_TASK_ID}"',
    `curl -X POST ${shellQuote(input.connection.webhookUrl)} \\\n+  -H ${shellQuote(`Authorization: Bearer ${input.connection.webhookSecret}`)} \\\n+  -H 'Content-Type: application/json' \\\n+  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \\\n+  --data ${shellQuote(beforeSourceIssue ?? "")}"$SOURCE_ISSUE_ID"${shellQuote(afterSourceIssue ?? "")}`,
  ].join("\n");
}
