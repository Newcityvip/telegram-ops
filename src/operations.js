// CONTROLLED POC ONLY: /dashboard and /api/* are intentionally unauthenticated.
// Anyone who can reach this Worker can read operational data and assign cases.
// Add real authentication/authorization before broader access. No credentials here.
const AGENT_FIELDS = "id, username, display_name, role, is_active";

function json(data, status = 200, headers = {}) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers }
  });
}

function positiveId(value) {
  return /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

async function summary(db) {
  const results = await db.batch([
    db.prepare("SELECT status, COUNT(*) AS count FROM cases GROUP BY status"),
    db.prepare("SELECT COUNT(*) AS count FROM users WHERE is_active = 1 AND role = 'AGENT'"),
    db.prepare("SELECT COUNT(*) AS count FROM shop_assignments WHERE is_active = 1")
  ]);
  const statuses = Object.fromEntries(results[0].results.map(row => [row.status, row.count]));
  return json({
    ok: true,
    total_cases: results[0].results.reduce((sum, row) => sum + row.count, 0),
    open: statuses.OPEN || 0,
    unassigned: statuses.UNASSIGNED || 0,
    answered: statuses.ANSWERED || 0,
    closed: statuses.CLOSED || 0,
    statuses,
    active_agents: results[1].results[0].count,
    active_shop_assignments: results[2].results[0].count
  });
}

async function listCases(db, params) {
  const where = [];
  const values = [];
  for (const [key, column] of [["status", "c.status"], ["shop_code", "c.shop_code"], ["assigned_user_id", "c.assigned_user_id"]]) {
    const value = params.get(key)?.trim();
    if (!value) continue;
    if (value.length > 100 || (key === "assigned_user_id" && !positiveId(value))) {
      return json({ ok: false, error: "INVALID_FILTER", field: key }, 400);
    }
    where.push(`${column} = ?`);
    values.push(key === "assigned_user_id" ? Number(value) : value.toUpperCase());
  }
  const before = params.get("before_id");
  if (before !== null) {
    if (!positiveId(before)) return json({ ok: false, error: "INVALID_CURSOR" }, 400);
    where.push("c.id < ?");
    values.push(Number(before));
  }
  // ID order is already supported by the baseline; no timestamp column is assumed.
  const result = await db.prepare(`
    SELECT c.*, r.rule_name AS matched_rule_name, u.display_name AS assigned_agent_display_name
    FROM cases c
    LEFT JOIN rules r ON r.id = c.matched_rule_id
    LEFT JOIN users u ON u.id = c.assigned_user_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY c.id DESC LIMIT 101
  `).bind(...values).all();
  const rows = result.results.slice(0, 100);
  return json({
    ok: true,
    cases: rows.map(row => ({
      id: row.id, status: row.status, received_at: row.received_at ?? null,
      shop_code: row.shop_code, raw_message: row.raw_message,
      source_sender_id: row.source_sender_id, source_sender_name: row.source_sender_name,
      matched_rule_name: row.matched_rule_name, assigned_user_id: row.assigned_user_id,
      assigned_agent_display_name: row.assigned_agent_display_name
    })),
    next_before_id: result.results.length > 100 ? rows.at(-1).id : null
  });
}

async function detail(db, id) {
  const row = await db.prepare("SELECT * FROM cases WHERE id = ?").bind(id).first();
  if (!row) return json({ ok: false, error: "CASE_NOT_FOUND" }, 404);
  // The supplied schema confirms responses.case_id. Retain the read-only guard
  // for incomplete local fixtures rather than inferring any other association.
  const responseColumns = await db.prepare("PRAGMA table_info(responses)").all();
  const hasResponseCaseId = responseColumns.results.some(column => column.name === "case_id");
  const results = await db.batch([
    db.prepare("SELECT * FROM rules WHERE id = ?").bind(row.matched_rule_id),
    db.prepare(`SELECT ${AGENT_FIELDS} FROM users WHERE id = ?`).bind(row.assigned_user_id),
    db.prepare("SELECT * FROM case_messages WHERE case_id = ?").bind(id),
    db.prepare("SELECT * FROM audit_logs WHERE case_id = ? ORDER BY id ASC").bind(id),
    ...(hasResponseCaseId ? [db.prepare("SELECT * FROM responses WHERE case_id = ? ORDER BY id ASC").bind(id)] : [])
  ]);
  return json({
    ok: true, case: row,
    matched_rule: results[0].results[0] || null,
    assigned_agent: results[1].results[0] || null,
    case_messages: results[2].results,
    audit_logs: results[3].results,
    responses: hasResponseCaseId ? results[4].results : [],
    responses_available: hasResponseCaseId,
    warnings: hasResponseCaseId ? [] : ["Response history unavailable: responses.case_id is not present; no association was inferred."]
  });
}

async function assign(request, db, id) {
  if ((request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase() !== "application/json") {
    return json({ ok: false, error: "JSON_REQUIRED" }, 415);
  }
  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "INVALID_JSON" }, 400); }
  if (!body || typeof body.user_id !== "number" || !positiveId(body.user_id)) {
    return json({ ok: false, error: "INVALID_USER_ID" }, 400);
  }
  const caseRow = await db.prepare("SELECT id FROM cases WHERE id = ?").bind(id).first();
  if (!caseRow) return json({ ok: false, error: "CASE_NOT_FOUND" }, 404);
  const agent = await db.prepare(`SELECT ${AGENT_FIELDS} FROM users WHERE id = ? AND is_active = 1 AND role = 'AGENT'`).bind(body.user_id).first();
  if (!agent) return json({ ok: false, error: "ACTIVE_AGENT_REQUIRED" }, 400);

  const assignedAt = new Date().toISOString();
  // D1 batch runs sequentially as one transaction, rolling back on SQL failure.
  // Capture the previous assignment INSIDE the transaction, then update with the
  // same active-agent predicate. No shop assignment is created or changed.
  // user_id is NULL because there is no authenticated actor in this milestone.
  const results = await db.batch([
    db.prepare(`
      INSERT INTO audit_logs (user_id, case_id, action, entity_type, entity_id, old_value, new_value, metadata)
      SELECT NULL, c.id,
        CASE WHEN c.assigned_user_id IS NULL THEN 'CASE_MANUALLY_ASSIGNED' ELSE 'CASE_REASSIGNED' END,
        'CASE', CAST(c.id AS TEXT),
        json_object('assigned_user_id', c.assigned_user_id, 'assigned_at', c.assigned_at, 'status', c.status),
        json_object('assigned_user_id', ?, 'assigned_at', ?,
          'status', CASE WHEN c.status = 'UNASSIGNED' THEN 'OPEN' ELSE c.status END),
        json_object('assignment_source', 'UNAUTHENTICATED_POC_DASHBOARD',
          'previous_assigned_user_id', c.assigned_user_id, 'assigned_user_id', ?,
          'previous_status', c.status,
          'status', CASE WHEN c.status = 'UNASSIGNED' THEN 'OPEN' ELSE c.status END,
          'previous_assigned_at', c.assigned_at, 'assigned_at', ?)
      FROM cases c WHERE c.id = ?
        AND EXISTS (SELECT 1 FROM users WHERE id = ? AND is_active = 1 AND role = 'AGENT')
    `).bind(body.user_id, assignedAt, body.user_id, assignedAt, id, body.user_id),
    db.prepare(`
      UPDATE cases SET assigned_user_id = ?, assigned_at = ?,
        status = CASE WHEN status = 'UNASSIGNED' THEN 'OPEN' ELSE status END
      WHERE id = ?
        AND EXISTS (SELECT 1 FROM users WHERE id = ? AND is_active = 1 AND role = 'AGENT')
    `).bind(body.user_id, assignedAt, id, body.user_id)
  ]);
  if (!results[1].meta.changes) return json({ ok: false, error: "ASSIGNMENT_CONFLICT", message: "Case or agent changed. Refresh and retry." }, 409);
  return json({ ok: true, case_id: id, assigned_user_id: body.user_id, assigned_at: assignedAt });
}

