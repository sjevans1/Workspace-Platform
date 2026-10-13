/**
 * W30-A: workflow trigger vocabulary and matching.
 *
 * A trigger is the only way a workflow starts. Keeping the workspace event
 * vocabulary as an explicit allowlist (drawn from the event_outbox types the
 * product already emits) means a workflow can never subscribe to an event the
 * deployment does not actually produce, and the UI can describe every option
 * honestly instead of offering a free-text event type.
 */
import type { WorkflowTrigger } from "./dsl.ts";

export const TRIGGER_TYPES = [
  "manual",
  "schedule",
  "workspace_event",
  "connector_event",
] as const;

/**
 * The workspace event types a trigger may subscribe to. These are exactly the
 * platform events the rest of Workspace already writes to `event_outbox`; a new
 * product event must be added here deliberately before a workflow can react to it.
 */
export const WORKSPACE_EVENT_TYPES: string[] = [
  "comment.created",
  "comment.deleted",
  "comment.updated",
  "database.updated",
  "export.performed",
  "file.created",
  "file.deleted",
  "file.malware_blocked",
  "import.completed",
  "notification.created",
  "page.updated",
  "permission.updated",
  "record.updated",
];

/**
 * A pattern is either an exact event type or a `family.*` prefix form, so an author
 * can subscribe to `comment.*` without enumerating every comment event.
 *
 * The `workflow.` namespace is deliberately unreachable here. A workflow action can
 * emit a signed outbound webhook event, and if such an event could trigger another
 * workspace event workflow there would be no natural ceiling on the resulting
 * chain; excluding the namespace is the deterministic loop bound.
 */
export function eventTypeMatches(pattern: string, type: string): boolean {
  if (type.startsWith("workflow.")) return false;
  if (pattern === type) return true;
  if (!pattern.endsWith(".*")) return false;
  return type.startsWith(pattern.slice(0, -1));
}

/** True when a pattern can ever match an event this product actually emits. */
export function isWorkspaceEventPattern(pattern: string): boolean {
  return WORKSPACE_EVENT_TYPES.some((type) => eventTypeMatches(pattern, type));
}

export function triggerCatalog(): {
  type: string;
  label: string;
  summary: string;
}[] {
  return [
    {
      type: "manual",
      label: "Manual",
      summary: "Runs only when a member triggers it",
    },
    {
      type: "schedule",
      label: "Schedule",
      summary:
        "Runs on a one-time, interval or cron schedule in a chosen timezone",
    },
    {
      type: "workspace_event",
      label: "Workspace event",
      summary: "Runs when a selected Workspace event is emitted",
    },
    {
      type: "connector_event",
      label: "Connector event",
      summary: "Runs when a connected provider delivers a selected event type",
    },
  ];
}

export type TriggerInput =
  | {
      type: "connector_event";
      event_type: string;
      provider_key: string;
      connection_id: string;
    }
  | { type: "workspace_event"; event_type: string };

/** True when the trigger subscribes to this concrete event. Filters narrow, never widen. */
export function triggerMatches(
  trigger: WorkflowTrigger,
  input: TriggerInput,
): boolean {
  if (input.type === "connector_event") {
    if (trigger.type !== "connector_event") return false;
    if (!trigger.event_types.includes(input.event_type)) return false;
    if (
      trigger.provider_keys &&
      trigger.provider_keys.length > 0 &&
      !trigger.provider_keys.includes(input.provider_key)
    )
      return false;
    if (
      trigger.connection_ids &&
      trigger.connection_ids.length > 0 &&
      !trigger.connection_ids.includes(input.connection_id)
    )
      return false;
    return true;
  }
  if (trigger.type !== "workspace_event") return false;
  return trigger.event_types.some((pattern) =>
    eventTypeMatches(pattern, input.event_type),
  );
}
