const $ = id => document.getElementById(id);
let agents = [];
let nextCursor = null;
let query = new URLSearchParams();
let listVersion = 0;
let detailVersion = 0;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function display(value) { return value === null || value === undefined || value === "" ? "—" : String(value); }
function date(value) {
  if (!value) return "—";
  const parsed = new Date(/^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:]+$/.test(value) ? value.replace(" ", "T") + "Z" : value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
function badge(status) {
  return element("span", display(status), `badge ${["OPEN", "UNASSIGNED", "CLOSED", "ANSWERED"].includes(status) ? status.toLowerCase() : ""}`);
}
function auditValue(value) {
  try {
    const state = JSON.parse(value);
    if (state && Object.hasOwn(state, "assigned_user_id")) {
      return `${state.assigned_user_id === null ? "Unassigned" : `Agent #${state.assigned_user_id}`} · ${display(state.status)}`;
    }
  } catch { /* Older ingestion audits store a plain status string. */ }
  return display(value);
}
async function api(path, options) {
  const response = await fetch(path, { cache: "no-store", ...options });
  let body;
  try { body = await response.json(); } catch { throw new Error("The server returned an unexpected response. Please retry."); }
  if (!response.ok || !body.ok) throw new Error(body.message || (body.error === "OPERATIONS_FAILED" ? "Operational data is unavailable. Please retry or check the database configuration." : body.error) || "Request failed");
  return body;
}
function pageError(message) {
  $("page-error").textContent = message;
  $("page-error").hidden = !message;
}
function options(select, entries, first) {
  const selected = select.value;
  select.replaceChildren(new Option(first, ""), ...entries.map(([value, label]) => new Option(label, value)));
  if ([...select.options].some(option => option.value === selected)) select.value = selected;
}
async function loadOverview() {
  const [summary, agentData] = await Promise.all([api("/api/dashboard/summary"), api("/api/agents")]);
  for (const [id, key] of [["total", "total_cases"], ["open", "open"], ["unassigned", "unassigned"], ["agents", "active_agents"], ["shops", "active_shop_assignments"]]) $(id).textContent = summary[key].toLocaleString();
  agents = agentData.agents;
  options($("agent-filter"), agents.map(agent => [String(agent.id), agent.display_name || agent.username || `Agent #${agent.id}`]), "All agents");
  const statuses = [...new Set(["OPEN", "UNASSIGNED", ...Object.keys(summary.statuses)])].filter(Boolean);
  options($("status-filter"), statuses.map(status => [status, status]), "All statuses");
}
function emptyRow(text) {
  const row = element("tr");
  const cell = element("td", text, "empty");
  cell.colSpan = 7;
  row.append(cell);
  return row;
}
async function loadCases(append = false) {
  const version = ++listVersion;
  const params = new URLSearchParams(query);
  if (append && nextCursor) params.set("before_id", nextCursor);
  $("load-more").disabled = true;
  if (!append) $("case-rows").replaceChildren(emptyRow("Loading cases…"));
  try {
    const data = await api(`/api/cases?${params}`);
    if (version !== listVersion) return;
    if (!append) $("case-rows").replaceChildren();
    for (const item of data.cases) {
      const row = element("tr", undefined, item.status === "UNASSIGNED" ? "needs-agent" : "");
      for (const value of [`#${item.id}`, date(item.received_at), display(item.shop_code), display(item.matched_rule_name), item.assigned_agent_display_name || (item.assigned_user_id ? `Agent #${item.assigned_user_id}` : "Not assigned")]) row.append(element("td", value));
      const status = element("td"); status.append(badge(item.status)); row.append(status);
      const action = element("td");
      const button = element("button", "View →", "view-button");
      button.setAttribute("aria-label", `View case ${item.id}`);
      button.addEventListener("click", () => openDetail(item.id));
      action.append(button); row.append(action); $("case-rows").append(row);
    }
    const count = $("case-rows").children.length;
    $("case-count").textContent = `${count} case${count === 1 ? "" : "s"} shown`;
    if (!count) $("case-rows").append(emptyRow("No cases match these filters."));
    nextCursor = data.next_before_id;
    $("load-more").hidden = !nextCursor;
    $("updated").textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  } catch (error) {
    if (version !== listVersion) return;
    if (!append) $("case-rows").replaceChildren(emptyRow("Cases could not be loaded. Use Refresh to retry."));
    $("case-count").textContent = "";
    $("updated").textContent = "Update failed";
    $("load-more").hidden = true;
    throw error;
  } finally { if (version === listVersion) $("load-more").disabled = false; }
}
async function refresh() {
  pageError(""); $("refresh").disabled = true;
  const results = await Promise.allSettled([loadOverview(), loadCases()]);
  const errors = results.filter(result => result.status === "rejected");
  if (errors.length) pageError([...new Set(errors.map(result => result.reason.message))].join(" · "));
  $("refresh").disabled = false;
}
function history(title, rows, render) {
  const section = element("section"); section.append(element("h3", `${title} (${rows.length})`));
  if (!rows.length) section.append(element("p", "No records available.", "subtle"));
  for (const row of rows) {
    const item = element("div", undefined, "history-item"); render(item, row); section.append(item);
  }
  return section;
}
async function openDetail(id) {
  const version = ++detailVersion;
  $("detail-title").textContent = `Case #${id}`;
  $("detail-body").replaceChildren(element("p", "Loading case…", "subtle"));
  if (!$("case-dialog").open) $("case-dialog").showModal();
  try {
    const data = await api(`/api/cases/${id}`);
    if (version !== detailVersion || !$("case-dialog").open) return;
    const item = data.case;
    const body = $("detail-body"); body.replaceChildren();
    const facts = element("dl", undefined, "facts");
    for (const [label, value] of [["Shop", item.shop_code], ["Received", date(item.received_at)], ["Source sender", item.source_sender_name || item.source_sender_id], ["Rule", data.matched_rule?.rule_name], ["Agent", data.assigned_agent?.display_name || (item.assigned_user_id ? `Agent #${item.assigned_user_id}` : "Not assigned")], ["Status", item.status]]) {
      const pair = element("div"); pair.append(element("dt", label), element("dd", display(value))); facts.append(pair);
    }
    body.append(facts);
    if (item.status === "UNASSIGNED") {
      const form = element("form", undefined, "assignment");
      const label = element("label", "Assign this case to an active agent"); label.htmlFor = "assign-agent";
      const select = element("select"); select.id = "assign-agent"; select.required = true;
      options(select, agents.map(agent => [String(agent.id), agent.display_name || agent.username || `Agent #${agent.id}`]), agents.length ? "Select an agent" : "No active agents available");
      const submit = element("button", "Assign case", "button primary"); submit.type = "submit"; submit.disabled = !agents.length;
      const result = element("p"); result.setAttribute("role", "status");
      form.append(label, select, submit, result);
      form.addEventListener("submit", async event => {
        event.preventDefault(); submit.disabled = true; select.disabled = true; result.textContent = "Assigning…";
        try {
          await api(`/api/cases/${id}/assign`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user_id: Number(select.value) }) });
          if (version === detailVersion && $("case-dialog").open) await openDetail(id);
          await refresh();
        } catch (error) { result.className = "error"; result.textContent = error.message; submit.disabled = false; select.disabled = false; }
      });
      body.append(form);
    }
    body.append(element("h3", "Original Telegram message"), element("pre", item.raw_message || "No text message.", "message"));
    body.append(history("Message history", data.case_messages, (node, row) => {
      node.append(element("p", `${display(row.sender_name)} · ${display(row.message_type)} · Telegram #${display(row.telegram_message_id)}`, "subtle"), element("p", row.message_text || "No text."));
      if (row.raw_payload) { const raw = element("details"); raw.append(element("summary", "Original update"), element("pre", row.raw_payload)); node.append(raw); }
    }));
    body.append(history("Audit history", data.audit_logs, (node, row) => {
      node.append(element("p", `${display(row.action)} · ${date(row.created_at)}`), element("p", row.old_value ? `${auditValue(row.old_value)} → ${auditValue(row.new_value)}` : auditValue(row.new_value), "subtle"));
      if (row.metadata) { const meta = element("details"); meta.append(element("summary", "Event details"), element("pre", row.metadata)); node.append(meta); }
    }));
    body.append(history("Responses", data.responses, (node, row) => node.append(element("pre", JSON.stringify(row, null, 2)))));
    for (const warning of data.warnings) body.append(element("p", warning, "subtle"));
  } catch (error) {
    if (version === detailVersion) $("detail-body").replaceChildren(element("p", error.message, "error"));
  }
}
$("refresh").addEventListener("click", refresh);
$("filters").addEventListener("submit", event => {
  event.preventDefault(); query = new URLSearchParams();
  for (const [key, id] of [["status", "status-filter"], ["assigned_user_id", "agent-filter"], ["shop_code", "shop-filter"]]) if ($(id).value.trim()) query.set(key, $(id).value.trim());
  pageError(""); loadCases().catch(error => pageError(error.message));
});
$("clear").addEventListener("click", () => { $("filters").reset(); query = new URLSearchParams(); pageError(""); loadCases().catch(error => pageError(error.message)); });
$("load-more").addEventListener("click", () => loadCases(true).catch(error => pageError(error.message)));
$("close-detail").addEventListener("click", () => $("case-dialog").close());
$("case-dialog").addEventListener("close", () => { detailVersion++; });
refresh();
