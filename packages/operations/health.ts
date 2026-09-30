import { createServer, type Server } from "node:http";

export type HealthResult = {
  healthy: boolean;
  status?: string;
  [key: string]: unknown;
};

export async function startInternalHealthServer(
  port: number,
  probe: () => Promise<HealthResult>,
  host = "127.0.0.1",
) {
  const server = createServer(async (req, res) => {
    if (req.method !== "GET" || req.url !== "/health") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "not_found" }));
      return;
    }
    try {
      const result = await probe();
      const healthy = result.healthy === true;
      res.writeHead(healthy ? 200 : 503, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(
        JSON.stringify({
          ...result,
          status: result.status || (healthy ? "healthy" : "unhealthy"),
        }),
      );
    } catch (error) {
      res.writeHead(503, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(
        JSON.stringify({
          healthy: false,
          status: "unhealthy",
          error: (error as Error).message.slice(0, 200),
        }),
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return async () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
}
