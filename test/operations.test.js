import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import worker from "../src/index.js";

// Disposable, in-memory test double ONLY. These minimal column definitions come
// from the supplied schemas/baseline queries; they are not production migrations.
// Types/defaults not supplied for cases/users are fixture choices, not assertions
// about production constraints. audit_logs and responses use the supplied DDL.
function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, password_hash TEXT, is_active INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE telegram_groups (id INTEGER PRIMARY KEY, telegram_chat_id TEXT, group_name TEXT, group_type TEXT, is_active INTEGER);
    CREATE TABLE rules (id INTEGER PRIMARY KEY, rule_name TEXT, match_type TEXT, match_pattern TEXT, response_type TEXT, response_config TEXT, destination_group_id INTEGER, priority INTEGER, is_active INTEGER);
    CREATE TABLE shop_assignments (shop_code TEXT, assigned_user_id INTEGER, is_active INTEGER);
    CREATE TABLE cases (id INTEGER PRIMARY KEY, source_group_id INTEGER, source_chat_id TEXT, source_message_id INTEGER, source_sender_id TEXT, source_sender_name TEXT, raw_message TEXT, shop_code TEXT, matched_rule_id INTEGER, assigned_user_id INTEGER, status TEXT, received_at TEXT, assigned_at TEXT, answered_at TEXT, closed_at TEXT, created_at TEXT, updated_at TEXT, UNIQUE(source_chat_id, source_message_id));
    CREATE TABLE case_messages (case_id INTEGER, telegram_chat_id TEXT, telegram_message_id INTEGER, sender_telegram_id TEXT, sender_name TEXT, message_type TEXT, message_text TEXT, raw_payload TEXT);
    CREATE TABLE audit_logs (id INTEGER PRIMARY KEY, user_id INTEGER NULL, case_id INTEGER NULL, action TEXT NOT NULL, entity_type TEXT NULL, entity_id TEXT NULL, old_value TEXT NULL, new_value TEXT NULL, metadata TEXT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE responses (id INTEGER PRIMARY KEY, case_id INTEGER NOT NULL, user_id INTEGER NOT NULL, response_type TEXT NOT NULL, response_text TEXT NULL, destination_chat_id TEXT NOT NULL, telegram_response_message_id INTEGER NULL, status TEXT NOT NULL DEFAULT 'PENDING', error_message TEXT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, sent_at TEXT NULL);
    INSERT INTO users (id, username, display_name, role, is_active, password_hash) VALUES (1, 'test_agent', 'Test Agent', 'AGENT', 1, 'test-only-hash'), (2, 'second', 'Second Agent', 'AGENT', 1, 'test-only-hash'), (3, 'inactive', 'Inactive Agent', 'AGENT', 0, 'test-only-hash'), (4, 'admin', 'Admin', 'ADMIN', 1, 'test-only-hash');
    INSERT INTO telegram_groups VALUES (1, '-1003878565041', 'EARTH DP ESCALATION', 'SOURCE', 1);
    INSERT INTO rules VALUES (1, 'TEST Shop Message', 'CONTAINS', 'TEST', NULL, NULL, NULL, 10, 1);
    INSERT INTO shop_assignments VALUES ('EARTH003', 1, 1);
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
  const env = { DB, TELEGRAM_WEBHOOK_SECRET: "local-test-only" };
  const request = (path, init) => worker.fetch(new Request(`https://example.test${path}`, init), env);
  const assignment = (id, user_id) => request(`/api/cases/${id}/assign`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user_id }) });
  let messageId = 0;
  const webhook = (text, extra = {}) => request("/telegram/webhook", {
    method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": env.TELEGRAM_WEBHOOK_SECRET },
    body: JSON.stringify({ message: { chat: { id: -1003878565041 }, message_id: ++messageId, text, from: { id: 7, first_name: "Test", last_name: "Sender" }, ...extra } })
  });
  return { sqlite, env, request, assignment, webhook };
}

