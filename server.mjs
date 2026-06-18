import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createSign } from "node:crypto";
import { extname, join, normalize, resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(".");
const publicDir = join(root, "public");
const port = Number(process.env.PORT || 4173);
const databaseUrl = process.env.DATABASE_URL;
const importIntervalMinutes = Number(process.env.IMPORT_INTERVAL_MINUTES || 30);
const importSecret = process.env.IMPORT_SECRET;
const appTitle = "PATHO L3 Checksheet Dashboard";
const issuesPdfPath =
  process.env.ISSUES_PDF_PATH ||
  "G:\\My Drive\\PATHO\\L3 Commissioning issues-202606181354.pdf";
const pythonPath =
  process.env.PYTHON_PATH ||
  "C:\\Users\\oscru\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe";

const localWorkbookConfig = [
  {
    group: "PATHO",
    system: "PS1",
    sourceFile: "PATHO L3 Checksheet 2026 rev1.4 (1).xlsm",
    path: "G:\\My Drive\\PATHO\\PATHO L3 Checksheet 2026 rev1.4 (1).xlsm",
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
let pgPoolPromise = null;
let schemaReadyPromise = null;
let importInFlight = null;

const failureSheetDefs = [
  {
    sheet: "Module",
    range: "A1:I2000",
    statusCol: 6,
    source: "Conveyors/Panels/Field Devices",
    fields: ["category", "location", "item", "description", "type", null, null, null, "detail"],
  },
  {
    sheet: "System Logic",
    range: "A1:H2000",
    statusCol: 7,
    source: "System Logic",
    fields: ["id", "category", "test", "location", "item", "description", null, "detail"],
  },
  {
    sheet: "Stats",
    range: "A1:G2000",
    statusCol: 6,
    source: "HMI Statistics",
    fields: ["category", "subCategory", "item", "description", "type", null, "detail"],
  },
  {
    sheet: "Stats (2)",
    range: "A1:G2000",
    statusCol: 6,
    source: "HMI Statistics",
    fields: ["category", "subCategory", "item", "description", "type", null, "detail"],
  },
  {
    sheet: "Reporting Summary",
    range: "A1:H2000",
    statusCol: 7,
    source: "BAU Push / Reporting",
    fields: ["id", "category", "subCategory", "item", "type", "description", null, "detail"],
  },
  {
    sheet: "HSLA",
    range: "A1:H2000",
    statusCol: 7,
    source: "HSLA",
    fields: ["id", "category", "step", "item", "description", "action", null, "detail"],
  },
];

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function parseJsonEnv(name) {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const attempts = [raw];

  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    try {
      const unwrapped = JSON.parse(raw);
      if (typeof unwrapped === "string") attempts.push(unwrapped.trim());
    } catch {
      attempts.push(raw.slice(1, -1).trim());
    }
  }

  const looksBase64 = /^[A-Za-z0-9+/_=-]+$/.test(raw) && raw.length > 40;
  if (looksBase64) {
    const decoded = Buffer.from(raw, "base64").toString("utf8").trim();
    if (decoded.startsWith("{") || decoded.startsWith("[")) attempts.push(decoded);
  }

  let lastError = null;
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  const preview = raw.slice(0, 80).replace(/\s+/g, " ");
  throw new Error(
    `${name} must be valid JSON${name === "GOOGLE_SERVICE_ACCOUNT_JSON" ? " or base64-encoded JSON" : ""}. ` +
      `It starts with: ${preview}. Parser said: ${lastError?.message}`,
  );
}

function parseServiceAccountEnv() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  const parsed = parseJsonEnv("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!parsed?.private_key || !raw) return parsed;

  return {
    ...parsed,
    private_key: String(parsed.private_key)
      .replace(/\\n/g, "\n")
      .replace(/\r\n/g, "\n"),
  };
}

function parseSheetConfigEnv() {
  const parsed = parseJsonEnv("SHEET_CONFIG");
  if (!parsed) return null;
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.sheets)) return parsed.sheets;
  if (Array.isArray(parsed.systems)) return parsed.systems;
  try {
    return Object.entries(parsed).map(([system, item]) => ({
      system,
      ...(typeof item === "string" ? { sheetId: item } : item),
    }));
  } catch (error) {
    throw new Error(`SHEET_CONFIG must be a JSON array or object. Parser said: ${error.message}`);
  }
}

