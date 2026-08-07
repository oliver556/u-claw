import { z } from "zod";

export const ISODateTimeSchema = z.iso.datetime();
export type ISODateTime = z.infer<typeof ISODateTimeSchema>;

export const StringMapValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type StringMapValue = z.infer<typeof StringMapValueSchema>;

export const PageRequestSchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();
export type PageRequest = z.infer<typeof PageRequestSchema>;

export type Page<T> = {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
};

export const ResourceRefSchema = z
  .object({
    kind: z.enum([
      "session",
      "message",
      "toolCall",
      "plugin",
      "mcp",
      "file",
      "memory",
      "channel",
      "operation",
    ]),
    id: z.string().min(1),
    label: z.string().optional(),
  })
  .strict();
export type ResourceRef = z.infer<typeof ResourceRefSchema>;

export const FileRefSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    mediaType: z.string().min(1),
    size: z.number().int().nonnegative(),
    kind: z.enum(["attachment", "workspace", "artifact", "log-export"]),
    relativePath: z.string().min(1).optional(),
  })
  .strict();
export type FileRef = z.infer<typeof FileRefSchema>;

export const ModelRefSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    providerId: z.string().min(1).optional(),
  })
  .strict();
export type ModelRef = z.infer<typeof ModelRefSchema>;
