// Bootstrap Marketing Ideas Curator agent + content-curation-skill
// Run with: tsx scripts/bootstrap-curator.mjs
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

const PG_DIR = path.resolve(process.cwd(), "data/pglite");
const COMPANY_ID = "3f83238b-de99-4408-93ee-3d8fab56b4af";
const SKILL_KEY = "content-curation-skill";
const SKILL_PATH = "/data/content-curation-skill/SKILL.md";

const randomId = () => crypto.randomUUID();
const markdown = fs.readFileSync(SKILL_PATH, "utf-8");

console.log("Opening PGlite at", PG_DIR);
const pg = new PGlite(PG_DIR);

// 1. Check if skill exists
const existing = await pg.query(
  "SELECT id FROM company_skills WHERE company_id = $1 AND key = $2",
  [COMPANY_ID, SKILL_KEY]
);

let skillId;
if (existing.rows.length > 0) {
  skillId = existing.rows[0].id;
  await pg.query(
    "UPDATE company_skills SET name=$1, description=$2, markdown=$3, updated_at=NOW() WHERE id=$4",
    ["Content Curation Skill", "Research winning content ideas from 15+ sources", markdown, skillId]
  );
  console.log("Skill updated:", skillId);
} else {
  skillId = randomId();
  await pg.query(
    `INSERT INTO company_skills (id, company_id, key, slug, name, description, markdown, source_type, source_locator, trust_level, compatibility, file_inventory, metadata, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),NOW())`,
    [
      skillId, COMPANY_ID, SKILL_KEY, "content-curation-skill",
      "Content Curation Skill",
      "Research, extract, and synthesize winning content ideas from 15+ sources to generate creative briefs for carousel ad creation.",
      markdown,
      "local_path", SKILL_PATH,
      "markdown_only", "compatible",
      JSON.stringify([]),
      JSON.stringify({ role: "marketing_content_curator", version: "3.0.0" })
    ]
  );
  console.log("Skill created:", skillId);
}

// 2. Create agent
const agentId = randomId();
await pg.query(
  `INSERT INTO agents (id, company_id, name, role, title, icon, status, adapter_type, adapter_config, runtime_config, budget_monthly_cents, permissions, created_at, updated_at)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),NOW())`,
  [
    agentId, COMPANY_ID,
    "Marketing Ideas Curator",
    "marketing_curator",
    "Marketing Ideas Curator",
    "🎯", "idle", "claude_local",
    JSON.stringify({
      env: {},
      desiredSkills: ["content-curation-skill"],
      model: "claude-sonnet-4-5-20250929"
    }),
    JSON.stringify({ heartbeat: { enabled: true, intervalSeconds: 300 } }),
    5000,
    JSON.stringify({ canCreateAgents: false })
  ]
);
console.log("Agent created:", agentId);

await pg.close();
console.log("\n=== DONE ===");
