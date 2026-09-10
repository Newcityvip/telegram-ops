import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import worker from "../src/index.js";
import { issueToken, verifyToken } from "../src/auth.js";
import { formatTelegramResponse } from "../src/responses.js";
import { compareSync, hashSync } from "bcryptjs";

// Disposable, in-memory test double ONLY. These minimal column definitions come
// from the supplied schemas/baseline queries; they are not production migrations.
// Types/defaults not supplied for cases/users are fixture choices, not assertions
// about production constraints. audit_logs and responses use the supplied DDL.
function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, display_name TEXT, role TEXT, password_hash TEXT, is_active INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE telegram_groups (id INTEGER PRIMARY KEY, telegram_chat_id TEXT, group_name TEXT, group_type TEXT, is_active INTEGER);
    CREATE TABLE rules (id INTEGER PRIMARY KEY, rule_name TEXT, match_type TEXT, match_pattern TEXT, response_type TEXT, response_config TEXT, destination_group_id INTEGER, priority INTEGER, is_active INTEGER);
    CREATE TABLE shop_assignments (id INTEGER PRIMARY KEY, shop_code TEXT NOT NULL, assigned_user_id INTEGER NOT NULL, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE cases (id INTEGER PRIMARY KEY, source_group_id INTEGER, source_chat_id TEXT, source_message_id INTEGER, source_sender_id TEXT, source_sender_name TEXT, raw_message TEXT, shop_code TEXT, matched_rule_id INTEGER, assigned_user_id INTEGER, status TEXT, received_at TEXT, assigned_at TEXT, answered_at TEXT, closed_at TEXT, created_at TEXT, updated_at TEXT, UNIQUE(source_chat_id, source_message_id));
    CREATE TABLE case_messages (case_id INTEGER, telegram_chat_id TEXT, telegram_message_id INTEGER, sender_telegram_id TEXT, sender_name TEXT, message_type TEXT, message_text TEXT, raw_payload TEXT);
    CREATE TABLE audit_logs (id INTEGER PRIMARY KEY, user_id INTEGER NULL, case_id INTEGER NULL, action TEXT NOT NULL, entity_type TEXT NULL, entity_id TEXT NULL, old_value TEXT NULL, new_value TEXT NULL, metadata TEXT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE responses (id INTEGER PRIMARY KEY, case_id INTEGER NOT NULL, user_id INTEGER NOT NULL, response_type TEXT NOT NULL CHECK (response_type IN ('YES','NO','TEMPLATE','TEXT','REASON')), response_text TEXT NULL, destination_chat_id TEXT NOT NULL, telegram_response_message_id INTEGER NULL, status TEXT NOT NULL DEFAULT 'PENDING', error_message TEXT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, sent_at TEXT NULL);
    INSERT INTO users (id, username, display_name, role, is_active) VALUES (1, 'test_agent', 'Test Agent', 'AGENT', 1), (2, 'second', 'Second Agent', 'AGENT', 1), (3, 'inactive', 'Inactive Agent', 'AGENT', 0), (4, 'admin', 'Admin', 'ADMIN', 1), (5, 'unset', 'Unset', 'AGENT', 1);
    INSERT INTO telegram_groups VALUES (1, '-1003878565041', 'EARTH DP ESCALATION', 'SOURCE', 1);
    INSERT INTO rules VALUES (1, 'TEST Shop Message', 'CONTAINS', 'TEST', NULL, NULL, NULL, 10, 1);
    INSERT INTO shop_assignments (shop_code,assigned_user_id,is_active) VALUES ('EARTH003', 1, 1);
  `);
  function prepare(sql, values = []) {
    const execute = () => {
      const statement = sqlite.prepare(sql);
      if (statement.columns().length) return { results: statement.all(...values), meta: { changes: 0 }, success: true };
      const result = statement.run(...values);
      return { results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) }, success: true };
    };
    return {
      bind: (...args) => prepare(sql, args),
      all: async () => execute(),
      first: async () => execute().results[0] || null,
      run: async () => execute(),
      execute
    };
  }
  const DB = {
    prepare,
    async batch(statements) {
      sqlite.exec("BEGIN");
      try { const results = statements.map(statement => statement.execute()); sqlite.exec("COMMIT"); return results; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    }
  };
  sqlite.prepare("UPDATE users SET password_hash=? WHERE id IN (1,3,4)").run(hashSync("correct horse battery staple",4));
  const env = { DB, TELEGRAM_WEBHOOK_SECRET: "local-test-only", TELEGRAM_BOT_TOKEN: "123456:local-test-only", AUTH_SECRET: "test-auth-secret-long-enough" };
  const request = async (path, init={}, userId=4) => { const headers=new Headers(init.headers); if(path.startsWith("/api/")&&path!=="/api/auth/login"&&userId)headers.set("Authorization",`Bearer ${await issueToken(userId,env.AUTH_SECRET)}`); return worker.fetch(new Request(`https://example.test${path}`,{...init,headers}),env); };
  const assignment = (id, user_id) => request(`/api/cases/${id}/assign`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user_id }) });
  let messageId = 0;
  const webhook = (text, extra = {}) => request("/telegram/webhook", {
    method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": env.TELEGRAM_WEBHOOK_SECRET },
    body: JSON.stringify({ message: { chat: { id: -1003878565041 }, message_id: ++messageId, text, from: { id: 7, first_name: "Test", last_name: "Sender" }, ...extra } })
  });
  return { sqlite, env, request, assignment, webhook };
}

