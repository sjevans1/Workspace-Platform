/**
 * W30-A: deterministic automation runtime.
 *
 * Importing this module is enough to run workflows: it registers the standard
 * action set and re-exports the DSL, condition, schedule, trigger and engine
 * surfaces. There is no model call, no `eval`, no shell and no arbitrary code
 * anywhere in the package.
 */
import { STANDARD_ACTION_DEFINITIONS, registerAction } from "./actions.ts";

for (const definition of STANDARD_ACTION_DEFINITIONS)
  registerAction(definition);

export * from "./dsl.ts";
export * from "./conditions.ts";
export * from "./schedule.ts";
export * from "./triggers.ts";
export * from "./actions.ts";
export * from "./effects.ts";
export * from "./engine.ts";
