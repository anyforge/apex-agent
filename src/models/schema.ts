// Shared tool-schema → zod mapping for the ai SDK adapters.
import { z } from "zod";
import type { ToolParamSpec } from "./types.js";

export function toZod(params?: Record<string, ToolParamSpec>): z.ZodType {
  if (!params) return z.object({});
  const shape: Record<string, z.ZodType> = {};
  for (const [k, v] of Object.entries(params)) {
    let t: z.ZodType;
    switch (v.type) {
      case "number":
        t = z.number();
        break;
      case "boolean":
        t = z.boolean();
        break;
      case "array":
        t = z.array(v.items?.type === "number" ? z.number() : v.items?.type === "boolean" ? z.boolean() : z.string());
        break;
      default:
        t = z.string();
    }
    shape[k] = v.required === false ? t.optional() : t;
  }
  return z.object(shape);
}

// Plain JSON Schema (JSONSchema7) for provider-level `doStream` calls, which expect a raw
// JSON schema — not a zod object — in `tools[].inputSchema`.
export function toJsonSchema(params?: Record<string, ToolParamSpec>): Record<string, unknown> {
  if (!params) return { type: "object", properties: {} };
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    let t: string;
    switch (v.type) {
      case "number":
        t = "number";
        break;
      case "boolean":
        t = "boolean";
        break;
      case "array":
        t = "array";
        break;
      default:
        t = "string";
    }
    const prop: Record<string, unknown> = { type: t };
    if (v.description) prop.description = v.description;
    if (v.type === "array" && v.items) prop.items = { type: v.items.type };
    if (v.enum) prop.enum = v.enum;
    properties[k] = prop;
    if (v.required !== false) required.push(k);
  }
  const schema: Record<string, unknown> = { type: "object", properties };
  if (required.length) schema.required = required;
  return schema;
}
