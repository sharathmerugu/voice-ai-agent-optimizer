// Per-location credentials.
//
// When a sub-account installs the app, HighLevel sends an authorization code to
// /oauth/callback. That code is exchanged for an access token scoped to the
// installing location and stored here, so every request is served with the
// credentials of whoever opened the page — not with a token baked into the
// deployment.
//
// A Private Integration Token is still honoured as a local-development shortcut
// so the pipeline can be exercised from the CLI without an install.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

const TOKEN_URL = "https://services.leadconnectorhq.com/oauth/token";
const STORE = "data/installs.json";

const { GHL_CLIENT_ID, GHL_CLIENT_SECRET, GHL_PIT, GHL_LOCATION_ID } = process.env;

function readStore() {
  return existsSync(STORE) ? JSON.parse(readFileSync(STORE, "utf8")) : {};
}

function writeStore(store) {
  mkdirSync("data", { recursive: true });
  writeFileSync(STORE, JSON.stringify(store, null, 2));
}

async function requestToken(params) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      client_id: GHL_CLIENT_ID,
      client_secret: GHL_CLIENT_SECRET,
      user_type: "Location",
      ...params,
    }),
  });

  if (!res.ok) {
    throw new Error(`Token request failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

/**
 * The location a token belongs to.
 *
 * The token response is documented as carrying `locationId`, but does not always
 * populate it. The access token is a JWT whose payload names the location in
 * `authClassId`, so that is the authoritative source and the response field is
 * only a fallback.
 */
export function claimsOf(token) {
  try {
    return JSON.parse(Buffer.from(token.access_token.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

function locationOf(token) {
  const claims = claimsOf(token);

  // A location-scoped install: the response names the location, and the token's
  // authClass confirms it.
  if (token.locationId) return token.locationId;
  if (claims.authClass === "Location" && claims.authClassId) return claims.authClassId;

  // A company-scoped token cannot serve a sub-account's Voice AI data. Say so
  // rather than storing it under an id that will never be looked up.
  throw new Error(
    `HighLevel issued a ${claims.authClass ?? "unknown"}-scoped token (${claims.authClassId ?? "no id"}), not a location-scoped one. ` +
      `Reinstall from inside the sub-account rather than the agency. Token response fields: ${Object.keys(token).join(", ")}.`,
  );
}

function persist(token) {
  const store = readStore();
  const locationId = locationOf(token);
  store[locationId] = {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    // Refresh a minute early rather than racing the boundary.
    expiresAt: Date.now() + (token.expires_in - 60) * 1000,
    installedAt: new Date().toISOString(),
  };
  writeStore(store);
  return locationId;
}

/** Exchanges the install code for a location-scoped token. Returns the locationId. */
export async function completeInstall(code) {
  return persist(await requestToken({ grant_type: "authorization_code", code }));
}

async function refresh(locationId, install) {
  const token = await requestToken({
    grant_type: "refresh_token",
    refresh_token: install.refreshToken,
  });
  persist({ ...token, locationId });
  return token.access_token;
}

/**
 * Credentials for a location, refreshing the access token when it has expired.
 *
 * Falls back to the Private Integration Token only for the location named in
 * .env, so a deployed instance cannot serve one tenant's data to another.
 */
export async function authFor(locationId) {
  if (!locationId) throw new Error("No locationId — open this page from inside HighLevel.");

  const install = readStore()[locationId];

  if (!install) {
    if (GHL_PIT && locationId === GHL_LOCATION_ID) return { locationId, token: GHL_PIT };
    throw new Error(
      `This app is not installed for location ${locationId}. Install it from the HighLevel marketplace and reopen the page.`,
    );
  }

  const token =
    install.expiresAt > Date.now() ? install.accessToken : await refresh(locationId, install);

  return { locationId, token };
}
