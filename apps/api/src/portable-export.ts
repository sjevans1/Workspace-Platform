import type { Query } from "../../../packages/database/index.ts";
import type { Actor } from "../../../packages/auth/index.ts";
import { requireAccess } from "../../../packages/permissions/index.ts";
import { HttpError, view } from "../../../packages/contracts/index.ts";
import { records } from "./domain.ts";
import { presentedSchema } from "./rollups.ts";
import {
  buildPortableArchive,
  portableArchiveLimits,
  type PortableArchiveEntry,
} from "../../../packages/portable-archive/index.ts";
import type { Storage } from "../../../packages/storage/index.ts";

// Keep in lockstep with the package version shipped in package.json. The
// manifest records the product that produced the archive; import gates on
// the archive format version, not this informational field.
export const WORKSPACE_PRODUCT_VERSION = "0.1.0";

const PORTABLE_KINDS = ["workspace", "space", "page", "database"];

// The manifest schema caps every count. Enforce the same caps at export
// time so a legitimate oversized tree fails with a bounded HTTP error
// instead of producing an archive that no target can accept.
const maxResources = 5_000,
  maxDocuments = 5_000,
  maxDatabases = 2_000,
  maxRecords = 5_000,
  maxFiles = 2_000;

/**
 * Tenant-safe subtree export. Every resource in the exported subtree must
 * be readable by the acting principal (fail closed): a caller who can only
 * see part of a tree gets an error rather than an archive whose entry list
 * or counts leak hidden siblings. Only portable metadata (kind, title,
 * icon, position), document bodies, database schemas/views, actor-visible
 * record values and attachment bytes enter the archive. ACL rows, tenant
 * identifiers, membership, audit, comments and Yjs states never leave the
 * tenant: import allocates fresh IDs and inherits destination permissions.
 */
