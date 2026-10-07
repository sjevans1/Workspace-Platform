import { readFile, writeFile } from "node:fs/promises";
import { integrationOpenApi, type JsonSchema } from "../packages/contracts/openapi.ts";

const target = new URL("../packages/integration-client/generated.ts", import.meta.url);

function literal(value: unknown) {
  return JSON.stringify(value);
}
function schemaType(schema: any): string {
  if (!schema || Object.keys(schema).length === 0) return "unknown";
  if (Array.isArray(schema.anyOf))
    return schema.anyOf.map(schemaType).join(" | ");
  if (Array.isArray(schema.enum))
    return schema.enum.map(literal).join(" | ");
  if ("const" in schema) return literal(schema.const);
  if (schema.type === "null") return "null";
  if (schema.type === "string") return "string";
  if (schema.type === "number" || schema.type === "integer") return "number";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "array") return `Array<${schemaType(schema.items || {})}>`;
  if (schema.type === "object" || schema.properties) {
    const required = new Set<string>(schema.required || []);
    const props = Object.entries(schema.properties || {}).map(([key, value]) =>
      `${JSON.stringify(key)}${required.has(key) ? "" : "?"}: ${schemaType(value)};`,
    );
    const base = `{ ${props.join(" ")} }`;
    return schema.additionalProperties === true
      ? `${base} & Record<string, unknown>`
      : base;
  }
  return "unknown";
}

const entries = Object.entries(integrationOpenApi).map(([route, schema]) => {
  const [method, path] = route.split(" ", 2);
  const response = schema.response?.[200] || {};
  return [
    `  ${JSON.stringify(route)}: {`,
    `    method: ${JSON.stringify(method)};`,
    `    path: ${JSON.stringify("/api/v1" + path)};`,
    `    params: ${schemaType(schema.params || { type: "object", properties: {}, additionalProperties: false })};`,
    `    query: ${schemaType(schema.querystring || { type: "object", properties: {}, additionalProperties: false })};`,
    `    body: ${schemaType(schema.body || { type: "null" })};`,
    `    response: ${schemaType(response)};`,
    "  };",
  ].join("\n");
});

const output = [
  "// GENERATED FILE. DO NOT EDIT.",
  "// Source: packages/contracts/openapi.ts",
  "",
  "export type IntegrationRoutes = {",
  entries.join("\n"),
  "};",
  "",
  "export type IntegrationRoute = keyof IntegrationRoutes;",
  "",
].join("\n");

if (process.argv.includes("--check")) {
  const current = await readFile(target, "utf8").catch(() => "");
  if (current !== output) {
    console.error("Generated integration client types are out of date.");
    process.exit(1);
  }
} else {
  await writeFile(target, output, "utf8");
}