test("original ingestion source is byte-identical after removing only routing and own-bot guard", () => {
  const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8").replace(/\r\n/g, "\n")
    .replace('import { handleOperations } from "./operations.js";\n\n', "")
    .replace('const operationsResponse = await handleOperations(request, env, url);\nif (operationsResponse) return operationsResponse;\n', "")
    .replace(/\n    \/\/ OWN BOT LOOP GUARD\n[\s\S]*?    \/\/ END OWN BOT LOOP GUARD\n/, "")
    .replace(/\n\/\/ OWN BOT ID HELPER\n[\s\S]*?\/\/ END OWN BOT ID HELPER\n/, "");
  assert.equal(createHash("sha256").update(source).digest("hex"), "70007cdb8bce382dcec11e55f2c503d00629273252179f9eccfc3df96a0861ae");
});

test("webhook ignores only messages authored by the configured bot", async t => {
  const { request, webhook, sqlite, env } = fixture(t);
  assert.equal((await request("/telegram/webhook", { method: "POST" })).status, 401);
  const own = await (await webhook("TEST EARTH003", { from: { id: 123456, is_bot: true, username: "configured_bot" } })).json();
  assert.deepEqual(own, { ok: true, ignored: true, reason: "OWN_BOT_MESSAGE" });
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM cases").get().n, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM case_messages").get().n, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM audit_logs").get().n, 0);

  const otherBot = await (await webhook("TEST EARTH003", { from: { id: 654321, is_bot: true, username: "source_bot" } })).json();
  assert.equal(otherBot.created, true); assert.equal(otherBot.status, "OPEN");
  const human = await (await webhook("TEST EARTH999", { from: { id: 7, first_name: "Human" } })).json();
  assert.equal(human.created, true); assert.equal(human.status, "UNASSIGNED");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM cases").get().n, 2);

  env.TELEGRAM_BOT_TOKEN = "malformed-token";
  const malformed = await (await webhook("TEST EARTH003", { from: { id: 123456, is_bot: true } })).json();
  assert.equal(malformed.created, true);
});

test("legacy routes and webhook mapped/unmapped/unmatched/duplicate preservation", async t => {
  const { request, webhook, sqlite } = fixture(t);
  assert.deepEqual(await (await request("/")).json(), { ok: true, service: "telegram-ops-api", database: "telegram-ops-db" });
  assert.equal((await (await request("/db-check")).json()).database_connected, true);
  assert.equal((await request("/telegram/webhook", { method: "POST" })).status, 401);
  assert.equal((await request("/unknown")).status, 404);
  const mapped = await (await webhook("TEST EARTH003")).json();
  assert.equal(mapped.status, "OPEN"); assert.equal(mapped.assigned_user_id, 1);
  assert.equal((await (await webhook("TEST EARTH999")).json()).status, "UNASSIGNED");
  assert.equal((await (await webhook("HELLO EARTH003")).json()).reason, "NO_MATCHING_RULE");
  assert.equal((await (await webhook("TEST EARTH003", { message_id: 1 })).json()).duplicate, true);
  assert.equal((await (await webhook("TEST EARTH003", { chat: { id: 999 } })).json()).reason, "UNCONFIGURED_SOURCE_GROUP");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM cases").get().n, 2);
  const saved = sqlite.prepare("SELECT * FROM case_messages WHERE case_id = 1").get();
  assert.equal(JSON.parse(saved.raw_payload).message.text, "TEST EARTH003");
  assert.equal(saved.sender_name, "Test Sender");
  assert.deepEqual(sqlite.prepare("SELECT action FROM audit_logs").all().map(row => row.action), ["CASE_AUTO_ASSIGNED", "CASE_CREATED_UNASSIGNED"]);
});

test("summary, parameterized filters, safe agent fields, and case detail", async t => {
  const { request, webhook } = fixture(t);
  await webhook("TEST EARTH003"); await webhook("TEST EARTH999");
  const summary = await (await request("/api/dashboard/summary")).json();
  assert.equal(summary.total_cases, 2); assert.equal(summary.open, 1); assert.equal(summary.unassigned, 1);
  assert.equal(summary.active_agents, 3); assert.equal(summary.active_shop_assignments, 1);
  const list = await (await request("/api/cases")).json();
  assert.deepEqual(list.cases.map(row => row.id), [2, 1]); assert.equal(list.cases[0].received_at, null);
  const filtered = await (await request("/api/cases?status=OPEN&assigned_user_id=1&shop_code=earth003")).json();
  assert.equal(filtered.cases.length, 1); assert.equal(filtered.cases[0].assigned_agent_display_name, "Test Agent");
  assert.equal((await (await request("/api/cases?shop_code=" + encodeURIComponent("' OR 1=1 --"))).json()).cases.length, 0);
  const agents = await (await request("/api/agents")).json();
  assert.deepEqual(agents.agents.map(row => row.id), [1, 2, 5]);
  assert.deepEqual(Object.keys(agents.agents[0]).sort(), ["display_name", "id", "is_active", "role", "username"]);
  assert.equal((await (await request("/api/shop-assignments")).json()).shop_assignments[0].agent_display_name, "Test Agent");
  const detail = await (await request("/api/cases/1")).json();
  assert.equal(detail.case.raw_message, "TEST EARTH003"); assert.equal(detail.case_messages.length, 1);
  assert.equal(detail.audit_logs.length, 1); assert.equal(detail.case.matched_rule_name, "TEST Shop Message");
  assert.equal(detail.responses_available, true); assert.equal(detail.warnings.length, 0);
  assert.equal("password_hash" in detail.case, false);
  assert.equal(JSON.stringify(detail).includes("password_hash"), false);
});

