// Wave X X2.5 (W25-T): safe template instantiation.
//
// One logical operation: allocate fresh tenant-local ids for every resource,
// build a symbolic-key -> generated-id map, resolve/remap internal references
// through it, and roll the whole invocation back if anything fails. Templates
// only compose capabilities Workspace already supports and every write goes
// through the same authorization- and validation-checked domain functions.
import { randomUUID } from "node:crypto";
import type { Query } from "../../../packages/database/index.ts";
import type { Actor } from "../../../packages/auth/index.ts";
import { assert, json } from "../../../packages/contracts/index.ts";
import type {
  TemplateDefinition,
  TemplateResource,
} from "../../../packages/templates/schema.ts";
import { createRecord, createResource } from "./domain.ts";

const SAVEPOINT = "template_instantiate";

const symbolKey = (reference: string) =>
  reference.replace(/^(resources|records)\./, "");

function resourcesDepthFirst(root: TemplateResource): TemplateResource[] {
  const out: TemplateResource[] = [];
  const walk = (r: TemplateResource) => {
    out.push(r);
    for (const child of r.children || []) walk(child);
  };
  walk(root);
  return out;
}

/**
 * Instantiate a template into the actor's current tenant under `parentId`.
 * Atomic: a failure anywhere rolls back every resource this call created.
 */
export async function instantiateTemplate(
  q: Query,
  a: Actor,
  def: TemplateDefinition,
  parentId: string,
  rootTitle?: string,
) {
  const resourceIds = new Map<string, string>();
  const recordIds = new Map<string, string>();
  await q.query(`SAVEPOINT ${SAVEPOINT}`);
  try {
    const nodes = resourcesDepthFirst(def.resource);
    let root: any;

    // Pass 1: create every resource so all ids exist before references resolve.
    for (const node of nodes) {
      const created = await createResource(q, a, {
        kind: node.kind,
        title:
          node.key === def.resource.key && rootTitle ? rootTitle : node.title,
        // The template root goes under the caller's parent; every other node
        // goes under the resource created for its symbolic parent key.
        parent_id:
          node.key === def.resource.key
            ? parentId
            : resourceIds.get(parentKey(node, nodes))!,
        icon: node.icon,
        blocks: node.blocks || [],
      });
      if (node.key === def.resource.key) root = created;
      resourceIds.set(node.key, created.id);
    }

    // Pass 2: properties, views and records, with references remapped.
    for (const node of nodes) {
      if (node.kind !== "database") continue;
      const databaseId = resourceIds.get(node.key)!;
      const properties = (node.properties || [
        { id: "name", name: "Name", type: "title" },
      ]).map((property) => {
        if (property.type !== "relation" || !property.target) return property;
        const targetId = resourceIds.get(symbolKey(property.target));
        assert(
          targetId,
          500,
          `Relation target ${property.target} was not created`,
        );
        return {
          id: property.id,
          name: property.name,
          type: property.type,
          target_database_id: targetId,
        };
      });
      await q.query("UPDATE databases SET properties=$2 WHERE resource_id=$1", [
        databaseId,
        json(properties),
      ]);
      // Replace the creation-time default views with the template's own.
      await q.query("DELETE FROM database_views WHERE database_id=$1", [
        databaseId,
      ]);
      const views = node.views?.length
        ? node.views
        : [{ name: "All records", config: { type: "table", filters: [], sort: [] } }];
      for (const view of views)
        await q.query(
          "INSERT INTO database_views(id,tenant_id,database_id,name,config) VALUES($1,$2,$3,$4,$5)",
          [randomUUID(), a.tenant_id, databaseId, view.name, json(view.config)],
        );

      for (const record of node.records || []) {
        const values: Record<string, any> = { ...record.values };
        for (const [property, refs] of Object.entries(record.refs || {})) {
          const ids = refs.map((ref) => {
            const id = recordIds.get(symbolKey(ref));
            assert(id, 500, `Record reference ${ref} was not created`);
            return id;
          });
          values[property] = ids;
        }
        const created = await createRecord(q, a, databaseId, values);
        recordIds.set(record.key, created.id);
      }
    }

    await q.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    return root;
  } catch (error) {
    await q.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
    throw error;
  }
}

/** Parent key for a node: the nearest ancestor key in the definition. */
function parentKey(node: TemplateResource, nodes: TemplateResource[]): string {
  const parent = nodes.find((candidate) =>
    (candidate.children || []).some((child) => child.key === node.key),
  );
  return parent ? parent.key : "";
}
