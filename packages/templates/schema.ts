// Wave X X2.5 (W25-T): curated template schema and validation.
//
// Templates compose only capabilities Workspace already supports. They are
// deterministic, versioned and immutable for a given version, and they reference
// internal resources symbolically (e.g. "resources.projects",
// "properties.project_owner", "records.example_client") - never raw UUIDs or
// tenant IDs.

export type TemplateLevel = "page" | "database" | "space";

export const TEMPLATE_CATEGORIES = [
  "Projects & Delivery",
  "Meetings",
  "Operations",
  "Sales & CRM",
  "HR & People",
  "Management",
  "Finance",
  "Knowledge",
  "Risk & Compliance",
  "Personal Productivity",
] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export type TemplateProperty = {
  id: string;
  name: string;
  type:
    | "title"
    | "text"
    | "number"
    | "date"
    | "checkbox"
    | "select"
    | "status"
    | "multi_select"
    | "person"
    | "relation";
  options?: string[];
  /** For relation properties: symbolic key of the target database. */
  target?: string;
};

export type TemplateView = { name: string; config: Record<string, unknown> };

export type TemplateRecord = {
  /** Symbolic record key, referenced by other records via `refs`. */
  key: string;
  values: Record<string, unknown>;
  /** Symbolic references to other record keys, resolved on instantiation. */
  refs?: Record<string, string[]>;
};

export type TemplateResource = {
  /** Symbolic key, unique within the template. */
  key: string;
  kind: TemplateLevel;
  title: string;
  icon?: string;
  blocks?: any[];
  properties?: TemplateProperty[];
  views?: TemplateView[];
  records?: TemplateRecord[];
  children?: TemplateResource[];
};

export type TemplateDefinition = {
  id: string;
  version: number;
  level: TemplateLevel;
  category: TemplateCategory;
  title: string;
  description: string;
  icon: string;
  /** The root resource this template creates. */
  resource: TemplateResource;
};

const RAW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SYMBOLIC = /^(resources|properties|records)\.[A-Za-z0-9_]+$/;
const CHANGE_EVENT = "$workspace-changed";

function walk(
  resource: TemplateResource,
  visit: (r: TemplateResource) => void,
): void {
  visit(resource);
  for (const child of resource.children || []) walk(child, visit);
}

/**
 * Validate the whole catalog. Returns a list of problems; empty means valid.
 * Deterministic: the same catalog always yields the same result and ordering.
 */
export function validateCatalog(
  definitions: TemplateDefinition[],
): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();

  for (const def of definitions) {
    const at = `template ${def.id}: `;
    if (ids.has(def.id)) problems.push(`${at}duplicate template id`);
    ids.add(def.id);
    if (!Number.isInteger(def.version) || def.version < 1)
      problems.push(`${at}version must be a positive integer`);
    if (!TEMPLATE_CATEGORIES.includes(def.category))
      problems.push(`${at}unknown category`);
    if (def.resource.kind !== def.level)
      problems.push(`${at}root resource kind must equal template level`);
    if (!def.title.trim() || !def.description.trim())
      problems.push(`${at}title and description are required`);

    const resourceKeys = new Set<string>();
    const recordKeys = new Set<string>();
    walk(def.resource, (r) => {
      if (resourceKeys.has(r.key))
        problems.push(`${at}duplicate resource key ${r.key}`);
      resourceKeys.add(r.key);
      if (RAW_ID.test(r.key))
        problems.push(`${at}raw internal id used as a resource key`);
      const propertyIds = new Set<string>();
      for (const property of r.properties || []) {
        if (propertyIds.has(property.id))
          problems.push(`${at}duplicate property id ${property.id} in ${r.key}`);
        propertyIds.add(property.id);
        if (RAW_ID.test(property.id))
          problems.push(`${at}raw internal id used as a property id`);
        if (property.type === "relation" && !property.target)
          problems.push(`${at}relation ${property.id} has no target`);
        if (property.target && !SYMBOLIC.test(property.target))
          problems.push(
            `${at}relation target ${property.target} must be symbolic`,
          );
      }
      for (const record of r.records || []) {
        if (recordKeys.has(record.key))
          problems.push(`${at}duplicate record key ${record.key}`);
        recordKeys.add(record.key);
        if (RAW_ID.test(record.key))
          problems.push(`${at}raw internal id used as a record key`);
        for (const values of Object.values(record.refs || {}))
          for (const ref of values)
            if (!SYMBOLIC.test(ref) && !/^resources\.|^records\./.test(ref))
              problems.push(`${at}record reference ${ref} must be symbolic`);
      }
      for (const view of r.views || []) {
        if (!["table", "board", "calendar"].includes(String(view.config?.type)))
          problems.push(`${at}view ${view.name} has an unsupported type`);
      }
    });
  }

  // Symbolic targets and record references must resolve inside the template.
  for (const def of definitions) {
    const resourceKeys = new Set<string>();
    const recordKeys = new Set<string>();
    walk(def.resource, (r) => {
      resourceKeys.add(r.key);
      for (const record of r.records || []) recordKeys.add(record.key);
    });
    walk(def.resource, (r) => {
      for (const property of r.properties || [])
        if (property.target && !resourceKeys.has(property.target.replace("resources.", "")))
          problems.push(
            `template ${def.id}: relation target ${property.target} does not resolve`,
          );
      for (const record of r.records || [])
        for (const [property, refs] of Object.entries(record.refs || {}))
          for (const ref of refs)
            if (!recordKeys.has(ref.replace("records.", "")))
              problems.push(
                `template ${def.id}: ${record.key}.${property} references unknown record ${ref}`,
              );
    });
  }

  if (JSON.stringify(definitions).includes(CHANGE_EVENT))
    problems.push("catalog must not embed workspace change events");

  return problems.sort();
}