test("received_at and associated responses follow the supplied schema", async t => {
  const { request, webhook, sqlite } = fixture(t);
  await webhook("TEST EARTH003");
  sqlite.exec("UPDATE cases SET received_at = '2026-09-07 06:00:00'; INSERT INTO responses (case_id, user_id, response_type, destination_chat_id) VALUES (1, 1, 'TEXT', '-1'), (99, 1, 'TEXT', '-1')");
  assert.equal((await (await request("/api/cases")).json()).cases[0].received_at, "2026-09-07 06:00:00");
  const detail = await (await request("/api/cases/1")).json();
  assert.equal(detail.responses_available, true); assert.equal(detail.responses.length, 1);
  assert.equal(detail.responses[0].status, "PENDING"); assert.ok(detail.responses[0].created_at);
});

test("incomplete local response fixtures are reported explicitly", async t => {
  const { request, webhook, sqlite } = fixture(t);
  await webhook("TEST EARTH003");
  sqlite.exec("DROP TABLE responses"); // Disposable in-memory fixture only.
  const detail = await (await request("/api/cases/1")).json();
  assert.equal(detail.responses_available, false); assert.equal(detail.warnings.length, 1);
});

test("assignment and reassignment preserve status, record prior ownership, leave mappings alone", async t => {
  const { request, webhook, assignment, sqlite } = fixture(t);
  await webhook("TEST EARTH999");
  assert.equal((await assignment(1, 1)).status, 200);
  let row = sqlite.prepare("SELECT * FROM cases WHERE id=1").get();
  assert.equal(row.status, "OPEN"); assert.equal(row.assigned_user_id, 1); assert.ok(row.assigned_at);
  const firstAudit = sqlite.prepare("SELECT * FROM audit_logs WHERE action='CASE_MANUALLY_ASSIGNED'").get();
  assert.deepEqual(JSON.parse(firstAudit.old_value), { assigned_user_id: null, assigned_at: null, status: "UNASSIGNED" });
  assert.deepEqual(JSON.parse(firstAudit.new_value), { assigned_user_id: 1, assigned_at: row.assigned_at, status: "OPEN" });
  assert.ok(firstAudit.created_at);
  const previousAssignedAt = row.assigned_at;
  sqlite.exec("UPDATE cases SET status='CLOSED' WHERE id=1");
  assert.equal((await assignment(1, 2)).status, 200);
  row = sqlite.prepare("SELECT * FROM cases WHERE id=1").get();
  assert.equal(row.status, "CLOSED"); assert.equal(row.assigned_user_id, 2);
  const audit = sqlite.prepare("SELECT * FROM audit_logs WHERE action='CASE_REASSIGNED'").get();
  assert.equal(audit.user_id, 4);
  assert.deepEqual(JSON.parse(audit.old_value), { assigned_user_id: 1, assigned_at: previousAssignedAt, status: "CLOSED" });
  assert.deepEqual(JSON.parse(audit.new_value), { assigned_user_id: 2, assigned_at: row.assigned_at, status: "CLOSED" });
  assert.equal(sqlite.prepare("SELECT assigned_user_id FROM shop_assignments").get().assigned_user_id, 1);
  assert.equal((await (await request("/api/dashboard/summary")).json()).closed, 1);
});

