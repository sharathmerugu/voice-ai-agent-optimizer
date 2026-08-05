// Per-location credentials.
//
// HighLevel installs a sub-account app in one of two shapes, and both arrive
// through the same callback:
//
//   Agency install  — one company-scoped token covering every sub-account, now
//                     and in future. This is what an agency owner gets, and the
//                     token response carries companyId but no locationId.
//   Location install — a token scoped to a single sub-account.
//
// A company token cannot read a sub-account's Voice AI data directly, so it is
// exchanged for a location token on demand, for whichever location opened the
// page. Location tokens are short-lived and mintable, so they are cached but
// never refreshed — the company token is the durable credential.
//
// A Private Integration Token is honoured as a local-development shortcut so the
// pipeline can be exercised from the CLI without an install.
import * as store from "./store.js";

const BASE = "https://services.leadconnectorhq.com";

// One key per install. Records are never read-modified-written as a group, so two
// locations refreshing at the same moment cannot overwrite each other.
const companyKey = (id) => `install:company:${id}`;
const locationKey = (id) => `install:location:${id}`;

const { GHL_CLIENT_ID, GHL_CLIENT_SECRET, GHL_PIT, GHL_LOCATION_ID } = process.env;

// Expiry is tracked a minute early rather than racing the boundary.
const expiryOf = (token) => Date.now() + (token.expires_in - 60) * 1000;

const fresh = (entry) => entry && entry.expiresAt > Date.now();

function claimsOf(accessToken) {
  try {
    return JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

async function requestToken(params) {
  const res = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      client_id: GHL_CLIENT_ID,
      client_secret: GHL_CLIENT_SECRET,
      ...params,
    }),
  });

  if (!res.ok) {
    throw new Error(`Token request failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Records an install. Returns a description of what was installed so the
 * callback page can tell the user which sub-accounts it now covers.
 */
export async function completeInstall(code) {
  const token = await requestToken({ grant_type: "authorization_code", code, user_type: "Location" });

  const locationId = token.locationId ?? claimsOf(token.access_token).authClassId;
  const isLocationScoped = token.userType === "Location" || Boolean(token.locationId);

  if (isLocationScoped && locationId) {
    await store.set(locationKey(locationId), {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: expiryOf(token),
      installedAt: new Date().toISOString(),
    });
    return { scope: "location", id: locationId };
  }

  if (!token.companyId) {
    throw new Error(
      `Install returned neither a location nor a company. Token response fields: ${Object.keys(token).join(", ")}.`,
    );
  }

  await store.set(companyKey(token.companyId), {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: expiryOf(token),
    installedAt: new Date().toISOString(),
  });
  return { scope: "company", id: token.companyId };
}

/** A usable company access token, refreshing it if it has expired. */
async function companyToken(companyId, install) {
  if (fresh(install)) return install.accessToken;

  const token = await requestToken({
    grant_type: "refresh_token",
    refresh_token: install.refreshToken,
    user_type: "Company",
  });

  await store.set(companyKey(companyId), {
    ...install,
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? install.refreshToken,
    expiresAt: expiryOf(token),
  });
  return token.access_token;
}

/** Mints a location-scoped token from a company token. */
async function mintLocationToken(accessToken, companyId, locationId) {
  const res = await fetch(`${BASE}/oauth/locationToken`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Version: "2021-07-28",
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({ companyId, locationId }),
  });

  if (!res.ok) {
    throw new Error(`locationToken failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Credentials for a location.
 *
 * Falls back to the Private Integration Token only for the location named in
 * .env, so a deployed instance cannot serve one tenant's data to another.
 */
export async function authFor(locationId) {
  if (!locationId) throw new Error("No locationId — open this page from inside HighLevel.");

  const cached = await store.get(locationKey(locationId));
  if (fresh(cached)) return { locationId, token: cached.accessToken };

  // A direct location install whose token has expired can be refreshed.
  if (cached?.refreshToken) {
    const token = await requestToken({
      grant_type: "refresh_token",
      refresh_token: cached.refreshToken,
      user_type: "Location",
    });
    await store.set(locationKey(locationId), {
      ...cached,
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? cached.refreshToken,
      expiresAt: expiryOf(token),
    });
    return { locationId, token: token.access_token };
  }

  // Otherwise mint one from whichever agency install covers this sub-account.
  const failures = [];
  for (const key of await store.keys("install:company:")) {
    const companyId = key.split(":").pop();
    const install = await store.get(key);
    if (!install) continue;

    try {
      const token = await mintLocationToken(
        await companyToken(companyId, install),
        companyId,
        locationId,
      );
      await store.set(
        locationKey(locationId),
        {
          accessToken: token.access_token,
          expiresAt: expiryOf(token),
          companyId,
          installedAt: new Date().toISOString(),
        },
        // Minted tokens are cheap to replace, so they expire with the token
        // itself rather than lingering as dead keys.
        token.expires_in,
      );
      return { locationId, token: token.access_token };
    } catch (err) {
      failures.push(`${companyId}: ${err.message}`);
    }
  }

  if (GHL_PIT && locationId === GHL_LOCATION_ID) return { locationId, token: GHL_PIT };

  throw new Error(
    failures.length
      ? `No agency install covers location ${locationId}. ${failures.join("; ")}`
      : `This app is not installed for location ${locationId}. Install it from the HighLevel marketplace and reopen the page.`,
  );
}
