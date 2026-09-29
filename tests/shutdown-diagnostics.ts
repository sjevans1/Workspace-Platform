import { createHook } from "node:async_hooks";

// Opt-in lifecycle diagnostics: identify handles without forcing test exit.
const handles = new Map<
  number,
  { type: string; ref: WeakRef<any>; stack: string }
>();
const enabled = process.env.TEST_SHUTDOWN_DIAGNOSTICS === "true";
const hook = createHook({
  init(id, type, _trigger, resource) {
    if (["Timeout", "TCPWRAP", "TCPSERVERWRAP"].includes(type))
      handles.set(id, {
        type,
        ref: new WeakRef(resource),
        stack: new Error().stack || "",
      });
  },
  destroy(id) {
    handles.delete(id);
  },
});
if (enabled) hook.enable();

export function shutdownDiagnostics() {
  if (enabled) console.log("Integration cleanup started");
  return () => {
    if (!enabled) return;
    console.log(
      "Integration cleanup completed",
      process.getActiveResourcesInfo(),
    );
    setTimeout(() => {
      hook.disable();
      for (const h of handles.values()) {
        const resource = h.ref.deref();
        if (resource?.hasRef?.())
          console.log("Remaining handle", h.type, h.stack);
      }
    }, 2000).unref();
  };
}
