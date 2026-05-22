import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createSign } from "node:crypto";
import { extname, join, normalize, resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(".");
const publicDir = join(root, "public");
const port = Number(process.env.PORT || 4173);
const pythonPath =
  process.env.PYTHON_PATH ||
  "C:\\Users\\oscru\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe";

const localWorkbookConfig = [
  {
    group: "ACB",
    system: "ACB1",
    path: "G:\\My Drive\\ACB\\ACB\\TNKNO_ACB1_L3 Checksheet 2026.xlsm",
  },
  {
    group: "ACB",
    system: "ACB2",
    path: "G:\\My Drive\\ACB\\ACB\\TNKNO_ACB2_L3 Checksheet 2026 rev1.3.xlsm",
  },
  {
    group: "Outbound",
    system: "PD1",
    path: "G:\\My Drive\\OUTBOUND\\OUTBOUND\\PD1 L3 CHECKSHEET.xlsm",
  },
  {
    group: "Outbound",
    system: "PD2",
    path: "G:\\My Drive\\OUTBOUND\\OUTBOUND\\PD2 L3 CHECKSHEET v2.xlsm",
  },
  {
    group: "Outbound",
    system: "PD3",
    path: "G:\\My Drive\\OUTBOUND\\OUTBOUND\\PD3 L3 CHECKSHEET.xlsm",
  },
  {
    group: "Primary",
    system: "PS1",
    path: "G:\\My Drive\\PRIMARY\\PRIMARY\\PS1 - Checksheet - Ignition 2.0.1.xlsm",
  },
  {
    group: "Primary",
    system: "PS2",
    path: "G:\\My Drive\\PRIMARY\\PRIMARY\\PS2 - Checksheet - Ignition2.0.xlsm",
  },
  {
    group: "Primary",
    system: "PS3",
    path: "G:\\My Drive\\PRIMARY\\PRIMARY\\PS3- Checksheet - Ignition2.0.xlsm",
  },
];

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const palette = {
  slate: "#1F2937",
  amber: "#FFC000",
  amberDeep: "#FFCA08",
  red: "#FF0000",
  green: "#92D050",
  grey: "#D9D9D9",
  white: "#FFFFFF",
};

const cache = new Map();
let googleToken = null;

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function parseJsonEnv(name) {
  const raw = process.env[name];
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    return JSON.parse(decoded);
  }
}

function getSheetConfig() {
  const config = parseJsonEnv("SHEET_CONFIG");
  if (!config) return null;
  if (!Array.isArray(config)) {
    throw new Error("SHEET_CONFIG must be a JSON array.");
  }
  return config.map((item) => ({
    overviewTab: "Overview",
    sourceFile: item.system,
    ...item,
  }));
}

function base64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

async function getGoogleAccessToken() {
  if (googleToken && Date.now() < googleToken.expiresAt - 60_000) {
    return googleToken.accessToken;
  }

  const serviceAccount = parseJsonEnv("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!serviceAccount?.client_email || !serviceAccount?.private_key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key.");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: serviceAccount.token_uri || "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claim))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  const signature = signer.sign(serviceAccount.private_key, "base64url");

  const response = await fetch(serviceAccount.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || "Google auth failed.");
  }
  googleToken = {
    accessToken: payload.access_token,
    expiresAt: Date.now() + Number(payload.expires_in || 3600) * 1000,
  };
  return googleToken.accessToken;
}

function quoteSheetName(name) {
  return `'${String(name).replace(/'/g, "''")}'`;
}

function normalizePercent(raw) {
  if (typeof raw === "number") return raw > 1.25 ? raw / 100 : raw;
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/,/g, "").trim();
  if (!cleaned || cleaned.toUpperCase() === "N/A") return null;
  if (cleaned.endsWith("%")) return Number(cleaned.slice(0, -1)) / 100;
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return null;
  return parsed > 1.25 ? parsed / 100 : parsed;
}

function normalizeValue(raw) {
  if (raw === undefined || raw === "") return null;
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return raw;
  const cleaned = raw.replace(/\u00a0/g, " ").trim();
  if (!cleaned) return null;
  const numeric = Number(cleaned.replace(/,/g, ""));
  if (Number.isFinite(numeric) && /^-?[\d,.]+%?$/.test(cleaned)) {
    return cleaned.endsWith("%") ? numeric / 100 : numeric;
  }
  return cleaned;
}