test("invalid assignments and invalid routing never write data", async t => {
  const { request, assignment, webhook, sqlite } = fixture(t);
  await webhook("TEST EARTH999");
  for (const id of [3, 4, 99]) assert.equal((await assignment(1, id)).status, 404);
  for (const id of [0, -1, 1.5, null]) assert.equal((await assignment(1, id)).status, 400);
  assert.equal((await assignment(999, 1)).status, 404);
  assert.equal((await request("/api/cases/1/assign", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" })).status, 400);
  assert.equal((await request("/api/cases/1/assign", { method: "POST", body: "{}" })).status, 400);
  assert.equal((await request("/api/cases/1/assign")).status, 405);
  assert.equal((await request("/api/cases", { method: "POST" })).status, 405);
  assert.equal((await request("/api/cases/999")).status, 404);
  assert.equal((await request("/api/cases/0")).status, 404);
  assert.equal((await request("/api/not-real")).status, 404);
  assert.equal((await request("/api/cases?assigned_user_id=abc")).status, 400);
  assert.equal((await request("/api/cases?before_id=-1")).status, 200);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs").get().n, 1);
  assert.equal(sqlite.prepare("SELECT status FROM cases").get().status, "UNASSIGNED");
});

test("a failed case update rolls back the audit in the assignment batch", async t => {
  const { assignment, webhook, sqlite } = fixture(t);
  await webhook("TEST EARTH999");
  sqlite.exec("CREATE TRIGGER reject_update BEFORE UPDATE ON cases BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  assert.equal((await assignment(1, 1)).status, 500);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs").get().n, 1);
  assert.equal(sqlite.prepare("SELECT assigned_user_id FROM cases").get().assigned_user_id, null);
});

test("an agent becoming inactive before the batch causes no writes", async t => {
  const { assignment, webhook, sqlite, env } = fixture(t);
  await webhook("TEST EARTH999");
  const original = env.DB.batch;
  env.DB.batch = statements => { sqlite.exec("UPDATE users SET is_active=0 WHERE id=1"); return original(statements); };
  assert.equal((await assignment(1, 1)).status, 404);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs").get().n, 1);
  assert.equal(sqlite.prepare("SELECT assigned_user_id FROM cases").get().assigned_user_id, null);
});

test("a failed audit insert leaves the case assignment unchanged", async t => {
  const { assignment, webhook, sqlite } = fixture(t);
  await webhook("TEST EARTH999");
  sqlite.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'test audit failure'); END");
  const before = sqlite.prepare("SELECT * FROM cases WHERE id=1").get();
  assert.equal((await assignment(1, 1)).status, 500);
  assert.deepEqual(sqlite.prepare("SELECT * FROM cases WHERE id=1").get(), before);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs").get().n, 1);
});

test("case list stays bounded", async t => {
  const { request, sqlite } = fixture(t);
  const insert = sqlite.prepare("INSERT INTO cases (status) VALUES ('OPEN')");
  for (let i = 0; i < 105; i++) insert.run();
  const first = await (await request("/api/cases")).json();
  assert.equal(first.cases.length, 100);
});

test("dashboard asset routing and API failures are isolated from legacy routes", async t => {
  const { request, env } = fixture(t);
  env.ASSETS = { fetch: async request => new Response(new URL(request.url).pathname) };
  const dashboard = await request("/dashboard");
  assert.equal(dashboard.status, 302); assert.equal(dashboard.headers.get("Location"), "https://newcityvip.github.io/telegram-ops/");
  env.DB.prepare = () => { throw new Error("test database failure"); };
  const response = await request("/api/agents");
  assert.equal(response.status, 500); assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal((await response.json()).error, "OPERATIONS_FAILED");
  assert.equal((await request("/")).status, 200);
});

test("authentication accepts valid credentials and rejects invalid users", async t => {
  const { request, env } = fixture(t);
  const login = body => request("/api/auth/login", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}, null);
  const good = await (await login({username:"admin",password:"correct horse battery staple"})).json();
  assert.equal(good.ok,true); assert.equal(good.user.role,"ADMIN"); assert.equal((await verifyToken(good.token,env.AUTH_SECRET)).sub,4);
  for(const username of ["admin","missing","inactive","unset"]) { const password=username==="admin"?"wrong":"correct horse battery staple"; assert.equal((await login({username,password})).status,401); }
  const expired=await issueToken(4,env.AUTH_SECRET,Date.now()-7200000);
  assert.equal((await request("/api/cases",{headers:{Authorization:`Bearer ${expired}`}},null)).status,401);
  assert.equal((await request("/api/cases",{headers:{Authorization:`Bearer ${good.token}x`}},null)).status,401);
});

test("stored sessions restore authoritative ADMIN and AGENT identities", async t => {
  const { request, env, sqlite, webhook } = fixture(t);
  await webhook("TEST EARTH003"); await webhook("TEST EARTH999");
  for (const [id, role] of [[4, "ADMIN"], [1, "AGENT"]]) {
    const token = await issueToken(id, env.AUTH_SECRET);
    const session = await request("/api/auth/session", { headers: { Authorization: `Bearer ${token}` } }, null);
    assert.equal(session.status, 200);
    const body = await session.json();
    assert.equal(body.user.id, id); assert.equal(body.user.role, role);
    assert.equal("password_hash" in body.user, false); assert.equal("is_active" in body.user, false);
    const cases = await (await request("/api/cases", { headers: { Authorization: `Bearer ${token}` } }, null)).json();
    assert.deepEqual(cases.cases.map(item => item.id), role === "ADMIN" ? [2, 1] : [1]);
  }
  const expired = await issueToken(4, env.AUTH_SECRET, Date.now() - 7200000);
  assert.equal((await request("/api/auth/session", { headers: { Authorization: `Bearer ${expired}` } }, null)).status, 401);
  assert.equal((await request("/api/auth/session", { headers: { Authorization: "Bearer malformed" } }, null)).status, 401);
  sqlite.exec("UPDATE users SET is_active=0 WHERE id=1");
  const inactive = await issueToken(1, env.AUTH_SECRET);
  assert.equal((await request("/api/auth/session", { headers: { Authorization: `Bearer ${inactive}` } }, null)).status, 401);
  sqlite.exec("DELETE FROM users WHERE id=2");
  const missing = await issueToken(2, env.AUTH_SECRET);
  assert.equal((await request("/api/auth/session", { headers: { Authorization: `Bearer ${missing}` } }, null)).status, 401);
});

test("frontend persists only the token and clears it on logout", () => {
  const source = readFileSync(new URL("../docs/app.js", import.meta.url), "utf8");
  assert.match(source, /localStorage\.setItem\("ops-token",token\)/);
  assert.match(source, /api\("\/api\/auth\/session"\)/);
  assert.match(source, /localStorage\.removeItem\("ops-token"\)/);
  assert.equal(source.includes("localStorage.setItem(\"role\""), false);
  assert.equal(source.includes("localStorage.setItem(\"password\""), false);
});

test("case slip preview validates image URLs and keeps rendering text-only", () => {
  const app = readFileSync(new URL("../docs/app.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../docs/index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../docs/styles.css", import.meta.url), "utf8");
  assert.match(app, /\^Image\\s\*:/); assert.match(app, /\["http:","https:"\]\.includes\(url\.protocol\)/);
  assert.match(app, /View Slip/); assert.match(app, /showModal\(\)/); assert.match(app, /function closeSlip\(\).*\.close\(\)/);
  assert.match(app, /document\.createTextNode\(line\)/); assert.doesNotMatch(app, /innerHTML/);
  assert.match(app, /response_definition/); assert.match(app, /\/respond/);
  assert.match(html, /id="slip-dialog"/); assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /slip-zoom-in/); assert.match(html, /slip-zoom-out/); assert.match(html, /slip-reset/);
  assert.match(css, /\.slip-viewport[\s\S]*overflow:auto/); assert.match(css, /object-fit:contain/);
});

