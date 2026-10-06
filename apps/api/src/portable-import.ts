import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Query } from "../../../packages/database/index.ts";
import { one } from "../../../packages/database/index.ts";
import type { Actor } from "../../../packages/auth/index.ts";
import {
  assert,
  json,
  properties,
  textOf,
  uuid,
  view,
  validateValues,
} from "../../../packages/contracts/index.ts";
import { requireAccess } from "../../../packages/permissions/index.ts";
import {
  inspectPortableArchive,
  type PortableArchiveManifest,
} from "../../../packages/portable-archive/index.ts";
import type { Storage } from "../../../packages/storage/index.ts";
import { inspectFile } from "../../../packages/storage/index.ts";
import type { Antivirus } from "../../../packages/security/antivirus.ts";
import { createRecord, createResource } from "./domain.ts";
import {
  indexedRecordText,
  validateRelationWrites,
} from "./relations.ts";
import {
  blocksToState,
  validateBlocks,
} from "../../../packages/editor/server.ts";
import { syncWorkspaceResourceLinks } from "../../../packages/editor/link-index.ts";
import { emit } from "../../../packages/events/index.ts";

const treeNodeSchema = z.object({
  id: uuid,
  parent_id: uuid.nullable(),
  kind: z.enum(["workspace", "space", "page", "database", "record"]),
  title: z.string().max(500),
  icon: z.string().max(20),
  position: z.number().finite(),
}).strict();

const documentSchema = z.object({
  resource_id: uuid,
  blocks: z.unknown(),
  plain_text: z.string(),
  revision: z.number().int().positive(),
}).strict();

const databaseSchema = z.object({
  resource_id: uuid,
  properties: z.unknown(),
  views: z.array(z.object({
    id: uuid,
    name: z.string().min(1).max(120),
    config: z.unknown(),
  }).strict()).max(200),
}).strict();

const recordSchema = z.object({
  id: uuid,
  database_id: uuid,
  title: z.string().max(500),
  icon: z.string().max(20),
  position: z.number().finite(),
  values: z.record(z.string(), z.unknown()),
  revision: z.number().int().positive(),
}).strict();

const fileIndexSchema = z.array(z.object({
  id: uuid,
  resource_id: uuid,
  name: z.string().min(1).max(255),
  mime: z.string().min(1).max(255),
  size: z.number().int().min(0).max(25 * 1024 * 1024),
}).strict()).max(2_000);

