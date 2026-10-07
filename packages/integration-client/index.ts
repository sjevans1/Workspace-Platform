import type { IntegrationRoute, IntegrationRoutes } from "./generated.ts";

type RouteShape<K extends IntegrationRoute> = IntegrationRoutes[K];

export type WorkspaceClientOptions = {
  baseUrl: string;
  token: string;
  fetch?: typeof globalThis.fetch;
};

export class WorkspaceIntegrationClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: WorkspaceClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetch || globalThis.fetch;
  }

  async request<K extends IntegrationRoute>(
    route: K,
    input: {
      params?: RouteShape<K>["params"];
      query?: RouteShape<K>["query"];
      body?: RouteShape<K>["body"];
    } = {},
  ): Promise<RouteShape<K>["response"]> {
    const [method, template] = String(route).split(" ", 2);
    let path = "/api/v1" + template;
    for (const [key, value] of Object.entries(
      (input.params || {}) as Record<string, unknown>,
    ))
      path = path.replace(":" + key, encodeURIComponent(String(value)));

    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(
      (input.query || {}) as Record<string, unknown>,
    ))
      if (value !== undefined && value !== null)
        url.searchParams.set(key, String(value));

    const response = await this.fetchImpl(url, {
      method,
      headers: {
        Authorization: "Bearer " + this.token,
        Accept: "application/json",
        ...(input.body !== undefined && input.body !== null
          ? { "Content-Type": "application/json" }
          : {}),
      },
      ...(input.body !== undefined && input.body !== null
        ? { body: JSON.stringify(input.body) }
        : {}),
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(
        typeof value?.error === "string" ? value.error : "Workspace request failed",
      ) as Error & { status?: number; requestId?: string };
      error.status = response.status;
      error.requestId =
        typeof value?.request_id === "string" ? value.request_id : undefined;
      throw error;
    }
    return value as RouteShape<K>["response"];
  }
}

export type { IntegrationRoute, IntegrationRoutes } from "./generated.ts";
