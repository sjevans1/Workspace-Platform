let csrf = "";
export function setCsrf(v: string) {
  csrf = v;
}
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterSeconds: number | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api(path: string, method = "GET", data?: any) {
  const r = await fetch(`/api/v1${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      ...(data !== undefined && !(data instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...(!["GET", "HEAD"].includes(method) ? { "X-CSRF-Token": csrf } : {}),
    },
    ...(data !== undefined
      ? { body: data instanceof FormData ? data : JSON.stringify(data) }
      : {}),
  });
  const value = await r.json().catch(() => ({}));
  if (!r.ok) {
    const retry = r.headers.get("Retry-After");
    const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : null;
    throw new ApiError(
      typeof value?.error === "string" ? value.error : "Request failed",
      r.status,
      seconds,
    );
  }
  return value;
}
async function apiError(response: Response) {
  const value = await response.clone().json().catch(() => ({}));
  const retry = response.headers.get("Retry-After");
  const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : null;
  return new ApiError(
    typeof value?.error === "string" ? value.error : "Request failed",
    response.status,
    seconds,
  );
}

export async function uploadWorkspaceArchive(
  path: string,
  archive: Blob,
) {
  const response = await fetch(`/api/v1${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/zip",
      "X-CSRF-Token": csrf,
    },
    body: archive,
  });
  if (!response.ok) throw await apiError(response);
  return response.json();
}

export async function downloadWorkspaceArchive(path: string) {
  const response = await fetch(`/api/v1${path}`, {
    method: "GET",
    credentials: "same-origin",
  });
  if (!response.ok) throw await apiError(response);
  return response.blob();
}

export function notify(message: string) {
  window.dispatchEvent(
    new CustomEvent("workspace-notice", { detail: message }),
  );
}
export async function run(fn: () => Promise<any>) {
  try {
    await fn();
  } catch (e) {
    notify((e as Error).message);
  }
}
export function changed() {
  window.dispatchEvent(new Event("workspace-changed"));
}
export const icon = (n: any) =>
  n.icon ||
  (n.kind === "database"
    ? "▦"
    : n.kind === "space"
      ? "◈"
      : n.kind === "workspace"
        ? "⬡"
        : "▤");
export const date = (v: string) =>
  new Date(v).toLocaleDateString(undefined, { month: "short", day: "numeric" });
export function go(id: string) {
  window.dispatchEvent(new CustomEvent("workspace-open", { detail: id }));
}