function cell(matrix, row, col) {
  return normalizeValue(matrix[row - 1]?.[col - 1]);
}

function metric(label, complete, total = null, passed = null, failed = null, tone = "neutral") {
  return {
    label: String(label || "").replace(/\u00a0/g, " ").trim(),
    complete,
    total,
    passed,
    failed,
    tone,
  };
}

function buildSystemPayload(config, matrix, lastModified = null) {
  const metrics = [
    metric(cell(matrix, 3, 2), normalizePercent(cell(matrix, 3, 3)), null, null, null, "primary"),
    metric(
      cell(matrix, 4, 2),
      normalizePercent(cell(matrix, 4, 3)),
      null,
      normalizePercent(cell(matrix, 4, 4)),
      normalizePercent(cell(matrix, 4, 5)),
    ),
    metric(
      cell(matrix, 5, 2),
      normalizePercent(cell(matrix, 5, 3)),
      null,
      normalizePercent(cell(matrix, 5, 4)),
      normalizePercent(cell(matrix, 5, 5)),
    ),
    metric(cell(matrix, 6, 2), normalizePercent(cell(matrix, 6, 3)), null, null, null, "primary"),
    metric(
      cell(matrix, 7, 2),
      normalizePercent(cell(matrix, 7, 3)),
      null,
      normalizePercent(cell(matrix, 7, 4)),
      normalizePercent(cell(matrix, 7, 5)),
    ),
    metric(
      cell(matrix, 8, 2),
      normalizePercent(cell(matrix, 8, 3)),
      null,
      normalizePercent(cell(matrix, 8, 4)),
      normalizePercent(cell(matrix, 8, 5)),
    ),
    metric(
      cell(matrix, 9, 2),
      normalizePercent(cell(matrix, 9, 3)),
      null,
      normalizePercent(cell(matrix, 9, 4)),
      normalizePercent(cell(matrix, 9, 5)),
    ),
    metric(cell(matrix, 10, 2), normalizePercent(cell(matrix, 10, 3)), null, null, null, "primary"),
    metric(
      cell(matrix, 11, 2),
      null,
      cell(matrix, 11, 3),
      cell(matrix, 11, 4),
      cell(matrix, 11, 5),
      "readiness",
    ),
    metric(cell(matrix, 12, 2), normalizePercent(cell(matrix, 12, 3)), null, null, null, "primary"),
    metric(cell(matrix, 15, 2), normalizePercent(cell(matrix, 15, 3)), null, null, null, "pass"),
  ].filter((item) => item.label);

  const breakdown = [4, 5, 6].map((row) => ({
    type: cell(matrix, row, 7),
    total: cell(matrix, row, 8),
    remaining: cell(matrix, row, 9),
    complete: normalizePercent(cell(matrix, row, 10)),
  }));

  const moduleRows = [];
  for (let row = 19; row <= 31; row += 1) {
    const label = cell(matrix, row, 2);
    if (label) {
      moduleRows.push({
        label,
        total: cell(matrix, row, 3),
        passed: cell(matrix, row, 4),
        failed: cell(matrix, row, 5),
      });
    }
  }

  return {
    title: "TNKNO L3 Checksheet Dashboard",
    module: cell(matrix, 2, 2) || config.system,
    sheet: config.overviewTab || "Overview",
    sourceFile: config.sourceFile || config.system,
    lastModified: lastModified || new Date().toISOString(),
    palette,
    summary: {
      overallComplete: normalizePercent(cell(matrix, 3, 3)),
      overallPass: normalizePercent(cell(matrix, 15, 3)),
      plannedStart: cell(matrix, 13, 3),
      actualStart: cell(matrix, 14, 3),
    },
    metrics,
    breakdown,
    moduleRows,
    group: config.group,
    system: config.system,
  };
}

