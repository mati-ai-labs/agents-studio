import { z } from "zod";

export const upsertSlackChannelRouteSchema = z.object({
  assigneeAgentId: z.string().uuid(),
  enabled: z.boolean().optional().default(true),
});

export type UpsertSlackChannelRouteInput = z.infer<typeof upsertSlackChannelRouteSchema>;

export const slackChannelIdParamSchema = z.object({
  channelId: z.string().trim().min(1).max(64),
});

export const slackChannelRoutesQuerySchema = z.object({
  companyId: z.string().uuid().optional(),
});

export const slackEventsInfoQuerySchema = z.object({
  companyId: z.string().uuid().optional(),
});