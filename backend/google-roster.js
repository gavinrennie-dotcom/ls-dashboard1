const DEFAULT_SHEET_ID = "1Oalb_TLXZmI6jJXGhiBGngUOP-ubzg7OHrOtHFrRyCk";
const SHEETS_READ_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

let cachedAccessToken = null;

function base64UrlEncode(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function privateKeyBytes(privateKey) {
  const normalized = String(privateKey)
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");

  if (!normalized) throw new Error("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY is empty");

  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function createServiceAccountJwt(email, privateKey, nowSeconds = Math.floor(Date.now() / 1000)) {
  const signingKey = await crypto.subtle.importKey(
    "pkcs8",
    privateKeyBytes(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64UrlEncode(
    JSON.stringify({
      iss: email,
      scope: SHEETS_READ_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  );
  const unsignedToken = `${header}.${claims}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    signingKey,
    new TextEncoder().encode(unsignedToken),
  );
  return `${unsignedToken}.${base64UrlEncode(signature)}`;
}

async function getServiceAccountAccessToken(env) {
  const email = String(env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "").trim();
  const privateKey = String(env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "");
  if (!email || !privateKey) {
    throw new Error(
      "Both GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY must be configured",
    );
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (
    cachedAccessToken?.email === email &&
    cachedAccessToken.expiresAt > nowSeconds + 60
  ) {
    return cachedAccessToken.value;
  }

  const assertion = await createServiceAccountJwt(email, privateKey, nowSeconds);
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(data?.error_description || data?.error || "Google service-account sign-in failed");
  }

  cachedAccessToken = {
    email,
    value: data.access_token,
    expiresAt: nowSeconds + Number(data.expires_in || 3600),
  };
  return cachedAccessToken.value;
}

function normalizeTime(value, fallback) {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})/);
  if (!match) return fallback;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return fallback;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export async function fetchGoogleRoster(env) {
  const sheetId = env.GOOGLE_SHEET_ID || DEFAULT_SHEET_ID;
  // Read only the authoritative Roster tab. Other spreadsheet tabs are never requested or stored.
  const range = encodeURIComponent(env.GOOGLE_SHEET_RANGE || "Roster!A1:G100");
  const hasServiceAccount = Boolean(
    env.GOOGLE_SERVICE_ACCOUNT_EMAIL || env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
  );
  const headers = {};
  let url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`;

  if (hasServiceAccount) {
    headers.authorization = `Bearer ${await getServiceAccountAccessToken(env)}`;
  } else if (env.GOOGLE_API_KEY) {
    // Legacy support for public/link-readable spreadsheets.
    url += `?key=${encodeURIComponent(env.GOOGLE_API_KEY)}`;
  } else {
    throw new Error("Google service-account credentials are not configured");
  }

  const response = await fetch(url, { headers });
  const data = await response.json();

  if (!response.ok || !Array.isArray(data.values) || data.values.length < 2) {
    if (!hasServiceAccount && response.status === 404) {
      throw new Error(
        "The Google roster is private; configure a service account and share the sheet with its email",
      );
    }
    throw new Error(data?.error?.message || "The Google roster could not be read");
  }

  const [headingRow, ...rows] = data.values;
  const headings = headingRow.map((heading) => String(heading).trim().toLocaleLowerCase());
  const columns = {
    name: headings.findIndex((heading) => heading.includes("agent") || heading === "name"),
    slackId: headings.findIndex((heading) => heading.includes("slack") || heading.includes("member id")),
    status: headings.findIndex((heading) => heading === "status"),
    start: headings.findIndex((heading) => heading.includes("shift start") || heading === "start"),
    end: headings.findIndex((heading) => heading.includes("shift end") || heading === "end"),
  };

  const missingColumns = Object.entries(columns)
    .filter(([, index]) => index < 0)
    .map(([column]) => column);
  if (missingColumns.length) {
    throw new Error(`The sheet is missing required columns: ${missingColumns.join(", ")}`);
  }

  const agents = [];
  const seenSlackIds = new Set();
  for (const [index, row] of rows.entries()) {
    if (!row.some((cell) => String(cell || "").trim())) continue;
    const rowNumber = index + 2;
    const agent = {
      name: String(row[columns.name] || "").trim(),
      slackId: String(row[columns.slackId] || "").trim().toUpperCase(),
      rosterStatus: String(row[columns.status] || "").trim(),
      shiftStart: normalizeTime(row[columns.start], null),
      shiftEnd: normalizeTime(row[columns.end], null),
    };

    if (!agent.name) throw new Error(`Roster row ${rowNumber} has no Agent Name`);
    if (!/^U[A-Z0-9]+$/.test(agent.slackId)) {
      throw new Error(`Roster row ${rowNumber} has an invalid Slack Member ID`);
    }
    if (!/^(active|inactive)$/i.test(agent.rosterStatus)) {
      throw new Error(`Roster row ${rowNumber} must have an Active or Inactive status`);
    }
    if (!agent.shiftStart || !agent.shiftEnd) {
      throw new Error(`Roster row ${rowNumber} has an invalid Shift Start or Shift End`);
    }
    if (seenSlackIds.has(agent.slackId)) {
      throw new Error(`Roster row ${rowNumber} repeats Slack Member ID ${agent.slackId}`);
    }

    seenSlackIds.add(agent.slackId);
    agents.push(agent);
  }

  if (!agents.length) throw new Error("No valid roster rows were found");
  return agents;
}
