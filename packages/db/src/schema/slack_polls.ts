import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";

export interface SlackPollOption {
  id: string;
  label: string;
}

/**
 * slack_polls — a question an agent posted in Slack as buttons. Votes arrive
 * through the Slack interactivity endpoint, are stored here (one entry per
 * Slack user), and come back to the issue as comments.
 */
export const slackPolls = pgTable(
  "slack_polls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    channelId: text("channel_id").notNull(),
    channelName: text("channel_name").notNull(),
    /** ts of the poll message; null only between insert and the Slack post. */
    messageTs: text("message_ts"),
    threadTs: text("thread_ts"),
    question: text("question").notNull(),
    options: jsonb("options").$type<SlackPollOption[]>().notNull(),
    multiSelect: boolean("multi_select").notNull().default(false),
    /** Slack user id -> chosen option ids. */
    votes: jsonb("votes").$type<Record<string, string[]>>().notNull().default({}),
    /** `open` or `closed`. */
    status: text("status").notNull().default("open"),
    closesAt: timestamp("closes_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueIdx: index("slack_polls_company_issue_idx").on(table.companyId, table.issueId),
    messageIdx: index("slack_polls_channel_message_idx").on(table.channelId, table.messageTs),
  }),
);

export type SlackPoll = typeof slackPolls.$inferSelect;
export type NewSlackPoll = typeof slackPolls.$inferInsert;