export async function exportPortableTree(
  q: Query,
  a: Actor,
  sourceId: string,
  storage: Storage,
) {
  const source = await requireAccess(q, a, sourceId);
  if (!PORTABLE_KINDS.includes(source.kind))
    throw new HttpError(400, "Unsupported export root");

  const rows = (
    await q.query(
      "WITH RECURSIVE tree AS (" +
        " SELECT r.*,0 depth FROM resources r WHERE r.id=$1 AND r.deleted_at IS NULL" +
        " UNION ALL SELECT r.*,tree.depth+1 FROM resources r" +
        " JOIN tree ON r.parent_id=tree.id" +
        " WHERE r.deleted_at IS NULL AND tree.depth<32" +
        ") SELECT * FROM tree ORDER BY depth,position,id LIMIT $2",
      [source.id, maxResources + 1],
    )
  ).rows;
  if (!rows.length) throw new HttpError(404, "Export root not found");
  if (rows.length > maxResources)
    throw new HttpError(413, "Export exceeds the resource limit");
  // Fail closed on partially readable subtrees. This re-check is required
  // even though the recursive query already ran inside tenant RLS: ACL is
  // per resource, not per tenant.
  for (const row of rows) await requireAccess(q, a, row.id);
  const ids = rows.map((row: any) => row.id as string);

  const tree = rows.map((row: any) => ({
    id: row.id,
    parent_id: row.parent_id,
    kind: row.kind,
    title: row.title,
    icon: row.icon,
    position: row.position,
  }));
  const idSet = new Set(ids);

  const documents = (
    await q.query(
      "SELECT resource_id,blocks,plain_text,revision FROM page_documents" +
        " WHERE resource_id=ANY($1::uuid[])",
      [ids],
    )
  ).rows;
  const databases = (
    await q.query(
      "SELECT resource_id,properties FROM databases WHERE resource_id=ANY($1::uuid[])",
      [ids],
    )
  ).rows;
  const views = (
    await q.query(
      "SELECT v.id,v.database_id,v.name,v.config FROM database_views v" +
        " WHERE v.database_id=ANY($1::uuid[]) ORDER BY v.id",
      [ids],
    )
  ).rows;

  const databaseRecords: any[] = [],
    portableSchemas = new Map<string, any[]>();
  for (const row of databases) {
    // Apply the same schema-level ACL redaction as the normal API. A relation
    // or rollup whose target is not readable must not leak that target UUID or
    // field metadata into a portable archive.
    const actorSchema = await presentedSchema(q, a, row.properties),
      portableSchema = actorSchema
        .filter((property: any) => property.target_unavailable !== true)
        .map((property: any) => {
          const { target_unavailable: _redacted, ...portable } = property;
          return portable;
        });
    portableSchemas.set(row.resource_id, portableSchema);

    // records() re-verifies access on the database and returns only the
    // actor-visible presented values; never export raw stored record
    // values, because formula/relation redaction is permission-aware.
    const presented = await records(
      q,
      a,
      row.resource_id,
      view.parse({ type: "table" }),
      0,
      maxRecords + 1,
    );
    if (presented.length > maxRecords)
      throw new HttpError(413, "Export exceeds the record limit");
    const portablePropertyIds = new Set(
      portableSchema
        .filter((property: any) =>
          !["person", "formula", "rollup"].includes(property.type))
        .map((property: any) => property.id),
    );
    for (const rec of presented)
      databaseRecords.push({
        id: rec.id,
        database_id: row.resource_id,
        title: rec.title,
        icon: rec.icon,
        position: rec.position,
        values: Object.fromEntries(
          Object.entries(rec.values)
            .filter(([propertyId]) => portablePropertyIds.has(propertyId)),
        ),
        revision: rec.revision,
      });
  }

  const files = (
    await q.query(
      "SELECT id,resource_id,object_key,name,mime,size FROM files" +
        " WHERE resource_id=ANY($1::uuid[]) AND deleted_at IS NULL ORDER BY id",
      [ids],
    )
  ).rows;
  if (files.length > maxFiles)
    throw new HttpError(413, "Export exceeds the attachment limit");

  const entries: PortableArchiveEntry[] = [
    { path: "tree.json", data: JSON.stringify(tree, null, 2) },
    ...documents.map((d: any) => ({
      path: `documents/${d.resource_id}.json`,
      data: JSON.stringify(
        {
          resource_id: d.resource_id,
          blocks: d.blocks,
          plain_text: d.plain_text,
          revision: d.revision,
        },
        null,
        2,
      ),
    })),
    ...databases.map((d: any) => ({
      path: `databases/${d.resource_id}.json`,
      data: JSON.stringify(
        {
          resource_id: d.resource_id,
          properties: portableSchemas.get(d.resource_id) || [],
          views: views
            .filter((v: any) => v.database_id === d.resource_id)
            .map((v: any) => ({ id: v.id, name: v.name, config: v.config })),
        },
        null,
        2,
      ),
    })),
    ...databaseRecords.map((rec) => ({
      path: `records/${rec.database_id}/${rec.id}.json`,
      data: JSON.stringify(rec, null, 2),
    })),
  ];

  const fileMeta: any[] = [];
  for (const f of files) {
    const bytes = await storage.get(f.object_key);
    // Attachment bytes must match the cataloged size exactly and fit one
    // archive entry; the archive builder re-verifies both independently.
    if (bytes.length !== Number(f.size))
      throw new HttpError(409, "Stored attachment size mismatch");
    if (bytes.length > portableArchiveLimits.maxEntryBytes)
      throw new HttpError(413, "Attachment exceeds the archive entry limit");
    fileMeta.push({
      id: f.id,
      resource_id: f.resource_id,
      name: f.name,
      mime: f.mime,
      size: Number(f.size),
    });
    entries.push({ path: `files/${f.id}.data`, data: bytes, store: true });
  }
  if (fileMeta.length)
    entries.push({
      path: "files/index.json",
      data: JSON.stringify(fileMeta, null, 2),
    });

  // Belt and braces: every non-root node must reference a parent that
  // stays inside the exported subtree, so a forged row can never point
  // the archive outside itself. The root may legitimately hang under an
  // unexported ancestor.
  for (const node of tree)
    if (node.parent_id && node.id !== source.id && !idSet.has(node.parent_id))
      throw new HttpError(409, "Subtree references an unexported parent");

  const entryCount = entries.length;
  if (entryCount > portableArchiveLimits.maxEntries)
    throw new HttpError(413, "Export exceeds the archive entry limit");

  const archive = buildPortableArchive(
    {
      format: "workspace-portable-archive" as const,
      version: 1 as const,
      exported_at: new Date().toISOString(),
      product_version: WORKSPACE_PRODUCT_VERSION,
      root: {
        source_id: source.id,
        kind: source.kind as "workspace" | "space" | "page" | "database",
        title: source.title,
      },
      counts: {
        resources: rows.length,
        documents: documents.length,
        databases: databases.length,
        records: databaseRecords.length,
        files: files.length,
      },
    },
    entries,
  );
  if (archive.length > portableArchiveLimits.maxArchiveBytes)
    throw new HttpError(413, "Export exceeds the archive size limit");
  return archive;
}