test("role authorization and sender privacy are enforced server-side", async t => {
  const { request, webhook }=fixture(t); await webhook("TEST EARTH003"); await webhook("TEST EARTH999");
  const mine=await (await request("/api/cases",{},1)).json(); assert.deepEqual(mine.cases.map(c=>c.id),[1]);
  assert.equal("source_sender_name" in mine.cases[0],false); assert.equal((await request("/api/cases/2",{},1)).status,404);
  assert.equal((await request("/api/cases/1/assign",{method:"POST",body:"{}"},1)).status,403);
  assert.equal((await request("/api/shop-assignments",{},1)).status,403);
  assert.equal((await request("/api/admin/sync-shop-assignments",{method:"POST"},1)).status,403);
  const detail=await (await request("/api/cases/1",{},1)).json(); assert.equal("sender_name" in detail.case_messages[0],false); assert.equal("sender_telegram_id" in detail.case_messages[0],false);
});

test("CORS permits only the GitHub Pages origin", async t => {
  const { request }=fixture(t),origin="https://newcityvip.github.io";
  const pre=await request("/api/cases",{method:"OPTIONS",headers:{Origin:origin,"Access-Control-Request-Headers":"authorization"}},null);
  assert.equal(pre.status,204);assert.equal(pre.headers.get("Access-Control-Allow-Origin"),origin);
  assert.equal((await request("/api/cases",{headers:{Origin:"https://evil.example"}},null)).status,403);
});

test("ADMIN sync validates fully then atomically updates mappings", async t => {
  const {request,env,sqlite}=fixture(t);env.GSHEET_SYNC_URL="https://sheet.example/exec";env.GSHEET_SYNC_SECRET="test-sync-secret";
  const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);
  globalThis.fetch=async()=>Response.json({ok:true,assignments:[{Shop_Code:"earth003",Agent_Username:"test_agent",Active:true},{Shop_Code:"earth020",Agent_Username:"second",Active:true}]});
  let result=await (await request("/api/admin/sync-shop-assignments",{method:"POST"})).json();assert.equal(result.inserted,1);assert.equal(sqlite.prepare("SELECT assigned_user_id FROM shop_assignments WHERE shop_code='EARTH020'").get().assigned_user_id,2);
  const before=JSON.stringify(sqlite.prepare("SELECT * FROM shop_assignments ORDER BY id").all());globalThis.fetch=async()=>Response.json({ok:true,assignments:[{Shop_Code:"X",Agent_Username:"missing",Active:true},{Shop_Code:"X",Agent_Username:"test_agent",Active:true}]});
  const bad=await request("/api/admin/sync-shop-assignments",{method:"POST"});assert.equal(bad.status,422);assert.equal(JSON.stringify(sqlite.prepare("SELECT * FROM shop_assignments ORDER BY id").all()),before);
});

test("ADMIN lists safe user fields and creates AGENT and ADMIN accounts", async t => {
  const { request, sqlite } = fixture(t);
  let response = await request("/api/admin/users");
  assert.equal(response.status, 200);
  const listed = await response.json();
  assert.equal(listed.users.length, 5);
  assert.deepEqual(Object.keys(listed.users[0]).sort(), ["created_at", "display_name", "id", "is_active", "role", "username"]);
  assert.equal(JSON.stringify(listed).includes("password_hash"), false);

  const create = (username, role) => request("/api/admin/users", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, display_name: `${role} Test`, role, password: "a secure test password", is_active: true })
  });
  response = await create("new_agent", "AGENT");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).user.role, "AGENT");
  response = await create("new_admin", "ADMIN");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).user.role, "ADMIN");

  const stored = sqlite.prepare("SELECT password_hash FROM users WHERE username='new_agent'").get().password_hash;
  assert.notEqual(stored, "a secure test password");
  assert.equal(compareSync("a secure test password", stored), true);
  const audits = sqlite.prepare("SELECT * FROM audit_logs WHERE action='USER_CREATED' ORDER BY id").all();
  assert.equal(audits.length, 2); assert.ok(audits.every(row => row.user_id === 4));
  assert.equal(JSON.stringify(audits).includes("password"), false);
  assert.equal(JSON.stringify(audits).includes(stored), false);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM shop_assignments").get().n, 1);
});

