// Wave X X2.5 (W25-T): template catalog registry.
//
// A single validated registry backs both the API metadata and instantiation.
// The catalog is validated at module load so a malformed built-in definition
// can never be registered or used.
import { catalog } from "./catalog.ts";
import {
  validateCatalog,
  TEMPLATE_CATEGORIES,
  type TemplateDefinition,
} from "./schema.ts";

export { TEMPLATE_CATEGORIES };
export type { TemplateDefinition };
export { catalog };

const problems = validateCatalog(catalog);
if (problems.length)
  throw new Error(
    `Built-in template catalog is invalid:\n${problems.join("\n")}`,
  );

export const templatesById: Record<string, TemplateDefinition> = Object.fromEntries(
  catalog.map((definition) => [definition.id, definition]),
);

export function getTemplate(id: string): TemplateDefinition | undefined {
  return templatesById[id];
}

/** Deterministic catalog metadata for the API and UI. */
export function templateSummaries() {
  return catalog
    .map(({ id, title, description, icon, level, category, version }) => ({
      id,
      title,
      description,
      icon,
      kind: level,
      level,
      category,
      version,
    }))
    .sort((a, b) =>
      a.category === b.category
        ? a.title.localeCompare(b.title)
        : a.category.localeCompare(b.category),
    );
}
