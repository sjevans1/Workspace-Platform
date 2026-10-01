import net from "node:net";

export type AntivirusScanResult =
  | { status: "clean" }
  | { status: "infected"; signature: string };

export interface Antivirus {
  enabled: boolean;
  scan(bytes: Buffer): Promise<AntivirusScanResult>;
  health(): Promise<void>;
}

export class AntivirusUnavailableError extends Error {
  constructor(message = "Malware scanner unavailable") {
    super(message);
    this.name = "AntivirusUnavailableError";
  }
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new Error(`Antivirus numeric setting must be an integer between ${min} and ${max}`);
  return parsed;
}

function command(
  host: string,
  port: number,
  payload: readonly Buffer[],
  timeoutMs: number,
) {
  return new Promise<string>((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let settled = false,
      response = Buffer.alloc(0);

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new AntivirusUnavailableError(error.message));
    };

    socket.setTimeout(timeoutMs, () =>
      fail(new Error("Malware scanner timed out")),
    );
    socket.once("error", (error) => fail(error));
    socket.once("connect", () => {
      for (const part of payload) socket.write(part);
    });
    socket.on("data", (chunk) => {
      response = Buffer.concat([response, chunk]);
      const end = response.indexOf(0);
      if (end < 0) return;
      if (settled) return;
      settled = true;
      socket.end();
      resolve(response.subarray(0, end).toString("utf8").trim());
    });
    socket.once("close", () => {
      if (settled) return;
      const text = response.toString("utf8").replace(/\0.*$/s, "").trim();
      if (!text) return fail(new Error("Malware scanner returned no response"));
      settled = true;
      resolve(text);
    });
  });
}

function streamPayload(bytes: Buffer, chunkSize: number) {
  const payload: Buffer[] = [Buffer.from("zINSTREAM\0")];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize)),
      size = Buffer.allocUnsafe(4);
    size.writeUInt32BE(chunk.length);
    payload.push(size, chunk);
  }
  payload.push(Buffer.alloc(4));
  return payload;
}

export function createAntivirus(
  env: NodeJS.ProcessEnv = process.env,
): Antivirus {
  const mode = env.ANTIVIRUS_MODE || "required";
  if (!["required", "disabled"].includes(mode))
    throw new Error("ANTIVIRUS_MODE must be required or disabled");

  if (mode === "disabled")
    return {
      enabled: false,
      async scan() {
        return { status: "clean" };
      },
      async health() {},
    };

  const host = env.ANTIVIRUS_HOST?.trim() || "clamav",
    port = positiveInteger(env.ANTIVIRUS_PORT, 3310, 1, 65535),
    timeoutMs = positiveInteger(env.ANTIVIRUS_TIMEOUT_MS, 30000, 1000, 120000),
    chunkSize = positiveInteger(env.ANTIVIRUS_CHUNK_BYTES, 65536, 1024, 1048576);

  return {
    enabled: true,
    async health() {
      const reply = await command(
        host,
        port,
        [Buffer.from("zPING\0")],
        Math.min(timeoutMs, 5000),
      );
      if (reply !== "PONG")
        throw new AntivirusUnavailableError("Malware scanner health check failed");
    },
    async scan(bytes) {
      const reply = await command(
        host,
        port,
        streamPayload(bytes, chunkSize),
        timeoutMs,
      );
      if (/^stream:\s+OK$/i.test(reply)) return { status: "clean" };
      const infected = /^stream:\s+(.+?)\s+FOUND$/i.exec(reply);
      if (infected)
        return { status: "infected", signature: infected[1].trim() };
      throw new AntivirusUnavailableError(
        `Unexpected malware scanner response: ${reply.slice(0, 200)}`,
      );
    },
  };
}