function getSheetConfig() {
  const config = parseSheetConfigEnv();
  if (!config) return null;
  if (!Array.isArray(config)) {
    throw new Error("SHEET_CONFIG must be a JSON array.");
  }
  return config.map((item) => {
    const accidentalSheetIdKey = Object.keys(item).find(
      (key) =>
        !["group", "system", "sourceFile", "overviewTab", "sheetId", "spreadsheetId", "googleSheetId", "googleSheetsId", "id"].includes(
          key,
        ) && /^[A-Za-z0-9_-]{25,}$/.test(key),
    );
    return {
      overviewTab: "Overview",
      sourceFile: item.system,
      ...item,
      sheetId:
        item.sheetId ||
        item.spreadsheetId ||
        item.googleSheetId ||
        item.googleSheetsId ||
        item.id ||
        accidentalSheetIdKey,
    };
  });
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

  const serviceAccount = parseServiceAccountEnv();
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

async function getPgPool() {
  if (!databaseUrl) return null;
  if (!pgPoolPromise) {
    pgPoolPromise = import("pg").then(({ Pool }) => {
      const sslDisabled = process.env.PGSSLMODE === "disable" || process.env.DATABASE_SSL === "false";
      return new Pool({
        connectionString: databaseUrl,
        ssl: sslDisabled ? false : { rejectUnauthorized: false },
      });
    });
  }
  return pgPoolPromise;
}

async function ensureDatabaseSchema() {
  const pool = await getPgPool();
  if (!pool) return null;
  if (!schemaReadyPromise) {
    schemaReadyPromise = readFile(join(root, "scripts", "schema.sql"), "utf8").then((schema) =>
      pool.query(schema),
    );
  }
  await schemaReadyPromise;
  return pool;
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

function isFailValue(raw) {
  return ["f", "fail", "failed"].includes(String(raw || "").trim().toLowerCase());
}

function firstMeaningful(...values) {
  return values.find((value) => value !== null && value !== undefined && String(value).trim() !== "") || null;
}

function extractFailuresFromRows(def, rows) {
  const failures = [];
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index] || [];
    if (!isFailValue(row[def.statusCol - 1])) continue;
    const item = {};
    def.fields.forEach((field, colIndex) => {
      if (field) item[field] = normalizeValue(row[colIndex]);
    });
    failures.push({
      source: def.source,
      sheet: def.sheet,
      row: index + 1,
      category: firstMeaningful(item.category, item.subCategory, item.test),
      location: firstMeaningful(item.location, item.step),
      item: firstMeaningful(item.item, item.description, item.metric, item.test, `Row ${index + 1}`),
      description: firstMeaningful(item.description, item.action, item.type),
      detail: firstMeaningful(item.detail, item.action),
      status: "Fail",
    });
  }
  return failures;
}

function buildSystemPayload(config, matrix, lastModified = null, failures = []) {
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
    title: appTitle,
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
    failures,
    group: config.group,
    system: config.system,
  };
}

async function fetchGoogleRange(config, range) {
  const token = await getGoogleAccessToken();
  const url = new URL(
    `https://sheets.googleapis.com/v4/spreadsheets/${config.sheetId}/values/${encodeURIComponent(
      range,
    )}`,
  );
  url.searchParams.set("valueRenderOption", "FORMATTED_VALUE");
  url.searchParams.set("dateTimeRenderOption", "FORMATTED_STRING");

  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  const payload = await response.json();
  if (!response.ok) {
    const message = payload.error?.message || "";
    if (response.status === 400 && /Unable to parse range|out of bounds|not found/i.test(message)) {
      return [];
    }
    throw new Error(message || `Google Sheets read failed for ${config.system}.`);
  }
  return payload.values || [];
}