test("user creation rejects duplicates, invalid roles, and invalid fields", async t => {
  const { request, sqlite } = fixture(t);
  const post = body => request("/api/admin/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const valid = { username: "admin", display_name: "Duplicate", role: "AGENT", password: "a secure test password", is_active: true };
  assert.equal((await post(valid)).status, 409);
  assert.equal((await post({ ...valid, username: "valid_name", role: "OWNER" })).status, 400);
  assert.equal((await post({ ...valid, username: "bad name" })).status, 400);
  assert.equal((await post({ ...valid, username: "valid_name", password: "short" })).status, 400);
  assert.equal((await post({ ...valid, username: "valid_name", display_name: "" })).status, 400);
  assert.equal((await post({ ...valid, username: "valid_name", is_active: 1 })).status, 400);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM users").get().n, 5);
});

test("ADMIN resets passwords and activates or deactivates other users with safe audits", async t => {
  const { request, sqlite } = fixture(t);
  let response = await request("/api/admin/users/1/password", { method: "POST", body: JSON.stringify({ password: "the replacement password" }) });
  assert.equal(response.status, 200);
  const stored = sqlite.prepare("SELECT password_hash FROM users WHERE id=1").get().password_hash;
  assert.equal(compareSync("the replacement password", stored), true);
  const login = await request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "test_agent", password: "the replacement password" }) }, null);
  assert.equal(login.status, 200);

  response = await request("/api/admin/users/1/status", { method: "POST", body: JSON.stringify({ is_active: false }) });
  assert.equal(response.status, 200); assert.equal(sqlite.prepare("SELECT is_active FROM users WHERE id=1").get().is_active, 0);
  response = await request("/api/admin/users/1/status", { method: "POST", body: JSON.stringify({ is_active: true }) });
  assert.equal(response.status, 200); assert.equal(sqlite.prepare("SELECT is_active FROM users WHERE id=1").get().is_active, 1);
  response = await request("/api/admin/users/4/status", { method: "POST", body: JSON.stringify({ is_active: false }) });
  assert.equal(response.status, 409); assert.equal(sqlite.prepare("SELECT is_active FROM users WHERE id=4").get().is_active, 1);

  const audits = sqlite.prepare("SELECT action, user_id, old_value, new_value, metadata FROM audit_logs WHERE entity_type='USER' ORDER BY id").all();
  assert.deepEqual(audits.map(row => row.action), ["USER_PASSWORD_RESET", "USER_DEACTIVATED", "USER_ACTIVATED"]);
  assert.ok(audits.every(row => row.user_id === 4));
  const serialized = JSON.stringify(audits);
  assert.equal(serialized.includes("replacement password"), false); assert.equal(serialized.includes(stored), false);
});

test("AGENT receives 403 for every user-management endpoint", async t => {
  const { request, sqlite } = fixture(t);
  const calls = [
    ["/api/admin/users", {}],
    ["/api/admin/users", { method: "POST", body: JSON.stringify({ username: "blocked", display_name: "Blocked", role: "AGENT", password: "a secure test password", is_active: true }) }],
    ["/api/admin/users/2/password", { method: "POST", body: JSON.stringify({ password: "a replacement password" }) }],
    ["/api/admin/users/2/status", { method: "POST", body: JSON.stringify({ is_active: false }) }]
  ];
  for (const [path, options] of calls) assert.equal((await request(path, options, 1)).status, 403);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM users").get().n, 5);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM audit_logs").get().n, 0);
});

test("a failed user audit rolls back the account mutation", async t => {
  const { request, sqlite } = fixture(t);
  sqlite.exec("CREATE TRIGGER reject_user_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'test user audit failure'); END");
  const response = await request("/api/admin/users", {
    method: "POST", body: JSON.stringify({ username: "rolled_back", display_name: "Rolled Back", role: "AGENT", password: "a secure test password", is_active: true })
  });
  assert.equal(response.status, 500);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM users WHERE username='rolled_back'").get().n, 0);
});

test("assigned AGENT sends a configured response to the rule destination", async t => {
  const { request, webhook, sqlite, env } = fixture(t);
  sqlite.exec("INSERT INTO telegram_groups VALUES (2, '-2001', 'EARTH Responses', 'DESTINATION', 1); UPDATE rules SET response_type='YES_NO', destination_group_id=2 WHERE id=1");
  env.TELEGRAM_BOT_TOKEN = "test-bot-token";
  const calls = [], original = globalThis.fetch; t.after(() => globalThis.fetch = original);
  globalThis.fetch = async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return Response.json({ ok: true, result: { message_id: 701 } }); };
  await webhook("TEST EARTH003\nAgent: ESS-AG1-EARTH003-NAGAD\nRef: 75X8NCTO\nAmount: 2900\nCustomer: Private");
  const detail = await (await request("/api/cases/1", {}, 1)).json();
  assert.deepEqual(detail.response_definition, { type: "YES_NO", options: ["YES", "NO"] });
  assert.equal("destination_group_name" in detail, false);
  const response = await request("/api/cases/1/respond", { method: "POST", body: JSON.stringify({ response: "yes" }) }, 1);
  assert.equal(response.status, 200); assert.equal((await response.json()).response_status, "SENT");
  assert.equal(calls.length, 1); assert.equal(calls[0].body.chat_id, "-2001");
  assert.equal(calls[0].body.text, "Shop Name: EARTH3\nWallet Type: Nagad\nAmount: 2900\nReference: 75X8NCTO\nStatus: Yes");
  assert.equal(calls[0].body.text.includes("Test Sender"), false);
  const saved = sqlite.prepare("SELECT * FROM responses WHERE case_id=1").get();
  assert.equal(saved.status, "SENT"); assert.equal(saved.response_type, "YES"); assert.equal(saved.response_text, "YES"); assert.equal(saved.telegram_response_message_id, 701); assert.ok(saved.sent_at);
  const after = await (await request("/api/cases/1", {}, 1)).json(); assert.equal("destination_chat_id" in after.responses[0], false);
  const item = sqlite.prepare("SELECT status,answered_at FROM cases WHERE id=1").get();
  assert.equal(item.status, "ANSWERED"); assert.ok(item.answered_at);
  const audit = sqlite.prepare("SELECT * FROM audit_logs WHERE action='CASE_RESPONSE_SENT'").get();
  assert.equal(audit.user_id, 1); assert.equal(audit.case_id, 1); assert.equal(JSON.parse(audit.metadata).destination_group_name, "EARTH Responses");
  assert.equal((await request("/api/cases/1/respond", { method: "POST", body: JSON.stringify({ response: "YES" }) }, 1)).status, 409);
  assert.equal(calls.length, 1);
});

