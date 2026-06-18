# PATHO L3 Checksheet Dashboard

Live web dashboard for the PATHO L3 checksheet and current commissioning issues.

The app is deployable as a Node web service. For local development, when `SHEET_CONFIG` is not set, it reads:

```text
G:\My Drive\PATHO\PATHO L3 Checksheet 2026 rev1.4 (1).xlsm
G:\My Drive\PATHO\L3 Commissioning issues-202606181354.pdf
```

## Local Run

```powershell
npm install
npm start
```

Open `http://localhost:4173`.

## Data Sources

The dashboard reads the `Overview` tab from the PATHO workbook for completion, pass/fail, statistics, and points of failure.

The Current Open Issues section reads the attached commissioning issues PDF and extracts issue ID, title, status, priority, assignee, location, due date, and description.

## Google Sheets Setup

For hosted Google Sheets mode, convert or mirror the PATHO XLSM workbook into a Google Sheet and confirm it has an `Overview` tab.

Create a Google Cloud service account, enable the Google Sheets API, then share the Google Sheet with the service account email as Viewer.

## Environment Variables

Copy `.env.example` values into Render environment variables as needed.

`GOOGLE_SERVICE_ACCOUNT_JSON` can be the full service account JSON on one line, or base64-encoded JSON.

`SHEET_CONFIG` must be a JSON array:

```json
[
  {
    "group": "PATHO",
    "system": "PS1",
    "sheetId": "GOOGLE_SHEET_ID_FOR_PATHO_PS1",
    "overviewTab": "Overview",
    "sourceFile": "PATHO L3 Checksheet 2026 rev1.4"
  }
]
```

`ISSUES_PDF_PATH` can override the local PDF path when running on a machine that can access the issue report.

### Optional Database Mode

Set `DATABASE_URL` to enable PostgreSQL snapshot storage.

When enabled:

- The app imports the configured sheet data on startup.
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

Database tables are created automatically from `scripts/schema.sql`.

## Render

Create a Render Web Service from the GitHub repo.

```text
Runtime: Node
Build command: npm install
Start command: npm start
```

Add these Render environment variables when using Google Sheets/database mode:

```text
GOOGLE_SERVICE_ACCOUNT_JSON
SHEET_CONFIG
PORT
DATABASE_URL
IMPORT_INTERVAL_MINUTES
IMPORT_SECRET
```

Render cannot read your local `G:\My Drive` files directly. For production, use Google Sheets mode for the workbook and update the issue source strategy when you want the PDF issue report hosted too.