function parseJsonEntry<T>(
  entries: Map<string, Buffer>,
  path: string,
  schema: z.ZodType<T>,
): T {
  const bytes = entries.get(path);
  assert(bytes, 400, `Archive entry missing: ${path}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    assert(false, 400, `Archive JSON is invalid: ${path}`);
  }
  return schema.parse(parsed);
}

function remapBlocks(
  value: unknown,
  resources: Map<string, string>,
  files: Map<string, string>,
  report: ImportReport,
  depth = 0,
): unknown {
  assert(depth < 40, 400, "Archive document nesting too deep");
  if (Array.isArray(value))
    return value.map((entry) =>
      remapBlocks(entry, resources, files, report, depth + 1));
  if (!value || typeof value !== "object") return value;
  const input = value as Record<string, unknown>,
    output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(input)) {
    if ((key === "href" || key === "url") && typeof child === "string") {
      const page = /^\/?\?page=([0-9a-f-]{36})$/i.exec(child);
      if (page) {
        const mapped = resources.get(page[1].toLowerCase());
        if (mapped)
          output[key] = "/?page=" + mapped;
        else {
          output[key] = "";
          report.dropped_external_page_links += 1;
        }
        continue;
      }
      const file =
        /^\/api\/v1\/files\/([0-9a-f-]{36})\/content$/i.exec(child);
      if (file) {
        const mapped = files.get(file[1].toLowerCase());
        if (mapped)
          output[key] = `/api/v1/files/${mapped}/content`;
        else {
          output[key] = "";
          report.dropped_external_file_links += 1;
        }
        continue;
      }
    }
    output[key] = remapBlocks(child, resources, files, report, depth + 1);
  }
  return output;
}

function sanitizeView(config: unknown, allowed: Set<string>) {
  const raw = (config && typeof config === "object")
    ? structuredClone(config as Record<string, any>)
    : {};
  if (Array.isArray(raw.filters))
    raw.filters = raw.filters.filter((f: any) => allowed.has(f?.property));
  if (Array.isArray(raw.sort))
    raw.sort = raw.sort.filter((s: any) => allowed.has(s?.property));
  if (Array.isArray(raw.visible))
    raw.visible = raw.visible.filter((id: any) =>
      typeof id === "string" && allowed.has(id));
  if (Array.isArray(raw.order))
    raw.order = raw.order.filter((id: any) =>
      typeof id === "string" && allowed.has(id));
  if (raw.widths && typeof raw.widths === "object")
    raw.widths = Object.fromEntries(Object.entries(raw.widths)
      .filter(([id]) => allowed.has(id)));
  if (raw.groupBy && !allowed.has(raw.groupBy)) delete raw.groupBy;
  if (raw.dateBy && !allowed.has(raw.dateBy)) delete raw.dateBy;
  return view.parse(raw);
}

export type ImportReport = {
  resources: number;
  records: number;
  files: number;
  root_kind_converted: boolean;
  dropped_external_relations: number;
  dropped_external_relation_values: number;
  dropped_person_values: number;
  dropped_external_page_links: number;
  dropped_external_file_links: number;
  acl_copied: false;
};

function validateTree(
  manifest: PortableArchiveManifest,
  nodes: z.infer<typeof treeNodeSchema>[],
) {
  assert(nodes.length === manifest.counts.resources, 400,
    "Archive resource count mismatch");
  const byId = new Map<string, z.infer<typeof treeNodeSchema>>();
  for (const node of nodes) {
    assert(!byId.has(node.id), 400, "Archive contains duplicate resource IDs");
    byId.set(node.id, node);
  }
  const root = byId.get(manifest.root.source_id);
  assert(root &&
    root.kind === manifest.root.kind &&
    root.title === manifest.root.title,
    400, "Archive root does not match manifest");

  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    assert(!visiting.has(id), 400, "Archive resource hierarchy contains a cycle");
    visiting.add(id);
    const node = byId.get(id)!;
    let depth = 0;
    if (id !== root.id) {
      assert(node.parent_id && byId.has(node.parent_id), 400,
        "Archive resource parent is missing");
      depth = depthOf(node.parent_id) + 1;
    }
    assert(depth < 32, 400, "Archive resource hierarchy is too deep");
    visiting.delete(id);
    depths.set(id, depth);
    return depth;
  };
  for (const node of nodes) depthOf(node.id);
  return {
    root,
    ordered: [...nodes].sort((a, b) =>
      depthOf(a.id) - depthOf(b.id) ||
      a.position - b.position ||
      a.id.localeCompare(b.id)),
  };
}

export async function importPortableArchive(
  q: Query,
  a: Actor,
  destinationId: string,
  archive: Buffer,
  storage: Storage,
  antivirus: Antivirus,
) {
  const destination = await requireAccess(q, a, destinationId, 3);
  const inspected = inspectPortableArchive(archive, { collect: true }),
    { manifest, entries } = inspected;
  const treeBytes = entries.get("tree.json");
  assert(treeBytes, 400, "Archive tree.json is required");
  let treeRaw: unknown;
  try {
    treeRaw = JSON.parse(treeBytes.toString("utf8"));
  } catch {
    assert(false, 400, "Archive tree.json is invalid");
  }
  const nodes = z.array(treeNodeSchema).min(1).max(5_000).parse(treeRaw),
    { root, ordered } = validateTree(manifest, nodes);

  assert(
    root.kind === "workspace"
      ? destination.kind === "workspace"
      : root.kind === "space"
        ? destination.kind === "workspace"
        : ["space", "page"].includes(destination.kind),
    400,
    "Archive root cannot be imported at this destination",
  );

  const documentPaths = manifest.entries
      .map((entry) => entry.path)
      .filter((path) => /^documents\/[0-9a-f-]{36}\.json$/i.test(path)),
    databasePaths = manifest.entries
      .map((entry) => entry.path)
      .filter((path) => /^databases\/[0-9a-f-]{36}\.json$/i.test(path)),
    recordPaths = manifest.entries
      .map((entry) => entry.path)
      .filter((path) => /^records\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.json$/i.test(path));
  assert(documentPaths.length === manifest.counts.documents &&
    databasePaths.length === manifest.counts.databases &&
    recordPaths.length === manifest.counts.records,
    400, "Archive entry counts do not match manifest");

  const documents = new Map<string, z.infer<typeof documentSchema>>();
  for (const path of documentPaths) {
    const doc = parseJsonEntry(entries, path, documentSchema);
    assert(!documents.has(doc.resource_id), 400,
      "Archive contains duplicate documents");
    documents.set(doc.resource_id, doc);
  }
  const databases = new Map<string, z.infer<typeof databaseSchema>>();
  for (const path of databasePaths) {
    const database = parseJsonEntry(entries, path, databaseSchema);
    assert(!databases.has(database.resource_id), 400,
      "Archive contains duplicate databases");
    databases.set(database.resource_id, database);
  }
  const records = new Map<string, z.infer<typeof recordSchema>>();
  for (const path of recordPaths) {
    const record = parseJsonEntry(entries, path, recordSchema);
    assert(!records.has(record.id), 400, "Archive contains duplicate records");
    records.set(record.id, record);
  }

  const fileIndex = manifest.counts.files
    ? parseJsonEntry(entries, "files/index.json", fileIndexSchema)
    : [];
  assert(fileIndex.length === manifest.counts.files, 400,
    "Archive attachment count mismatch");
  const fileIds = new Map<string, string>();
  for (const file of fileIndex) {
    assert(!fileIds.has(file.id), 400, "Archive contains duplicate files");
    assert(entries.has(`files/${file.id}.data`), 400,
      "Archive attachment bytes are missing");
    fileIds.set(file.id, randomUUID());
  }

  const ids = new Map<string, string>(),
    importedProperties = new Map<string, z.infer<typeof properties>>(),
    report: ImportReport = {
      resources: 0,
      records: 0,
      files: 0,
      root_kind_converted: root.kind === "workspace",
      dropped_external_relations: 0,
      dropped_external_relation_values: 0,
      dropped_person_values: 0,
      dropped_external_page_links: 0,
      dropped_external_file_links: 0,
      acl_copied: false,
    };

  // Allocate non-record resource IDs first. Page bodies are applied only
  // after every resource/file identity exists, so raw source UUID links never
  // become indexed target links in the destination.
  for (const node of ordered) {
    if (node.kind === "record") continue;
    const parentId = node.id === root.id
      ? destination.id
      : ids.get(node.parent_id!);
    assert(parentId, 400, "Archive parent mapping is incomplete");
    const kind = node.id === root.id && node.kind === "workspace"
      ? "space"
      : node.kind;
    const created = await createResource(q, a, {
      kind,
      parent_id: parentId,
      title: node.title,
      icon: node.icon,
      blocks: [],
    });
    ids.set(node.id, created.id);
    report.resources += 1;
  }

  // Materialize database schemas/views with only relations whose target
  // database is also inside this archive. Source-tenant UUIDs are never
  // resolved against the destination tenant by coincidence.
  for (const [sourceDatabaseId, exported] of databases) {
    const targetDatabaseId = ids.get(sourceDatabaseId);
    assert(targetDatabaseId, 400, "Archive database is outside resource tree");
    const original = properties.parse(exported.properties),
      remapped = original.flatMap((property) => {
        if (property.type !== "relation") return [structuredClone(property)];
        const target = property.target_database_id
          ? ids.get(property.target_database_id)
          : undefined;
        if (!target) {
          report.dropped_external_relations += 1;
          return [];
        }
        return [{ ...structuredClone(property), target_database_id: target }];
      }),
      relationIds = new Set(remapped
        .filter((property) => property.type === "relation")
        .map((property) => property.id)),
      withoutBrokenRollups = remapped.filter((property) =>
        property.type !== "rollup" ||
        (property.rollup_relation_id &&
          relationIds.has(property.rollup_relation_id)));
    const parsed = properties.parse(withoutBrokenRollups);
    importedProperties.set(sourceDatabaseId, parsed);
    await q.query("UPDATE databases SET properties=$2 WHERE resource_id=$1",
      [targetDatabaseId, json(parsed)]);
    await q.query("DELETE FROM database_views WHERE database_id=$1",
      [targetDatabaseId]);
    const allowed = new Set(parsed.map((property) => property.id));
    for (const sourceView of exported.views) {
      const config = sanitizeView(sourceView.config, allowed);
      await q.query(
        "INSERT INTO database_views(id,tenant_id,database_id,name,config)" +
          " VALUES($1,$2,$3,$4,$5)",
        [randomUUID(), a.tenant_id, targetDatabaseId,
          sourceView.name, json(config)],
      );
    }
    if (!exported.views.length)
      await q.query(
        "INSERT INTO database_views(id,tenant_id,database_id,name,config)" +
          " VALUES($1,$2,$3,'All records',$4)",
        [randomUUID(), a.tenant_id, targetDatabaseId,
          json({ type: "table", filters: [], sort: [] })],
      );
  }

  // Create records without source user IDs or source relation IDs. Relations
  // are filled in a second pass after every imported record has a fresh ID.
  for (const node of ordered) {
    if (node.kind !== "record") continue;
    const exported = records.get(node.id);
    assert(exported && exported.database_id === node.parent_id, 400,
      "Archive record metadata is inconsistent");
    const targetDatabaseId = ids.get(exported.database_id),
      schema = importedProperties.get(exported.database_id);
    assert(targetDatabaseId && schema, 400,
      "Archive record database is unavailable");
    const initial: Record<string, unknown> = {};
    for (const property of schema) {
      if (property.type === "formula" || property.type === "rollup") continue;
      if (property.type === "person") {
        if (exported.values[property.id] != null)
          report.dropped_person_values += 1;
        continue;
      }
      if (property.type === "relation") {
        initial[property.id] = [];
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(exported.values, property.id))
        initial[property.id] = exported.values[property.id];
    }
    const created = await createRecord(q, a, targetDatabaseId, initial);
    ids.set(node.id, created.id);
    await q.query(
      "UPDATE resources SET icon=$2,position=$3 WHERE id=$1",
      [created.id, node.icon, node.position],
    );
    report.resources += 1;
    report.records += 1;
  }
  assert(report.resources === manifest.counts.resources, 400,
    "Archive did not materialize every resource");

  // Second pass: remap relation record IDs. Any source relation ID outside
  // the archive is dropped and reported.
  for (const [sourceRecordId, exported] of records) {
    const targetRecordId = ids.get(sourceRecordId),
      targetDatabaseId = ids.get(exported.database_id),
      schema = importedProperties.get(exported.database_id);
    assert(targetRecordId && targetDatabaseId && schema, 400,
      "Archive record mapping is incomplete");
    const row = await one(q,
      "SELECT values FROM database_records WHERE resource_id=$1 FOR UPDATE",
      [targetRecordId]);
    assert(row, 400, "Imported record is missing");
    const next = { ...row.values };
    for (const property of schema.filter((p) => p.type === "relation")) {
      const sourceValues = Array.isArray(exported.values[property.id])
        ? exported.values[property.id] as unknown[]
        : [];
      const mapped: string[] = [];
      for (const candidate of sourceValues.slice(0, 20)) {
        if (typeof candidate !== "string") continue;
        const target = ids.get(candidate);
        if (target) mapped.push(target);
        else report.dropped_external_relation_values += 1;
      }
      next[property.id] = [...new Set(mapped)];
    }
    const validated = validateValues(schema, next);
    await validateRelationWrites(q, a, schema, validated);
    await q.query(
      "UPDATE database_records SET values=$2,revision=revision+1 WHERE resource_id=$1",
      [targetRecordId, json(validated)],
    );
    const titleProperty = schema.find((p) => p.type === "title")!;
    await q.query(
      "UPDATE resources SET title=$2,search_text=$3,updated_at=now(),updated_by=$4 WHERE id=$1",
      [
        targetRecordId,
        validated[titleProperty.id],
        indexedRecordText(schema, validated),
        a.user_id,
      ],
    );
  }

  // Attachment IDs are allocated before documents so Core file URLs can be
  // rewritten in the same document pass as page links.
  for (const [sourceResourceId, targetResourceId] of ids) {
    const doc = documents.get(sourceResourceId);
    if (!doc) continue;
    const blocks = remapBlocks(
      structuredClone(doc.blocks), ids, fileIds, report) as any[];
    validateBlocks(blocks);
    await q.query(
      "UPDATE page_documents SET blocks=$2,plain_text=$3,y_state=$4," +
        " revision=revision+1 WHERE resource_id=$1",
      [targetResourceId, json(blocks), textOf(blocks), blocksToState(blocks)],
    );
    await q.query(
      "UPDATE resources SET search_text=$2,updated_at=now(),updated_by=$3 WHERE id=$1",
      [targetResourceId, textOf(blocks), a.user_id],
    );
    await syncWorkspaceResourceLinks(
      q, a.tenant_id, targetResourceId, blocks);
  }

  // Validate and malware-scan every blob before the first external storage
  // write. This avoids predictable partial object sets on bad input.
  const preparedFiles: Array<{
    sourceId: string; id: string; resourceId: string; key: string;
    name: string; mime: string; bytes: Buffer;
  }> = [];
  for (const file of fileIndex) {
    const targetResourceId = ids.get(file.resource_id),
      targetFileId = fileIds.get(file.id),
      bytes = entries.get(`files/${file.id}.data`);
    assert(targetResourceId && targetFileId && bytes, 400,
      "Archive attachment mapping is incomplete");
    assert(bytes.length === file.size, 400, "Archive attachment size mismatch");
    const mime = inspectFile(file.name, file.mime, bytes);
    const scan = await antivirus.scan(bytes);
    assert(scan.status === "clean", 422, "Archive attachment rejected by malware scanner");
    preparedFiles.push({
      sourceId: file.id,
      id: targetFileId,
      resourceId: targetResourceId,
      key: `${a.tenant_id}/${targetResourceId}/${targetFileId}`,
      name: file.name.replace(/[\r\n\x00]/g, "").slice(0, 255),
      mime,
      bytes,
    });
  }

  const written: string[] = [];
  try {
    for (const file of preparedFiles) {
      await storage.put(file.key, file.bytes, file.mime);
      written.push(file.key);
      await q.query(
        "INSERT INTO files(id,tenant_id,resource_id,object_key,name,mime,size)" +
          " VALUES($1,$2,$3,$4,$5,$6,$7)",
        [file.id, a.tenant_id, file.resourceId, file.key,
          file.name, file.mime, file.bytes.length],
      );
      report.files += 1;
    }
  } catch (error) {
    for (const key of written)
      await storage.delete(key).catch(() => {});
    throw error;
  }

  const rootId = ids.get(root.id);
  assert(rootId, 400, "Imported root mapping is missing");
  await emit(q, a, "import.completed", rootId);
  return {
    resource_id: rootId,
    report,
    // Internal worker compensation handle. API/job responses must not expose
    // destination object keys.
    stored_object_keys: written,
  };
}
