import { randomUUID } from "node:crypto";
import type { Query } from "../../../packages/database/index.ts";
import { one } from "../../../packages/database/index.ts";
import type { Actor } from "../../../packages/auth/index.ts";
import { admin } from "../../../packages/auth/index.ts";
import {
  requireAccess,
  ancestry,
  visible,
} from "../../../packages/permissions/index.ts";
import {
  assert,
  json,
  textOf,
  validateValues,
  taskProperties,
  type Property,
  view,
} from "../../../packages/contracts/index.ts";
import {
  blocksToState,
  validateBlocks,
} from "../../../packages/editor/server.ts";
import { emit } from "../../../packages/events/index.ts";
export const treeLock = (q: Query, t: string) =>
  q.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`tree:${t}`]);
export async function createResource(
  q: Query,
  a: Actor,
  v: {
    kind: string;
    title: string;
    parent_id?: string | null;
    icon?: string;
    blocks?: any[];
    tasks?: boolean;
  },
) {
  await treeLock(q, a.tenant_id);
  if (v.kind === "workspace") {
    admin(a);
    assert(!v.parent_id, 400, "Workspace is a root");
  } else {
    assert(v.parent_id, 400, "Parent required");
    const p = await requireAccess(q, a, v.parent_id, 3);
    const allowed: Record<string, string[]> = {
      space: ["workspace"],
      page: ["space", "page"],
      database: ["space", "page"],
      record: ["database"],
    };
    assert(allowed[v.kind]?.includes(p.kind), 400, "Invalid parent");
    assert((await ancestry(q, p.id)).length < 32, 400, "Nesting limit reached");
  }
  const id = randomUUID(),
    blocks = v.blocks || [];
  await q.query(
    "INSERT INTO resources(id,tenant_id,parent_id,kind,title,icon,created_by,updated_by,search_text,position) VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,(SELECT coalesce(max(position),0)+1 FROM resources WHERE parent_id IS NOT DISTINCT FROM $3::uuid))",
    [
      id,
      a.tenant_id,
      v.parent_id || null,
      v.kind,
      v.title,
      v.icon || "",
      a.user_id,
      textOf(blocks),
    ],
  );
  if (["page", "record"].includes(v.kind))
    await q.query(
      "INSERT INTO page_documents(tenant_id,resource_id,blocks,plain_text,y_state) VALUES($1,$2,$3,$4,$5)",
      [a.tenant_id, id, json(blocks), textOf(blocks), blocksToState(blocks)],
    );
  if (v.kind === "database") {
    await q.query(
      "INSERT INTO databases(tenant_id,resource_id,properties) VALUES($1,$2,$3)",
      [
        a.tenant_id,
        id,
        json(
          v.tasks
            ? taskProperties
            : [{ id: "name", name: "Name", type: "title" }],
        ),
      ],
    );
    await q.query(
      "INSERT INTO database_views(id,tenant_id,database_id,name,config) VALUES($1,$2,$3,$4,$5)",
      [
        randomUUID(),
        a.tenant_id,
        id,
        "All records",
        json({ type: "table", filters: [], sort: [] }),
      ],
    );
    if (v.tasks)
      await q.query(
        "INSERT INTO database_views(id,tenant_id,database_id,name,config) VALUES($1,$2,$3,$4,$5)",
        [
          randomUUID(),
          a.tenant_id,
          id,
          "By status",
          json({ type: "board", groupBy: "status", filters: [], sort: [] }),
        ],
      );
  }
  await emit(q, a, `${v.kind}.created`, id);
  return one(q, "SELECT * FROM resources WHERE id=$1", [id]);
}
export async function purgeDeletedResource(
  q: Query,
  tenantId: string,
  resourceId: string,
  actor?: Pick<Actor, "user_id" | "requestId">,
) {
  await treeLock(q, tenantId);
  const root = await one(
    q,
    "SELECT id,kind,deleted_at FROM resources WHERE id=$1 FOR UPDATE",
    [resourceId],
  );
  assert(root?.deleted_at, 404, "Trashed resource not found");

  const subtree = (
    await q.query(
      "WITH RECURSIVE tree AS(SELECT id,kind,0 depth FROM resources WHERE id=$1 UNION ALL SELECT r.id,r.kind,t.depth+1 FROM resources r JOIN tree t ON r.parent_id=t.id) SELECT * FROM tree ORDER BY depth DESC,id",
      [resourceId],
    )
  ).rows;
  const ids = subtree.map((row: any) => row.id);
  const files = (
    await q.query(
      "SELECT object_key FROM files WHERE resource_id=ANY($1::uuid[])",
      [ids],
    )
  ).rows;

  for (const file of files)
    await q.query(
      "INSERT INTO object_deletions(id,tenant_id,object_key,reason) VALUES($1,$2,$3,'resource_purge') ON CONFLICT(tenant_id,object_key) DO NOTHING",
      [randomUUID(), tenantId, file.object_key],
    );

  await q.query("DELETE FROM notifications WHERE resource_id=ANY($1::uuid[])", [
    ids,
  ]);
  await q.query("DELETE FROM bookmarks WHERE resource_id=ANY($1::uuid[])", [ids]);

  for (const row of subtree)
    await q.query("DELETE FROM resources WHERE id=$1", [row.id]);

  if (actor) {
    await q.query(
      "INSERT INTO audit_events(id,tenant_id,actor_id,action,resource_id,request_id) VALUES($1,$2,$3,'resource.purged',$4,$5)",
      [
        randomUUID(),
        tenantId,
        actor.user_id,
        resourceId,
        actor.requestId || null,
      ],
    );
  } else {
    await q.query(
      "INSERT INTO audit_events(id,tenant_id,actor_id,action,resource_id) VALUES($1,$2,NULL,'retention.resource_purged',$3)",
      [randomUUID(), tenantId, resourceId],
    );
  }
  return { resources: subtree.length, objects: files.length };
}

