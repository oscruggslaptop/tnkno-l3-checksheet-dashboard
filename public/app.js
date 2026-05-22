const app = document.querySelector("#app");
const GROUPS = ["ACB", "Outbound", "Primary"];
let dashboardData = null;
let selectedGroup = location.hash.replace("#", "") || "ACB";

const formatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function percent(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "N/A";
  return `${(value * 100).toFixed(1)}%`;
}

function percentNumber(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, value * 100));
}

function display(value) {
  if (value === null || value === undefined || value === "") return "N/A";
  if (typeof value === "number") {
    if (value >= 0 && value <= 1.25) return percent(value);
    return new Intl.NumberFormat().format(value);
  }
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return formatter.format(new Date(value));
  }
  return String(value).replace(/\u00a0/g, " ").trim();
}

function countDisplay(value) {
  if (value === null || value === undefined || value === "") return "N/A";
  if (typeof value === "number") return new Intl.NumberFormat().format(value);
  return display(value);
}

function metricCard(metric) {
  const hasProgress = typeof metric.complete === "number";
  const value = hasProgress ? percent(metric.complete) : display(metric.total);
  const width = percentNumber(metric.complete);
  const subStats = [
    ["Total", metric.total],
    ["Pass", metric.passed],
    ["Fail", metric.failed],
  ].filter(([, item]) => item !== null && item !== undefined);

  return `
    <article class="metric-card ${metric.tone || ""}">
      <div class="metric-icon"></div>
      <div>
        <p class="metric-title">${metric.label}</p>
        <div class="metric-value">${value}</div>
        ${
          hasProgress
            ? `<div class="progress-track"><div class="progress-fill" style="width:${width}%"></div></div>`
            : ""
        }
        ${
          subStats.length
            ? `<div class="metric-subgrid">${subStats
                .map(
                  ([label, item]) => `
                    <div class="mini-stat">
                      <span>${label}</span>
                      <strong>${display(item)}</strong>
                    </div>`,
                )
                .join("")}</div>`
            : ""
        }
      </div>
    </article>
  `;
}

function breakdownRow(row) {
  return `
    <tr>
      <td><strong>${display(row.type)}</strong></td>
      <td>${countDisplay(row.total)}</td>
      <td>${countDisplay(row.remaining)}</td>
      <td><span class="status-pill">${percent(row.complete)}</span></td>
    </tr>
  `;
}

function moduleRow(row) {
  return `
    <tr>
      <td><strong>${display(row.label)}</strong></td>
      <td>${display(row.total)}</td>
      <td>${display(row.passed)}</td>
      <td>${display(row.failed)}</td>
    </tr>
  `;
}

function failureRow(failure) {
  return `
    <tr>
      <td><span class="failure-source">${display(failure.source)}</span></td>
      <td>${display(failure.location)}</td>
      <td><strong>${display(failure.item)}</strong><small>${display(failure.description)}</small></td>
      <td>${display(failure.detail)}</td>
    </tr>
  `;
}

function failurePanel(system) {
  const failures = system.failures || [];
  return `
    <article class="panel failure-panel">
      <div class="panel-header">
        <div>
          <h2>Points of Failure</h2>
          <span>${failures.length ? `${failures.length} failed items found` : "No failed items found"}</span>
        </div>
      </div>
      ${
        failures.length
          ? `<div class="table-scroll">
              <table class="table failure-table">
                <thead>
                  <tr>
                    <th>Source</th>
                    <th>Location</th>
                    <th>Failed Item</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>${failures.map(failureRow).join("")}</tbody>
              </table>
            </div>`
          : `<div class="empty-failures">No failed checks are currently reported for ${system.system}.</div>`
      }
    </article>
  `;
}

function groupButtons() {
  return GROUPS.map(
    (group) => `
      <button class="group-button ${group === selectedGroup ? "active" : ""}" data-group="${group}" type="button">
        ${group}
      </button>
    `,
  ).join("");
}

function systemNav(group) {
  return `
    <aside class="side-nav" aria-label="System navigation">
      <div class="menu-icon">L3</div>
      ${group.systems
        .map(
          (system, index) => `
            <a class="nav-item ${index === 0 ? "active" : ""}" href="#${system.system}">
              <span>${system.system.slice(0, 1)}</span>${system.system}
            </a>
          `,
        )
        .join("")}
    </aside>
  `;
}

