import { z } from "zod";

export const createPreviewLeaseSchema = z.object({
  runtimeServiceId: z.string().uuid(),
}).strict();

export type CreatePreviewLease = z.infer<typeof createPreviewLeaseSchema>;
