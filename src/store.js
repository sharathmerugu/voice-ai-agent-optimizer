// Key-value storage for credentials and cached analyses.
//
// Redis when REDIS_URL is set, files otherwise, so local development needs no
// infrastructure and a deployment gets durability. The interface is deliberately
// tiny — get, set with an optional TTL, and list-by-prefix — because nothing here
// needs querying. A run is one document, read whole.
//
// Storing one key per record rather than one shared document is the point, not an
// implementation detail: the previous single installs.json was read, modified and
// written with awaits in between, so two locations refreshing tokens concurrently
// could silently overwrite each other.
import { createClient } from "redis";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";

const DIR = "data/kv";
const { REDIS_URL } = process.env;

let redis;

async function client() {
  if (!redis) {
    redis = createClient({ url: REDIS_URL });
    redis.on("error", (err) => console.error("redis:", err.message));
    await redis.connect();
  }
  return redis;
}

// ':' is conventional in Redis keys and awkward in filenames.
const toFile = (key) => `${DIR}/${key.replace(/:/g, "__")}.json`;
const toKey = (file) => file.replace(/\.json$/, "").replace(/__/g, ":");

export async function get(key) {
  if (REDIS_URL) {
    const raw = await (await client()).get(key);
    return raw ? JSON.parse(raw) : null;
  }

  const file = toFile(key);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

export async function set(key, value, ttlSeconds) {
  const raw = JSON.stringify(value, null, 2);

  if (REDIS_URL) {
    const c = await client();
    return ttlSeconds ? void (await c.set(key, raw, { EX: ttlSeconds })) : void (await c.set(key, raw));
  }

  // The file backend ignores TTLs: entries carry their own expiry and are
  // refreshed on read, so a stale file is replaced rather than served.
  mkdirSync(DIR, { recursive: true });
  writeFileSync(toFile(key), raw);
}

export async function keys(prefix) {
  if (REDIS_URL) {
    const found = [];
    // scanIterator yields a batch of keys per iteration in node-redis v5+, and a
    // single key in v4. Flattening covers both.
    for await (const batch of (await client()).scanIterator({ MATCH: `${prefix}*` })) {
      found.push(...[batch].flat());
    }
    return found;
  }

  if (!existsSync(DIR)) return [];
  return readdirSync(DIR)
    .map(toKey)
    .filter((key) => key.startsWith(prefix));
}