export async function validatePeople(q: Query, props: Property[], values: any) {
  for (const p of props.filter((p) => p.type === "person"))
    if (values[p.id])
      assert(
        await one(q, "SELECT 1 FROM memberships WHERE user_id=$1 AND active", [
          values[p.id],
        ]),
        400,
        "Person must be an active organisation member",
      );
}
export async function createRecord(
  q: Query,
  a: Actor,
  id: string,
  values: any,
) {
  await requireAccess(q, a, id, 3);
  const d = await one(
    q,
    "SELECT properties FROM databases WHERE resource_id=$1 FOR UPDATE",
    [id],
  );
  assert(d, 404, "Database not found");
  const v = validateValues(d.properties, values);
  await validatePeople(q, d.properties, v);
  const node = await createResource(q, a, {
    kind: "record",
    parent_id: id,
    title: v[d.properties.find((p: Property) => p.type === "title").id],
  });
  await q.query(
    "INSERT INTO database_records(tenant_id,resource_id,database_id,values) VALUES($1,$2,$3,$4)",
    [a.tenant_id, node.id, id, json(v)],
  );
  await q.query("UPDATE resources SET search_text=$2 WHERE id=$1", [
    node.id,
    Object.values(v).join(" "),
  ]);
  return { ...node, values: v, revision: 1 };
}
export async function records(
  q: Query,
  a: Actor,
  id: string,
  config: any,
  offset = 0,
  limit = 100,
) {
  await requireAccess(q, a, id);
  const d = await one(
    q,
    "SELECT properties FROM databases WHERE resource_id=$1",
    [id],
  );
  assert(d, 404, "Database not found");
  const p: any[] = [id],
    where = ["r.parent_id=$1", "r.deleted_at IS NULL"];
  for (const f of config.filters) {
    p.push(f.property);
    let key = `v.values->>$${p.length}`;
    if (f.op === "empty") {
      where.push(`(${key} IS NULL OR ${key}='')`);
      continue;
    }
    const numeric =
      d.properties.find((x: Property) => x.id === f.property)?.type ===
        "number" && f.op !== "contains";
    if (numeric) {
      assert(
        (typeof f.value === "number" ||
          (typeof f.value === "string" && f.value.trim() !== "")) &&
          Number.isFinite(Number(f.value)),
        400,
        "Numeric filter requires a finite number",
      );
      key = `(${key})::numeric`;
    }
    p.push(numeric ? Number(f.value) : String(f.value ?? ""));
    const value = `$${p.length}`;
    where.push(
      f.op === "contains"
        ? `position(lower(${value}) in lower(coalesce(${key},'')))>0`
        : `${key}${f.op === "eq" ? "=" : f.op === "before" ? "<" : ">"}${value}`,
    );
  }
  const sort = config.sort.map((s: any) => {
    p.push(s.property);
    let key = `v.values->>$${p.length}`;
    if (d.properties.find((x: any) => x.id === s.property)?.type === "number")
      key = `(${key})::numeric`;
    return `${key} ${s.direction === "desc" ? "DESC" : "ASC"} NULLS LAST`;
  });
  p.push(limit, offset);
  return visible(
    q,
    a,
    (
      await q.query(
        `SELECT r.*,v.values,v.revision FROM resources r JOIN database_records v ON v.resource_id=r.id WHERE ${where.join(" AND ")} ORDER BY ${sort.length ? sort.join(",") + "," : ""}r.position,r.id LIMIT $${p.length - 1} OFFSET $${p.length}`,
        p,
      )
    ).rows,
  );
}
export async function replaceDocument(
  q: Query,
  a: Actor,
  id: string,
  blocks: any[],
  revision: number,
  context: string,
) {
  validateBlocks(blocks);
  const d = await one(
    q,
    "SELECT * FROM page_documents WHERE resource_id=$1 FOR UPDATE",
    [id],
  );
  assert(d, 404, "Page not found");
  assert(
    d.revision === revision,
    409,
    "Page changed; reload before replacing content",
  );
  await q.query(
    "INSERT INTO page_versions(id,tenant_id,resource_id,blocks,y_state,revision,author_id,context) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      randomUUID(),
      a.tenant_id,
      id,
      json(d.blocks),
      d.y_state,
      d.revision,
      a.user_id,
      context,
    ],
  );
  await q.query(
    "UPDATE page_documents SET blocks=$2,plain_text=$3,y_state=$4,revision=revision+1,epoch=epoch+1 WHERE resource_id=$1",
    [id, json(blocks), textOf(blocks), blocksToState(blocks)],
  );
  await q.query(
    "UPDATE resources SET search_text=$2,updated_by=$3,updated_at=now() WHERE id=$1",
    [id, textOf(blocks), a.user_id],
  );
  await emit(q, a, "page.updated", id, d.revision + 1);
  return { revision: d.revision + 1, epoch: d.epoch + 1 };
}
export async function seedDemo(q: Query, a: Actor, w: string) {
  const wiki = await createResource(q, a, {
    kind: "space",
    title: "Company Wiki",
    parent_id: w,
    icon: "📖",
  });
  await createResource(q, a, {
    kind: "page",
    title: "Welcome to your workspace",
    parent_id: wiki.id,
    icon: "🌿",
    blocks: [
      {
        type: "heading",
        props: { level: 2 },
        content: "Good work starts with shared context.",
      },
      {
        type: "paragraph",
        content:
          "Bring your knowledge, projects and decisions together. Your workspace runs on your own infrastructure.",
      },
      { type: "heading", props: { level: 2 }, content: "Make it yours" },
      { type: "checkListItem", content: "Invite your team in Settings" },
      { type: "checkListItem", content: "Create a page or a project tracker" },
      { type: "checkListItem", content: "Update your organisation’s branding" },
    ],
  });
  const projects = await createResource(q, a, {
    kind: "space",
    title: "Projects",
    parent_id: w,
    icon: "◈",
  });
  for (const title of ["AI Transformation", "ERP Implementation"])
    await createResource(q, a, {
      kind: "page",
      title,
      parent_id: projects.id,
      blocks: [
        {
          type: "paragraph",
          content: "Capture delivery milestones, owners and decisions.",
        },
      ],
    });
  const meetings = await createResource(q, a, {
    kind: "space",
    title: "Meetings",
    parent_id: w,
    icon: "☷",
  });
  await createResource(q, a, {
    kind: "page",
    title: "Weekly Leadership Meeting",
    parent_id: meetings.id,
    blocks: [
      {
        type: "heading",
        props: { level: 2 },
        content: "This week’s priorities",
      },
    ],
  });
  const tasks = await createResource(q, a, {
    kind: "database",
    title: "Team tasks",
    parent_id: projects.id,
    tasks: true,
    icon: "☑",
  });
  for (const [name, status] of [
    ["Map the current workflow", "In progress"],
    ["Publish the project brief", "Done"],
    ["Agree the next milestone", "Not started"],
  ])
    await createRecord(q, a, tasks.id, {
      name,
      status,
      priority: "High",
      assignee: a.user_id,
    });
}