test("outbound Telegram format parses shops, wallets, amount, reference, and statuses", () => {
  const source = (shop, wallet) => `1st Follow Up\nDeposit\nAgent: ESS-AG1-${shop}-${wallet}\nRef: 75X8NCTO\nAmount: 2900\nCustomer: Private`;
  assert.equal(formatTelegramResponse("EARTH020", source("EARTH020", "NAGAD"), "YES — RECEIVED"), "Shop Name: EARTH20\nWallet Type: Nagad\nAmount: 2900\nReference: 75X8NCTO\nStatus: YES Received");
  assert.match(formatTelegramResponse("EARTH003", source("EARTH003", "BK"), "NO — NOT RECEIVED"), /Shop Name: EARTH3\nWallet Type: Bkash/);
  assert.match(formatTelegramResponse("EARTH003", source("EARTH003", "RK"), "NEED VIDEO PROOF"), /Wallet Type: Rocket[\s\S]*Status: Need Video Proof/);
  assert.match(formatTelegramResponse("SHAKER012", source("SHAKER012", "BKASH"), "INCORRECT AMOUNT"), /Shop Name: SHAKER12\nWallet Type: Bkash[\s\S]*Status: Incorrect Amount/);
  assert.match(formatTelegramResponse("SHAKER012", source("SHAKER012", "ROCKET"), "INCORRECT REFERENCE"), /Wallet Type: Rocket[\s\S]*Status: Incorrect Reference/);
  assert.match(formatTelegramResponse("EARTH020", source("EARTH020", "MOBILE_WALLET"), "INCORRECT WALLET"), /Wallet Type: Mobile Wallet[\s\S]*Status: Incorrect Wallet/);
});

test("response authorization and configured values are enforced", async t => {
  const { request, webhook, sqlite, env } = fixture(t);
  sqlite.exec("INSERT INTO telegram_groups VALUES (2, '-2001', 'Responses', 'DESTINATION', 1); UPDATE rules SET response_type='YES_NO', response_config='[\"APPROVE\",\"DECLINE\"]', destination_group_id=2 WHERE id=1");
  env.TELEGRAM_BOT_TOKEN = "test-bot-token";
  const original = globalThis.fetch; t.after(() => globalThis.fetch = original); let sends = 0;
  globalThis.fetch = async () => { sends++; return Response.json({ ok: true, result: { message_id: 1 } }); };
  await webhook("TEST EARTH003");
  assert.equal((await request("/api/cases/1/respond", { method: "POST", body: JSON.stringify({ response: "YES" }) }, 1)).status, 400);
  assert.equal((await request("/api/cases/1/respond", { method: "POST", body: JSON.stringify({ response: "APPROVE" }) }, 2)).status, 404);
  assert.equal((await request("/api/cases/1/respond", { method: "POST", body: JSON.stringify({ response: "APPROVE" }) }, 4)).status, 403);
  sqlite.exec("UPDATE users SET is_active=0 WHERE id=1");
  assert.equal((await request("/api/cases/1/respond", { method: "POST", body: JSON.stringify({ response: "APPROVE" }) }, 1)).status, 401);
  assert.equal(sends, 0); assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM responses").get().n, 0);
});

test("missing or inactive destination configuration fails without a send", async t => {
  const { request, webhook, sqlite, env } = fixture(t);
  env.TELEGRAM_BOT_TOKEN = "test-bot-token";
  const original = globalThis.fetch; t.after(() => globalThis.fetch = original); let sends = 0;
  globalThis.fetch = async () => { sends++; return Response.json({ ok: true, result: { message_id: 1 } }); };
  await webhook("TEST EARTH003");
  sqlite.exec("UPDATE rules SET response_type='YES_NO', destination_group_id=NULL WHERE id=1");
  assert.equal((await request("/api/cases/1/respond", { method: "POST", body: JSON.stringify({ response: "YES" }) }, 1)).status, 409);
  sqlite.exec("UPDATE rules SET destination_group_id=99 WHERE id=1");
  assert.equal((await request("/api/cases/1/respond", { method: "POST", body: JSON.stringify({ response: "YES" }) }, 1)).status, 409);
  sqlite.exec("INSERT INTO telegram_groups VALUES (2, '-2001', 'Inactive', 'DESTINATION', 0); UPDATE rules SET destination_group_id=2 WHERE id=1");
  assert.equal((await request("/api/cases/1/respond", { method: "POST", body: JSON.stringify({ response: "YES" }) }, 1)).status, 409);
  assert.equal(sends, 0); assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM responses").get().n, 0); assert.equal(sqlite.prepare("SELECT status FROM cases WHERE id=1").get().status, "OPEN");
});

test("Telegram failure is recorded as failed and does not answer the case", async t => {
  const { request, webhook, sqlite, env } = fixture(t);
  sqlite.exec("INSERT INTO telegram_groups VALUES (2, '-2001', 'Responses', 'DESTINATION', 1); UPDATE rules SET response_type='YES_NO', destination_group_id=2 WHERE id=1");
  env.TELEGRAM_BOT_TOKEN = "test-bot-token";
  const original = globalThis.fetch; t.after(() => globalThis.fetch = original);
  globalThis.fetch = async () => Response.json({ ok: false, description: "test rejection" }, { status: 400 });
  await webhook("TEST EARTH003");
  const response = await request("/api/cases/1/respond", { method: "POST", body: JSON.stringify({ response: "NO" }) }, 1);
  assert.equal(response.status, 502); assert.equal((await response.json()).error, "TELEGRAM_SEND_FAILED");
  const saved = sqlite.prepare("SELECT response_type,response_text,status,error_message,sent_at FROM responses").get();
  assert.equal(saved.response_type, "NO"); assert.equal(saved.response_text, "NO");
  assert.equal(saved.status, "FAILED"); assert.equal(saved.error_message, "Telegram rejected request (HTTP 400)"); assert.equal(saved.sent_at, null);
  assert.equal(sqlite.prepare("SELECT status FROM cases WHERE id=1").get().status, "OPEN");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='CASE_RESPONSE_SENT'").get().n, 0);
});

