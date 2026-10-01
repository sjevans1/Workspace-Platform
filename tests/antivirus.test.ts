import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {
  AntivirusUnavailableError,
  createAntivirus,
} from "../packages/security/antivirus.ts";

function completeRequest(request: Buffer) {
  if (request.equals(Buffer.from("zPING\0"))) return true;
  const command = Buffer.from("zINSTREAM\0");
  if (
    request.length < command.length ||
    !request.subarray(0, command.length).equals(command)
  )
    return false;
  let offset = command.length;
  while (offset + 4 <= request.length) {
    const length = request.readUInt32BE(offset);
    offset += 4;
    if (length === 0) return true;
    if (offset + length > request.length) return false;
    offset += length;
  }
  return false;
}

async function fakeClamd(
  response: string,
  validate?: (request: Buffer) => void,
) {
  const server = net.createServer((socket) => {
    const chunks: Buffer[] = [];
    let replied = false;
    socket.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
      const request = Buffer.concat(chunks);
      if (replied || !completeRequest(request)) return;
      replied = true;
      validate?.(request);
      socket.end(Buffer.from(response + "\0"));
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function env(port: number): NodeJS.ProcessEnv {
  return {
    ANTIVIRUS_MODE: "required",
    ANTIVIRUS_HOST: "127.0.0.1",
    ANTIVIRUS_PORT: String(port),
    ANTIVIRUS_TIMEOUT_MS: "2000",
    ANTIVIRUS_CHUNK_BYTES: "5",
  };
}

test("ClamAV client sends framed PING and INSTREAM chunks and parses clean/infected results", async () => {
  const ping = await fakeClamd("PONG", (request) => {
    assert.deepEqual(request, Buffer.from("zPING\0"));
  });
  try {
    await createAntivirus(env(ping.port)).health();
  } finally {
    await ping.close();
  }

  const plain = Buffer.from("hello antivirus"),
    clean = await fakeClamd("stream: OK", (request) => {
      assert(request.subarray(0, 10).equals(Buffer.from("zINSTREAM\0")));
      let offset = 10,
        reconstructed = Buffer.alloc(0);
      while (offset + 4 <= request.length) {
        const length = request.readUInt32BE(offset);
        offset += 4;
        if (length === 0) break;
        reconstructed = Buffer.concat([
          reconstructed,
          request.subarray(offset, offset + length),
        ]);
        offset += length;
      }
      assert.deepEqual(reconstructed, plain);
    });
  try {
    assert.deepEqual(await createAntivirus(env(clean.port)).scan(plain), {
      status: "clean",
    });
  } finally {
    await clean.close();
  }

  const infected = await fakeClamd("stream: Eicar-Signature FOUND");
  try {
    assert.deepEqual(
      await createAntivirus(env(infected.port)).scan(Buffer.from("eicar")),
      { status: "infected", signature: "Eicar-Signature" },
    );
  } finally {
    await infected.close();
  }
});

test("ClamAV client treats malformed replies and unavailable daemon as scanner failure", async () => {
  const malformed = await fakeClamd("stream: mysterious response");
  try {
    await assert.rejects(
      createAntivirus(env(malformed.port)).scan(Buffer.from("payload")),
      AntivirusUnavailableError,
    );
  } finally {
    await malformed.close();
  }

  const unavailable = createAntivirus({
    ...env(9),
    ANTIVIRUS_TIMEOUT_MS: "1000",
  });
  await assert.rejects(unavailable.health(), AntivirusUnavailableError);
});

test("disabled antivirus mode is explicit and deterministic", async () => {
  const antivirus = createAntivirus({ ANTIVIRUS_MODE: "disabled" });
  assert.equal(antivirus.enabled, false);
  await antivirus.health();
  assert.deepEqual(await antivirus.scan(Buffer.from("anything")), {
    status: "clean",
  });
});
