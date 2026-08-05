// Connectivity check for the HighLevel credentials in .env.
// Run this first: it fails loudly if the Private Integration Token was issued
// without the Voice AI scopes, which cannot be added to an existing token.
import { writeFileSync, mkdirSync } from "node:fs";

const { GHL_PIT, GHL_LOCATION_ID } = process.env;

if (!GHL_PIT || !GHL_LOCATION_ID) {
  console.error("Missing GHL_PIT or GHL_LOCATION_ID. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const ENDPOINTS = [
  ["agents", `/voice-ai/agents?locationId=${GHL_LOCATION_ID}`],
  ["call-logs", `/voice-ai/dashboard/call-logs?locationId=${GHL_LOCATION_ID}`],
];

mkdirSync("data", { recursive: true });

for (const [name, path] of ENDPOINTS) {
  const res = await fetch(`https://services.leadconnectorhq.com${path}`, {
    headers: {
      Authorization: `Bearer ${GHL_PIT}`,
      Version: "2021-07-28",
      Accept: "application/json",
    },
  });

  const body = await res.text();
  console.log(`\n${res.status} ${res.statusText}  ${path}`);

  if (!res.ok) {
    console.log(body.slice(0, 400));
    continue;
  }

  // Response shapes are not documented; dump them so the ingestion mapping can
  // be written against what the API actually returns.
  writeFileSync(`data/probe-${name}.json`, body);
  console.log(`wrote data/probe-${name}.json (${body.length} bytes)`);
  console.log(JSON.stringify(JSON.parse(body), null, 2).slice(0, 1200));
}