async function readGoogleSystem(config) {
  if (!config.group || !config.system || !config.sheetId) {
    const keys = Object.keys(config).filter((key) => config[key] !== undefined).join(", ");
    throw new Error(
      `Each SHEET_CONFIG item requires group, system, and sheetId. Keys found: ${keys || "none"}.`,
    );
  }
  const cacheKey = `google:${config.sheetId}:${config.overviewTab || "Overview"}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < 30_000) return cached.data;

  const tab = quoteSheetName(config.overviewTab || "Overview");
  const overview = await fetchGoogleRange(config, `${tab}!A1:J31`);
  const failureResults = await Promise.all(
    failureSheetDefs.map(async (def) => {
      const rows = await fetchGoogleRange(config, `${quoteSheetName(def.sheet)}!${def.range}`);
      return extractFailuresFromRows(def, rows);
    }),
  );
  const failures = failureResults.flat();
  const data = buildSystemPayload(config, overview, null, failures);
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

function runLocalIssuesExtractor(sourcePath, modifiedMs) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(pythonPath, [join(root, "scripts", "extract_issues.py"), sourcePath], {
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
        reject(new Error(stderr || `Issues extractor exited with ${code}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Could not parse issues extractor output: ${error.message}`));
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
    title: appTitle,
  };
  cache.set(cacheKey, { modifiedMs: info.mtimeMs, data });
  return data;
}

async function readLocalIssues() {
  try {
    const info = await stat(issuesPdfPath);
    const cacheKey = `local-issues:${issuesPdfPath}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.modifiedMs === info.mtimeMs) return cached.data;

    const issues = await runLocalIssuesExtractor(issuesPdfPath, info.mtimeMs);
    cache.set(cacheKey, { modifiedMs: info.mtimeMs, data: issues });
    return issues;
  } catch (error) {
    return {
      sourceFile: issuesPdfPath.split("\\").pop(),
      sourcePath: issuesPdfPath,
      total: 0,
      statusCounts: {},
      items: [],
      error: error.message,
    };
  }
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

async function getSourceOverview() {
  const sheetConfig = getSheetConfig();
  const mode = sheetConfig ? "google" : "local";
  const config = sheetConfig || localWorkbookConfig;
  const systems = await Promise.all(config.map((item) => readSystem(item, mode)));
  const issues = mode === "local" ? await readLocalIssues() : { total: 0, statusCounts: {}, items: [] };

  for (const system of systems) {
    if (!system.error) system.issues = issues.items || [];
  }

  const groups = config.reduce((acc, item) => {
    if (!acc[item.group]) acc[item.group] = { name: item.group, systems: [] };
    const system = systems.find(
      (candidate) => candidate.group === item.group && candidate.system === item.system,
    );
    if (system) acc[item.group].systems.push(system);
    return acc;
  }, {});

  return {
    title: appTitle,
    dataSource: mode,
    refreshedAt: new Date().toISOString(),
    issues,
    groups: Object.values(groups),
    systems,
  };
}