function systemDashboard(system) {
  if (system.error) {
    return `
      <section class="system-section" id="${system.system}">
        <article class="panel system-error">
          <h2>${system.system}</h2>
          <p>${system.sourceFile}</p>
          <code>${system.error}</code>
        </article>
      </section>
    `;
  }

  const overall = percentNumber(system.summary.overallComplete);
  const pass = percentNumber(system.summary.overallPass);
  const fail = Math.max(0, 100 - pass);
  const lastModified = system.lastModified
    ? formatter.format(new Date(system.lastModified))
    : "Unknown";

  return `
    <section class="system-section" id="${system.system}">
      <div class="system-heading">
        <div>
          <p>${system.group}</p>
          <h2>${system.system}</h2>
        </div>
        <div>
          <span>${system.sourceFile}</span>
          <time>Updated ${lastModified}</time>
        </div>
      </div>

      <section class="dashboard">
        <aside class="left-rail">
          ${system.metrics.map(metricCard).join("")}
        </aside>

        <article class="panel hero-panel">
          <div class="panel-header">
            <h2>Overall Percentage Complete</h2>
            <span>vs remaining ${(100 - overall).toFixed(1)}%</span>
          </div>
          <div class="ring-wrap">
            <div class="ring" style="--value:${overall}">
              <div class="ring-inner">
                <div>
                  <strong>${percent(system.summary.overallComplete)}</strong>
                  <span>Complete</span>
                </div>
              </div>
            </div>
          </div>
        </article>

        <section class="right-stack">
          <article class="panel passfail-panel">
            <div class="panel-header">
              <h2>Overall Pass / Fail</h2>
              <span>All checks</span>
            </div>
            <div class="passfail">
              <div class="pass" style="width:${pass}%"><strong>${pass.toFixed(1)}%</strong><span>Pass</span></div>
              <div class="fail" style="width:${fail}%"><strong>${fail.toFixed(1)}%</strong><span>Fail</span></div>
            </div>
            <p class="panel-note">Percent of total checks</p>
          </article>

          <article class="panel breakdown">
            <div class="panel-header">
              <h2>Statistics Breakdown</h2>
              <span>Total vs remaining</span>
            </div>
            <div class="table-scroll">
              <table class="table">
                <thead>
                  <tr>
                    <th>Category</th>
                    <th>Total</th>
                    <th>Remaining</th>
                    <th>Percentage Complete</th>
                  </tr>
                </thead>
                <tbody>${system.breakdown.map(breakdownRow).join("")}</tbody>
              </table>
            </div>
          </article>
        </section>

        ${failurePanel(system)}

        <article class="panel module-panel">
          <div class="panel-header">
            <div>
              <h2>Layout Explained</h2>
              <span>Module summary and schedule</span>
            </div>
          </div>
          <div class="date-strip">
            <div class="date-field">
              <span>Planned Start</span>
              <strong>${display(system.summary.plannedStart)}</strong>
            </div>
            <div class="date-field">
              <span>Actual Start</span>
              <strong>${display(system.summary.actualStart)}</strong>
            </div>
          </div>
          <div class="module-grid">
            <div class="explain">
              <h3>${system.system} Summary</h3>
              <p>This section reads the Overview tab from ${system.sourceFile}. Save the workbook, refresh this page, and the dashboard reflects the latest saved values.</p>
              <div class="legend">
                <span><i style="background:#FFC000"></i> Completion</span>
                <span><i style="background:#FFCA08"></i> Pass rate</span>
                <span><i style="background:#92D050"></i> Entry fields</span>
                <span><i style="background:#FF0000"></i> Attention</span>
              </div>
            </div>
            <div class="table-scroll">
              <table class="table">
                <thead>
                  <tr>
                    <th>Metric</th>
                    <th>Total</th>
                    <th>Pass</th>
                    <th>Fail</th>
                  </tr>
                </thead>
                <tbody>${system.moduleRows.map(moduleRow).join("")}</tbody>
              </table>
            </div>
          </div>
        </article>
      </section>
    </section>
  `;
}

function render() {
  const group = dashboardData.groups.find((item) => item.name === selectedGroup) || dashboardData.groups[0];
  selectedGroup = group.name;
  const refreshed = dashboardData.refreshedAt
    ? formatter.format(new Date(dashboardData.refreshedAt))
    : "Unknown";

  app.innerHTML = `
    ${systemNav(group)}
    <section class="workspace">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark">TNKNO</div>
          <div>
            <h1>${dashboardData.title}</h1>
            <p>${group.name} systems dashboard</p>
          </div>
        </div>
        <div class="source-meta">
          <div class="group-tabs">${groupButtons()}</div>
          <div class="status-chip">Up to date</div>
          <div>
            <p>${group.systems.length} systems loaded</p>
            <time>Refreshed ${refreshed}</time>
          </div>
          <button class="refresh-button" type="button" id="refreshButton" title="Refresh workbook data">Refresh</button>
        </div>
      </header>

      <section class="group-summary">
        <div>
          <p>${group.name}</p>
          <h2>${group.name} L3 Checksheet Systems</h2>
        </div>
        <div class="system-pills">
          ${group.systems
            .map((system) => `<a href="#${system.system}">${system.system}</a>`)
            .join("")}
        </div>
      </section>

      ${group.systems.map(systemDashboard).join("")}
    </section>
  `;

  document.querySelector("#refreshButton").addEventListener("click", load);
  document.querySelectorAll("[data-group]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedGroup = button.dataset.group;
      location.hash = selectedGroup;
      render();
    });
  });
}

function renderError(error) {
  app.innerHTML = `
    <section class="error-panel">
      <div class="error-card">
        <h1>Workbook connection needs attention</h1>
        <p>The app is running, but it could not read the configured spreadsheets.</p>
        <code>${error.detail || error.message || "Unknown error"}</code>
      </div>
    </section>
  `;
}

async function load() {
  try {
    const response = await fetch(`/api/dashboard?ts=${Date.now()}`);
    const data = await response.json();
    if (!response.ok) throw data;
    dashboardData = data;
    render();
  } catch (error) {
    renderError(error);
  }
}

window.addEventListener("hashchange", () => {
  const hash = location.hash.replace("#", "");
  if (GROUPS.includes(hash)) {
    selectedGroup = hash;
    if (dashboardData) render();
  }
});

await load();
setInterval(load, 30000);