async function readGoogleSystem(config) {
  if (!config.group || !config.system || !config.sheetId) {
    throw new Error("Each SHEET_CONFIG item requires group, system, and sheetId.");
  }
  const cacheKey = `google:${config.sheetId}:${config.overviewTab || "Overview"}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < 30_000) return cached.data;

  const token = await getGoogleAccessToken();
  const tab = quoteSheetName(config.overviewTab || "Overview");
  const url = new URL(
    `https://sheets.googleapis.com/v4/spreadsheets/${config.sheetId}/values/${encodeURIComponent(
      `${tab}!A1:J31`,
    )}`,
  );
  url.searchParams.set("valueRenderOption", "FORMATTED_VALUE");
  url.searchParams.set("dateTimeRenderOption", "FORMATTED_STRING");

  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error?.message || `Google Sheets read failed for ${config.system}.`);
  }
  const data = buildSystemPayload(config, payload.values || []);
  data.sourcePath = `google-sheets:${config.sheetId}`;
  cache.set(cacheKey, { cachedAt: Date.now(), data });
  return data;
}

function runLocalExtractor(sourcePath, modifiedMs) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(pythonPath, [join(root, "scripts", "extract_overview.py"), sourcePath], {
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `Extractor exited with ${code}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Could not parse extractor output: ${error.message}`));
      }
    });
  });
}

async function readLocalSystem(config) {
  const info = await stat(config.path);
  const cacheKey = `local:${config.path}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.modifiedMs === info.mtimeMs) return cached.data;

  const extracted = await runLocalExtractor(config.path, info.mtimeMs);
  const data = {
    ...extracted,
    sourcePath: config.path,
    modifiedMs: info.mtimeMs,
    group: config.group,
    system: config.system,
    title: "TNKNO L3 Checksheet Dashboard",
  };
  cache.set(cacheKey, { modifiedMs: info.mtimeMs, data });
  return data;
}

async function readSystem(config, mode) {
  try {
    return mode === "google" ? await readGoogleSystem(config) : await readLocalSystem(config);
  } catch (error) {
    return {
      group: config.group,
      system: config.system,
      sourceFile: config.sourceFile || config.path?.split("\\").pop() || config.system,
      sourcePath: config.path || `google-sheets:${config.sheetId}`,
      error: error.message,
    };
  }
}

async function getOverview() {
  const sheetConfig = getSheetConfig();
  const mode = sheetConfig ? "google" : "local";
  const config = sheetConfig || localWorkbookConfig;
  const systems = await Promise.all(config.map((item) => readSystem(item, mode)));

  const groups = config.reduce((acc, item) => {
    if (!acc[item.group]) acc[item.group] = { name: item.group, systems: [] };
    const system = systems.find(
      (candidate) => candidate.group === item.group && candidate.system === item.system,
    );
    if (system) acc[item.group].systems.push(system);
    return acc;
  }, {});

  return {
    title: "TNKNO L3 Checksheet Dashboard",
    dataSource: mode,
    refreshedAt: new Date().toISOString(),
    groups: Object.values(groups),
    systems,
  };
}

async function getGroupOverview(groupName) {
  const dashboard = await getOverview();
  if (!groupName) return dashboard;
  return {
    ...dashboard,
    groups: dashboard.groups.filter(
      (group) => group.name.toLowerCase() === groupName.toLowerCase(),
    ),
    systems: dashboard.systems.filter(
      (system) => system.group.toLowerCase() === groupName.toLowerCase(),
    ),
  };
}

async function getLegacyOverview() {
  const dashboard = await getOverview();
  for (const group of dashboard.groups) {
    const system = group.systems.find((item) => !item.error);
    if (system) return system;
  }
  return dashboard.systems[0];
}

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = normalize(join(publicDir, pathname));
  if (!filePath.startsWith(publicDir)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  try {
    await stat(filePath);
    response.writeHead(200, {
      "content-type": mimeTypes[extname(filePath)] || "application/octet-stream",
    });
    createReadStream(filePath).pipe(response);
  } catch {
    const index = await readFile(join(publicDir, "index.html"));
    response.writeHead(200, { "content-type": mimeTypes[".html"] });
    response.end(index);
  }
}

const server = createServer(async (request, response) => {
  if (request.url?.startsWith("/api/dashboard")) {
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const overview = await getGroupOverview(url.searchParams.get("group"));
      sendJson(response, 200, overview);
    } catch (error) {
      sendJson(response, 500, {
        error: "Unable to read the TNKNO L3 Checksheet workbooks.",
        detail: error.message,
      });
    }
    return;
  }
  if (request.url?.startsWith("/api/overview")) {
    sendJson(response, 200, await getLegacyOverview());
    return;
  }
  await serveStatic(request, response);
});

server.listen(port, () => {
  const source = process.env.SHEET_CONFIG ? "Google Sheets" : "local XLSM fallback";
  console.log(`TNKNO L3 Checksheet Dashboard running at http://localhost:${port}`);
  console.log(`Reading dashboard data from ${source}`);
});