async function saveDashboardSnapshot(dashboard) {
  const pool = await ensureDatabaseSchema();
  if (!pool) return dashboard;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const snapshot = await client.query(
      "INSERT INTO dashboard_snapshots (source, data) VALUES ($1, $2::jsonb) RETURNING id, imported_at",
      [dashboard.dataSource || "unknown", JSON.stringify(dashboard)],
    );
    const snapshotId = snapshot.rows[0].id;

    for (const system of dashboard.systems || []) {
      await client.query(
        `INSERT INTO dashboard_system_snapshots
          (dashboard_snapshot_id, system_group, system_name, source_file, overall_complete, overall_pass, failure_count, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          snapshotId,
          system.group,
          system.system,
          system.sourceFile || null,
          system.summary?.overallComplete ?? null,
          system.summary?.overallPass ?? null,
          system.failures?.length || 0,
          JSON.stringify(system),
        ],
      );

      for (const failure of system.failures || []) {
        await client.query(
          `INSERT INTO dashboard_failure_snapshots
            (dashboard_snapshot_id, system_group, system_name, source, sheet, row_number, category, location, item, description, detail, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            snapshotId,
            system.group,
            system.system,
            failure.source || null,
            failure.sheet || null,
            failure.row || null,
            failure.category || null,
            failure.location || null,
            failure.item || null,
            failure.description || null,
            failure.detail || null,
            failure.status || null,
          ],
        );
      }
    }

    await client.query("COMMIT");
    return {
      ...dashboard,
      dataSource: `database:${dashboard.dataSource || "unknown"}`,
      databaseSnapshotId: Number(snapshotId),
      databaseImportedAt: snapshot.rows[0].imported_at,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function readLatestDashboardSnapshot() {
  const pool = await ensureDatabaseSchema();
  if (!pool) return null;
  const result = await pool.query(
    "SELECT id, data, imported_at FROM dashboard_snapshots ORDER BY imported_at DESC LIMIT 1",
  );
  if (!result.rows[0]) return null;
  return {
    ...result.rows[0].data,
    dataSource: `database:${result.rows[0].data.dataSource || "unknown"}`,
    databaseSnapshotId: Number(result.rows[0].id),
    databaseImportedAt: result.rows[0].imported_at,
  };
}

async function importDashboardToDatabase() {
  if (importInFlight) return importInFlight;
  importInFlight = (async () => {
    const dashboard = await getSourceOverview();
    return saveDashboardSnapshot(dashboard);
  })();
  try {
    return await importInFlight;
  } finally {
    importInFlight = null;
  }
}

async function getOverview() {
  if (!databaseUrl) return getSourceOverview();
  const latest = await readLatestDashboardSnapshot();
  if (latest) return latest;
  return importDashboardToDatabase();
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
  if (request.url?.startsWith("/api/import")) {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Use POST /api/import to import dashboard data." });
      return;
    }
    if (importSecret && request.headers["x-import-secret"] !== importSecret) {
      sendJson(response, 401, { error: "Invalid import secret." });
      return;
    }
    if (!databaseUrl) {
      sendJson(response, 400, { error: "DATABASE_URL is not configured." });
      return;
    }
    try {
      const imported = await importDashboardToDatabase();
      sendJson(response, 200, {
        ok: true,
        databaseSnapshotId: imported.databaseSnapshotId,
        databaseImportedAt: imported.databaseImportedAt,
        groups: imported.groups?.length || 0,
        systems: imported.systems?.length || 0,
      });
    } catch (error) {
      sendJson(response, 500, {
        error: "Unable to import dashboard data into the database.",
        detail: error.message,
      });
    }
    return;
  }

  if (request.url?.startsWith("/api/dashboard")) {
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const overview = await getGroupOverview(url.searchParams.get("group"));
      sendJson(response, 200, overview);
    } catch (error) {
      sendJson(response, 500, {
        error: "Unable to read the PATHO L3 Checksheet workbook.",
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
  const source = databaseUrl
    ? "PostgreSQL snapshots"
    : process.env.SHEET_CONFIG
      ? "Google Sheets"
      : "local XLSM fallback";
  console.log(`${appTitle} running at http://localhost:${port}`);
  console.log(`Reading dashboard data from ${source}`);
});

if (databaseUrl) {
  importDashboardToDatabase().catch((error) => {
    console.error("Initial database import failed:", error.message);
  });

  if (Number.isFinite(importIntervalMinutes) && importIntervalMinutes > 0) {
    setInterval(
      () => {
        importDashboardToDatabase().catch((error) => {
          console.error("Scheduled database import failed:", error.message);
        });
      },
      importIntervalMinutes * 60 * 1000,
    ).unref();
  }
}