test("different rules resolve different Telegram destination groups", async t => {
  const { request, webhook, sqlite, env } = fixture(t);
  sqlite.exec("INSERT INTO telegram_groups VALUES (2, '-2001', 'EARTH Responses', 'DESTINATION', 1); INSERT INTO telegram_groups VALUES (3, '-3001', 'SHAKER Responses', 'DESTINATION', 1); UPDATE rules SET response_type='YES_NO', destination_group_id=2 WHERE id=1; INSERT INTO rules VALUES (2, 'SHAKER Message', 'CONTAINS', 'SHAKER', 'YES_NO', NULL, 3, 20, 1)");
  env.TELEGRAM_BOT_TOKEN = "test-bot-token";
  const chats = [], original = globalThis.fetch; t.after(() => globalThis.fetch = original);
  globalThis.fetch = async (_url, options) => { chats.push(JSON.parse(options.body).chat_id); return Response.json({ ok: true, result: { message_id: 800 + chats.length } }); };
  await webhook("TEST EARTH003"); await webhook("SHAKER EARTH003");
  assert.equal((await request("/api/cases/1/respond", { method: "POST", body: JSON.stringify({ response: "YES" }) }, 1)).status, 200);
  assert.equal((await request("/api/cases/2/respond", { method: "POST", body: JSON.stringify({ response: "NO" }) }, 1)).status, 200);
  assert.deepEqual(chats, ["-2001", "-3001"]);
  const adminDetail = await (await request("/api/cases/2")).json(); assert.equal(adminDetail.destination_group_name, "SHAKER Responses");
});

test("all six rule-specific choices satisfy the production response type constraint", async t => {
  const { request, webhook, sqlite, env } = fixture(t);
  const choices = ["YES — RECEIVED", "NO — NOT RECEIVED", "NEED VIDEO PROOF", "INCORRECT AMOUNT", "INCORRECT REFERENCE", "INCORRECT WALLET"];
  sqlite.prepare("INSERT INTO telegram_groups VALUES (2, '-2001', 'Deposit Responses', 'DESTINATION', 1)").run();
  sqlite.prepare("UPDATE rules SET rule_name='1st Follow Up - Deposit', response_type='YES_NO', response_config=?, destination_group_id=2 WHERE id=1").run(JSON.stringify(choices));
  env.TELEGRAM_BOT_TOKEN = "test-bot-token";
  const original = globalThis.fetch; t.after(() => globalThis.fetch = original);
  let telegramMessageId = 900;
  globalThis.fetch = async () => Response.json({ ok: true, result: { message_id: ++telegramMessageId } });
  await webhook("TEST EARTH003");
  const detail = await (await request("/api/cases/1", {}, 1)).json();
  assert.deepEqual(detail.response_definition.options, choices);
  for (const [index, choice] of choices.entries()) {
    if (index) await webhook("TEST EARTH003");
    const caseId = index + 1;
    const response = await request(`/api/cases/${caseId}/respond`, { method: "POST", body: JSON.stringify({ response: choice }) }, 1);
    assert.equal(response.status, 200);
    const saved = sqlite.prepare("SELECT response_type,response_text FROM responses WHERE case_id=?").get(caseId);
    assert.equal(saved.response_type, "TEXT");
    assert.equal(saved.response_text, choice);
    assert.equal(sqlite.prepare("SELECT new_value FROM audit_logs WHERE case_id=? AND action='CASE_RESPONSE_SENT'").get(caseId).new_value, choice);
  }
});

test("response finalization failures return a safe diagnostic and remain retry-blocked", async t => {
  const { request, webhook, sqlite, env } = fixture(t);
  sqlite.exec("INSERT INTO telegram_groups VALUES (2, '-2001', 'Responses', 'DESTINATION', 1); UPDATE rules SET response_type='YES_NO', destination_group_id=2 WHERE id=1");
  env.TELEGRAM_BOT_TOKEN = "test-bot-token";
  const original = globalThis.fetch; t.after(() => globalThis.fetch = original); let sends = 0;
  globalThis.fetch = async () => { sends++; return Response.json({ ok: true, result: { message_id: 902 } }); };
  await webhook("TEST EARTH003");
  sqlite.exec("CREATE TRIGGER reject_response_audit BEFORE INSERT ON audit_logs WHEN NEW.action='CASE_RESPONSE_SENT' BEGIN SELECT RAISE(ABORT, 'test finalization failure'); END");
  let response = await request("/api/cases/1/respond", { method: "POST", body: JSON.stringify({ response: "YES" }) }, 1);
  assert.equal(response.status, 500); assert.equal((await response.json()).error, "RESPONSE_FINALIZATION_FAILED");
  const saved = sqlite.prepare("SELECT status,error_message FROM responses").get();
  assert.equal(saved.status, "PENDING"); assert.equal(saved.error_message, "Response finalization failed");
  assert.equal(sqlite.prepare("SELECT status FROM cases WHERE id=1").get().status, "OPEN");
  response = await request("/api/cases/1/respond", { method: "POST", body: JSON.stringify({ response: "YES" }) }, 1);
  assert.equal(response.status, 409); assert.equal(sends, 1);
});
