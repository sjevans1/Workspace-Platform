import { isIP } from "node:net";

// The default Fastify limiter masks IPv6 /64 networks. Custom principal
// keys must retain that protection or one IPv6 client could churn interface
// identifiers to evade unauthenticated rate limits.
export function normalizedNetworkIdentity(input: string): string {
  const raw = input.split("%")[0].toLowerCase();
  const version = isIP(raw);
  if (version !== 6) return raw;
  let ip = raw;
  // Convert dotted-quad IPv4 tails in IPv4-mapped IPv6 addresses to hextets.
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (dotted) {
    const octets = dotted[2].split(".").map(Number);
    ip = dotted[1] +
      ((octets[0] << 8) | octets[1]).toString(16) + ":" +
      ((octets[2] << 8) | octets[3]).toString(16);
  }
  const fragments = ip.split("::");
  const before = fragments[0] ? fragments[0].split(":") : [];
  const after = fragments.length === 2 && fragments[1]
    ? fragments[1].split(":") : [];
  const fill = fragments.length === 2
    ? Array(8 - before.length - after.length).fill("0") : [];
  const words = [...before, ...fill, ...after].map((word) =>
    Number.parseInt(word, 16));
  if (words.length !== 8 || words.some((word) => !Number.isFinite(word)))
    return raw;
  if (words.slice(0, 5).every((v) => v === 0) && words[5] === 0xffff) {
    // IPv4-mapped (::ffff:a.b.c.d) must share the corresponding IPv4 key.
    return [
      words[6] >> 8, words[6] & 255,
      words[7] >> 8, words[7] & 255,
    ].join(".");
  }
  return words.slice(0, 4)
    .map((word) => word.toString(16).padStart(4, "0")).join(":") + "/64";
}
