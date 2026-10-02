import { parse } from "csv-parse/sync";
import { z } from "zod";
import { assert, type Property, validateValues } from "../contracts/index.ts";

export const csvColumnMapping = z.object({
  source: z.string().min(1).max(120),
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
  name: z.string().trim().min(1).max(120),
  type: z.enum(["title", "text", "number", "date", "checkbox"]),
  skip: z.boolean().optional(),
}).strict();
export type CsvColumnMapping = z.infer<typeof csvColumnMapping>;
export const csvMappingSchema = z.array(csvColumnMapping).min(1).max(100);

type CsvTable = { columns: string[]; rows: string[][] };
const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const numeric = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

function safeDate(text: string) {
  return isoDate.test(text) && !Number.isNaN(Date.parse(text)) &&
    new Date(text).toISOString().slice(0, 10) === text;
}

/** The preview and worker use the same strict parser and bounded schema. */
export function readCsvTable(content: string): CsvTable {
  assert(typeof content === "string" && Buffer.byteLength(content, "utf8") <=
    2097152, 400, "CSV cannot exceed 2 MiB");
  let parsed: string[][];
  try {
    parsed = parse(content, { bom: true, skip_empty_lines: true,
      max_record_size: 100000, relax_column_count: false }) as string[][];
  } catch {
    assert(false, 400, "Invalid CSV rows, quoting or column counts");
    throw new Error("Unreachable");
  }
  assert(parsed.length > 1 && parsed.length <= 2001, 400,
    "CSV requires 1–2000 data rows");
  const columns = parsed[0].map((x) => x.trim());
  assert(columns.length > 0 && columns.length <= 100, 400,
    "CSV must have 1–100 columns");
  assert(columns.every((x) => x.length > 0 && x.length <= 120), 400,
    "CSV headers must be 1–120 characters");
  assert(new Set(columns.map((x) => x.toLocaleLowerCase("en"))).size ===
    columns.length, 400, "CSV column headings must be unique");
  assert(parsed.slice(1).every((row) => row.length === columns.length),
    400, "CSV rows must match the header column count");
  return { columns, rows: parsed.slice(1) };
}

export function proposeCsvMapping(table: CsvTable): CsvColumnMapping[] {
  return table.columns.map((source, i) => {
    const samples = table.rows.slice(0, 100).map((r) => r[i].trim())
      .filter(Boolean);
    let type: CsvColumnMapping["type"] = "text";
    if (i === 0) type = "title";
    else if (samples.length && samples.every((x) =>
      numeric.test(x) && Number.isFinite(Number(x)))) type = "number";
    else if (samples.length && samples.every((x) =>
      /^(true|false)$/i.test(x))) type = "checkbox";
    else if (samples.length && samples.every(safeDate)) type = "date";
    return { source, id: "field" + i, name: source, type };
  });
}

function effectiveMapping(columns: string[], mapping?: CsvColumnMapping[]) {
  // Maintain legacy unconfigured import semantics. A proposed mapping is
  // accepted only through an explicit UI choice or API payload.
  const actual = mapping ? csvMappingSchema.parse(mapping) :
    columns.map((source, i) => ({
      source, id: "field" + i, name: source,
      type: (i === 0 ? "title" : "text") as "title" | "text",
    }));
  assert(actual.length === columns.length, 400,
    "Every CSV source column needs exactly one mapping");
  assert(actual.every((entry, index) => entry.source === columns[index]), 400,
    "CSV mappings must match ordered original headings");
  const selected = actual.filter((m) => !m.skip);
  assert(new Set(selected.map((m) => m.id)).size === selected.length, 400,
    "CSV property identifiers must be unique");
  assert(selected.filter((m) => m.type === "title").length === 1, 400,
    "Exactly one title column is required");
  return actual;
}

function convert(source: string, type: CsvColumnMapping["type"],
  explicit: boolean) {
  const trimmed = source.trim();
  if (type === "title") {
    // Historical unmapped imports replace empty first columns with Untitled.
    // Explicit mappings instead expose the bad source row to the user.
    assert(trimmed || !explicit, 400, "Mapped title values must not be empty");
    return trimmed || "Untitled";
  }
  if (!trimmed) return null;
  if (type === "text") return source;
  if (type === "number") {
    assert(numeric.test(trimmed) && Number.isFinite(Number(trimmed)), 400,
      "CSV number must be finite");
    return Number(trimmed);
  }
  if (type === "date") {
    assert(safeDate(trimmed), 400, "CSV date must be YYYY-MM-DD");
    return trimmed;
  }
  assert(/^(true|false)$/i.test(trimmed), 400,
    "CSV checkbox must be true or false");
  return trimmed.toLowerCase() === "true";
}

/** Preflight all values before creating any database records. */
export function prepareCsvImport(content: string, mapping?: CsvColumnMapping[]) {
  const table = readCsvTable(content);
  const effective = effectiveMapping(table.columns, mapping);
  const selected = effective.filter((m) => !m.skip);
  const properties = selected.map(({ id, name, type }) =>
    ({ id, name, type })) as Property[];
  const prepared = table.rows.map((row, index) => {
    try {
      const values = Object.fromEntries(effective.flatMap((m, i) =>
        m.skip ? [] : [[m.id, convert(row[i], m.type, !!mapping)]]));
      return validateValues(properties, values);
    } catch {
      assert(false, 400, "CSV conversion failed at data row " + (index + 1));
      throw new Error("Unreachable");
    }
  });
  return { columns: table.columns, properties, rows: prepared,
    mapping: effective };
}

export function previewCsvImport(content: string) {
  const table = readCsvTable(content);
  return { columns: table.columns, row_count: table.rows.length,
    mapping: proposeCsvMapping(table),
    sample: table.rows.slice(0, 5).map((row) => [...row]),
    warnings: ["Type suggestions use the first 100 rows. Review mappings " +
      "before import; the worker validates every cell without partial writes."] };
}
