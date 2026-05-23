# TNKNO L3 Checksheet Dashboard

Live web dashboard for TNKNO L3 checksheets across ACB, Outbound, and Primary systems.

The app is deployable as a Node web service. In production it can either read Google Sheets directly or store Google Sheets imports in PostgreSQL and serve the dashboard from the latest database snapshot. For local development, when `SHEET_CONFIG` is not set, it falls back to the local XLSM files on `G:\My Drive`.

## Local Run

```powershell
npm install
npm start
```

Open `http://localhost:4173`.

If `npm install` fails locally with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, fix local npm certificate trust or run the app without installing dependencies for fallback testing:

```powershell
npm start
```

## Google Sheets Setup

Convert or mirror each XLSM workbook into a Google Sheets file. Confirm each file has an `Overview` tab.

Required systems:

```text
ACB: ACB1, ACB2
Outbound: PD1, PD2, PD3
Primary: PS1, PS2, PS3
```

Create a Google Cloud service account, enable the Google Sheets API, then share each Google Sheet with the service account email as Viewer.

## Environment Variables

Copy `.env.example` values into Render environment variables.

`GOOGLE_SERVICE_ACCOUNT_JSON` can be the full service account JSON on one line, or base64-encoded JSON.

`SHEET_CONFIG` must be a JSON array:

```json
[
  {
    "group": "Primary",
    "system": "PS1",
    "sheetId": "GOOGLE_SHEET_ID_FOR_PS1",
    "overviewTab": "Overview",
    "sourceFile": "PS1 - Checksheet - Ignition 2.0.1"
  }
]
```

### Optional Database Mode

Set `DATABASE_URL` to enable PostgreSQL snapshot storage.

When enabled:

- The app imports all Google Sheets on startup.
- The app repeats imports every `IMPORT_INTERVAL_MINUTES`.
- `/api/dashboard` reads the latest saved database snapshot.
- `POST /api/import` triggers a manual import.

Recommended Render variables:

```text
DATABASE_URL=<your Postgres internal/external connection string>
IMPORT_INTERVAL_MINUTES=30
IMPORT_SECRET=<random long secret>
```

Manual import:

```powershell
Invoke-WebRequest -Uri https://YOUR_RENDER_URL/api/import -Method POST -Headers @{"x-import-secret"="YOUR_IMPORT_SECRET"}
```

Database tables are created automatically from `scripts/schema.sql`:

```text
dashboard_snapshots
dashboard_system_snapshots
dashboard_failure_snapshots
```

## GitHub

```powershell
git init
git add .
git commit -m "Initial TNKNO L3 Checksheet Dashboard"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/tnkno-l3-checksheet-dashboard.git
git push -u origin main
```

## Render

Create a Render Web Service from the GitHub repo.

```text
Runtime: Node
Build command: npm install
Start command: npm start
```

Add these Render environment variables:

```text
GOOGLE_SERVICE_ACCOUNT_JSON
SHEET_CONFIG
PORT
DATABASE_URL
IMPORT_INTERVAL_MINUTES
IMPORT_SECRET
```

Render provides a public URL after deploy. The dashboard refreshes from `/api/dashboard` every 30 seconds. With database mode enabled, the page reads the latest saved database snapshot; otherwise it reads Google Sheets directly.
