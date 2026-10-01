import { z } from "zod";
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export function assert(
  value: unknown,
  status: number,
  message: string,
): asserts value {
  if (!value) throw new HttpError(status, message);
}
export const uuid = z.string().uuid(),
  title = z.string().trim().min(1).max(500),
  roles = z.enum(["owner", "admin", "member", "guest"]);
export const json = JSON.stringify;
export function textOf(v: any): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(textOf).join(" ");
  if (v && typeof v === "object")
    return [v.text, v.content, v.children]
      .filter(Boolean)
      .map(textOf)
      .join(" ");
  return "";
}
export const propertyTypes = [
  "title",
  "text",
  "number",
  "select",
  "multi_select",
  "status",
  "date",
  "checkbox",
  "person",
  "url",
  "email",
] as const;
export const property = z
  .object({
    id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
    name: z.string().min(1).max(120),
    type: z.enum(propertyTypes),
    options: z.array(z.string().min(1).max(120)).max(100).optional(),
  })
  .strict();
export const properties = z
  .array(property)
  .min(1)
  .max(100)
  .refine(
    (p) =>
      new Set(p.map((v) => v.id)).size === p.length &&
      p.filter((v) => v.type === "title").length === 1,
    "Unique property IDs and exactly one title required",
  );
export type Property = z.infer<typeof property>;
export function validateValues(props: Property[], values: Record<string, any>) {
  const result: Record<string, any> = {};
  for (const [k, v] of Object.entries(values)) {
    const p = props.find((p) => p.id === k);
    assert(p, 400, `Unknown property ${k}`);
    if (v === null || v === "") {
      result[k] = null;
      continue;
    }
    let s: z.ZodType = z.string().max(10000);
    switch (p.type) {
      case "title":
        s = z.string().trim().min(1).max(500);
        break;
      case "number":
        s = z.number().finite();
        break;
      case "checkbox":
        s = z.boolean();
        break;
      case "person":
        s = uuid;
        break;
      case "email":
        s = z.email();
        break;
      case "url":
        s = z.url().refine((v) => /^https?:\/\//.test(v));
        break;
      case "date":
        s = z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .refine(
            (v) =>
              !isNaN(Date.parse(v)) &&
              new Date(v).toISOString().slice(0, 10) === v,
          );
        break;
      case "select":
      case "status":
        s = z.string().refine((v) => p.options?.includes(v));
        break;
      case "multi_select":
        s = z
          .array(z.string())
          .refine((v) => v.every((x) => p.options?.includes(x)));
        break;
    }
    result[k] = s.parse(v);
  }
  const t = props.find((p) => p.type === "title");
  assert(
    t && typeof result[t.id] === "string" && result[t.id].trim(),
    400,
    "Record title required",
  );
  return result;
}
export const view = z
  .object({
    type: z.enum(["table", "board", "calendar"]),
    dateBy: z.string().optional(),
    groupBy: z.string().optional(),
    filters: z
      .array(
        z.object({
          property: z.string(),
          op: z.enum(["eq", "contains", "before", "after", "empty"]),
          value: z.unknown().optional(),
        }),
      )
      .max(20)
      .default([]),
    sort: z
      .array(
        z.object({ property: z.string(), direction: z.enum(["asc", "desc"]) }),
      )
      .max(5)
      .default([]),
    visible: z.array(z.string()).optional(),
    widths: z.record(z.string(), z.number().min(80).max(900)).optional(),
    order: z.array(z.string()).optional(),
  })
  .strict();
export const taskProperties: Property[] = [
  { id: "name", name: "Task", type: "title" },
  {
    id: "status",
    name: "Status",
    type: "status",
    options: ["Not started", "In progress", "Done"],
  },
  { id: "assignee", name: "Assignee", type: "person" },
  {
    id: "priority",
    name: "Priority",
    type: "select",
    options: ["Low", "Medium", "High"],
  },
  { id: "start", name: "Start date", type: "date" },
  { id: "due", name: "Due date", type: "date" },
];