export async function handleOperations(request, env, url = new URL(request.url)) {
  const path = url.pathname;
  const dashboard = ["/dashboard", "/dashboard/", "/dashboard/app.js", "/dashboard/styles.css"].includes(path);
  if (!dashboard && path !== "/api" && !path.startsWith("/api/")) return null;
  try {
    if (dashboard) {
      if (request.method !== "GET" && request.method !== "HEAD") return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405, { Allow: "GET, HEAD" });
      const assetUrl = new URL(request.url);
      if (path === "/dashboard" || path === "/dashboard/") assetUrl.pathname = "/dashboard/index.html";
      const asset = await env.ASSETS.fetch(new Request(assetUrl, request));
      const response = new Response(asset.body, asset);
      response.headers.set("Cache-Control", "no-store");
      response.headers.set("X-Content-Type-Options", "nosniff");
      response.headers.set("Referrer-Policy", "no-referrer");
      response.headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      return response;
    }
    const match = path.match(/^\/api\/cases\/(\d+)(\/assign)?$/);
    const known = ["/api/dashboard/summary", "/api/cases", "/api/agents", "/api/shop-assignments"].includes(path) || match;
    if (!known) return json({ ok: false, error: "NOT_FOUND" }, 404);
    const method = match?.[2] ? "POST" : "GET";
    if (request.method !== method) return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405, { Allow: method });
    if (match) {
      if (!positiveId(match[1])) return json({ ok: false, error: "INVALID_CASE_ID" }, 400);
      return match[2] ? await assign(request, env.DB, Number(match[1])) : await detail(env.DB, Number(match[1]));
    }
    if (path === "/api/dashboard/summary") return await summary(env.DB);
    if (path === "/api/cases") return await listCases(env.DB, url.searchParams);
    if (path === "/api/agents") {
      const result = await env.DB.prepare(`SELECT ${AGENT_FIELDS} FROM users WHERE is_active = 1 AND role = 'AGENT' ORDER BY display_name, id`).all();
      return json({ ok: true, agents: result.results });
    }
    const result = await env.DB.prepare(`
      SELECT sa.*, u.display_name AS agent_display_name
      FROM shop_assignments sa LEFT JOIN users u ON u.id = sa.assigned_user_id
      WHERE sa.is_active = 1 ORDER BY sa.shop_code
    `).all();
    return json({ ok: true, shop_assignments: result.results });
  } catch (error) {
    console.error("Operations API failed:", error);
    return json({ ok: false, error: "OPERATIONS_FAILED" }, 500);
  }
}