test("original ingestion source is byte-identical after removing only routing integration", () => {
  const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8").replace(/\r\n/g, "\n")
    .replace('import { handleOperations } from "./operations.js";\n\n', "")
    .replace('const operationsResponse = await handleOperations(request, env, url);\nif (operationsResponse) return operationsResponse;\n', "");
  assert.equal(createHash("sha256").update(source).digest("hex"), "70007cdb8bce382dcec11e55f2c503d00629273252179f9eccfc3df96a0861ae");
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
  assert.equal(summary.active_agents, 2); assert.equal(summary.active_shop_assignments, 1);
  const list = await (await request("/api/cases")).json();
  assert.deepEqual(list.cases.map(row => row.id), [2, 1]); assert.equal(list.cases[0].received_at, null);
  const filtered = await (await request("/api/cases?status=OPEN&assigned_user_id=1&shop_code=earth003")).json();
  assert.equal(filtered.cases.length, 1); assert.equal(filtered.cases[0].assigned_agent_display_name, "Test Agent");
  assert.equal((await (await request("/api/cases?shop_code=" + encodeURIComponent("' OR 1=1 --"))).json()).cases.length, 0);
  const agents = await (await request("/api/agents")).json();
  assert.deepEqual(agents.agents.map(row => row.id), [2, 1]);
  assert.deepEqual(Object.keys(agents.agents[0]).sort(), ["display_name", "id", "is_active", "role", "username"]);
  assert.equal((await (await request("/api/shop-assignments")).json()).shop_assignments[0].agent_display_name, "Test Agent");
  const detail = await (await request("/api/cases/1")).json();
  assert.equal(detail.case.raw_message, "TEST EARTH003"); assert.equal(detail.case_messages.length, 1);
  assert.equal(detail.audit_logs.length, 1); assert.equal(detail.matched_rule.rule_name, "TEST Shop Message");
  assert.equal(detail.responses_available, true); assert.equal(detail.warnings.length, 0);
  assert.equal("password_hash" in detail.assigned_agent, false);
  assert.equal(JSON.stringify(detail).includes("test-only-hash"), false);
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
  assert.equal(audit.user_id, null); assert.equal(JSON.parse(audit.metadata).previous_assigned_user_id, 1);
  assert.equal(JSON.parse(audit.metadata).assigned_user_id, 2);
  assert.deepEqual(JSON.parse(audit.old_value), { assigned_user_id: 1, assigned_at: previousAssignedAt, status: "CLOSED" });
  assert.deepEqual(JSON.parse(audit.new_value), { assigned_user_id: 2, assigned_at: row.assigned_at, status: "CLOSED" });
  assert.equal(sqlite.prepare("SELECT assigned_user_id FROM shop_assignments").get().assigned_user_id, 1);
  assert.equal((await (await request("/api/dashboard/summary")).json()).closed, 1);
});

test("invalid assignments and invalid routing never write data", async t => {
  const { request, assignment, webhook, sqlite } = fixture(t);
  await webhook("TEST EARTH999");
  for (const id of [3, 4, 99, 0, -1, 1.5, "1", null]) assert.equal((await assignment(1, id)).status, 400);
  assert.equal((await assignment(999, 1)).status, 404);
  assert.equal((await request("/api/cases/1/assign", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" })).status, 400);
  assert.equal((await request("/api/cases/1/assign", { method: "POST", body: "{}" })).status, 415);
  assert.equal((await request("/api/cases/1/assign")).status, 405);
  assert.equal((await request("/api/cases", { method: "POST" })).status, 405);
  assert.equal((await request("/api/cases/999")).status, 404);
  assert.equal((await request("/api/cases/0")).status, 400);
  assert.equal((await request("/api/not-real")).status, 404);
  assert.equal((await request("/api/cases?assigned_user_id=abc")).status, 400);
  assert.equal((await request("/api/cases?before_id=-1")).status, 400);
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
  assert.equal((await assignment(1, 1)).status, 409);
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

test("pagination stays bounded with a stable ID cursor", async t => {
  const { request, sqlite } = fixture(t);
  const insert = sqlite.prepare("INSERT INTO cases (status) VALUES ('OPEN')");
  for (let i = 0; i < 105; i++) insert.run();
  const first = await (await request("/api/cases")).json();
  assert.equal(first.cases.length, 100); assert.equal(first.next_before_id, 6);
  const second = await (await request(`/api/cases?before_id=${first.next_before_id}`)).json();
  assert.equal(second.cases.length, 5); assert.equal(second.next_before_id, null);
});

test("dashboard asset routing and API failures are isolated from legacy routes", async t => {
  const { request, env } = fixture(t);
  env.ASSETS = { fetch: async request => new Response(new URL(request.url).pathname) };
  const dashboard = await request("/dashboard");
  assert.equal(await dashboard.text(), "/dashboard/index.html");
  assert.match(dashboard.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
  assert.equal((await request("/dashboard", { method: "POST" })).status, 405);
  env.DB.prepare = () => { throw new Error("test database failure"); };
  const response = await request("/api/agents");
  assert.equal(response.status, 500); assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal((await response.json()).error, "OPERATIONS_FAILED");
  assert.equal((await request("/")).status, 200);
});
