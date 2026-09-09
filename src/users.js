import { hash } from "bcryptjs";

const USER_COLUMNS = "id, username, display_name, role, is_active, created_at";
const validId = (value) => /^\d+$/.test(String(value)) && Number(value) > 0;

function validateIdentity(body) {
  const username = typeof body?.username === "string" ? body.username.trim() : "";
  const displayName = typeof body?.display_name === "string" ? body.display_name.trim() : "";
  const role = typeof body?.role === "string" ? body.role.trim().toUpperCase() : "";
  const password = body?.password;
  const isActive = body?.is_active;

  if (!/^[A-Za-z0-9_.-]{3,50}$/.test(username)) return { error: "INVALID_USERNAME" };
  if (!displayName || displayName.length > 100) return { error: "INVALID_DISPLAY_NAME" };
  if (!["ADMIN", "AGENT"].includes(role)) return { error: "INVALID_ROLE" };
  if (typeof password !== "string" || password.length < 12 || password.length > 128) return { error: "INVALID_PASSWORD" };
  if (typeof isActive !== "boolean") return { error: "INVALID_ACTIVE_STATUS" };
  return { username, displayName, role, password, isActive };
}

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

const safeUser = (user) => ({
  id: user.id,
  username: user.username,
  display_name: user.display_name,
  role: user.role,
  is_active: Boolean(user.is_active),
  created_at: user.created_at
});

export async function handleUsers(request, env, admin, path) {
  if (admin.role !== "ADMIN") return { error: "FORBIDDEN", status: 403 };

  if (path === "/api/admin/users" && request.method === "GET") {
    const result = await env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users ORDER BY id ASC`).all();
    return { ok: true, users: result.results.map(safeUser) };
  }

  if (path === "/api/admin/users" && request.method === "POST") {
    const values = validateIdentity(await readJson(request));
    if (values.error) return { error: values.error, status: 400 };
    const existing = await env.DB.prepare("SELECT id FROM users WHERE username = ? LIMIT 1").bind(values.username).first();
    if (existing) return { error: "USERNAME_EXISTS", status: 409 };
    const passwordHash = await hash(values.password, 12);
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO users (username, display_name, role, password_hash, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)")
          .bind(values.username, values.displayName, values.role, passwordHash, values.isActive ? 1 : 0),
        env.DB.prepare("INSERT INTO audit_logs (user_id, action, entity_type, entity_id, new_value, metadata) SELECT ?, 'USER_CREATED', 'USER', CAST(id AS TEXT), ?, ? FROM users WHERE username = ?")
          .bind(admin.id, JSON.stringify({ username: values.username, display_name: values.displayName, role: values.role, is_active: values.isActive }), JSON.stringify({ source: "PORTAL" }), values.username)
      ]);
    } catch (error) {
      if (String(error?.message || error).toLowerCase().includes("unique")) return { error: "USERNAME_EXISTS", status: 409 };
      throw error;
    }
    const created = await env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE username = ? LIMIT 1`).bind(values.username).first();
    return { ok: true, user: safeUser(created) };
  }

  const match = path.match(/^\/api\/admin\/users\/(\d+)\/(password|status)$/);
  if (!match || request.method !== "POST" || !validId(match[1])) return { error: "NOT_FOUND", status: 404 };
  const userId = Number(match[1]);
  const target = await env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).bind(userId).first();
  if (!target) return { error: "USER_NOT_FOUND", status: 404 };
  const body = await readJson(request);
  if (!body) return { error: "INVALID_JSON", status: 400 };

  if (match[2] === "password") {
    if (typeof body.password !== "string" || body.password.length < 12 || body.password.length > 128) return { error: "INVALID_PASSWORD", status: 400 };
    const passwordHash = await hash(body.password, 12);
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(passwordHash, userId),
      env.DB.prepare("INSERT INTO audit_logs (user_id, action, entity_type, entity_id, metadata) VALUES (?, 'USER_PASSWORD_RESET', 'USER', ?, ?)").bind(admin.id, String(userId), JSON.stringify({ source: "PORTAL", username: target.username }))
    ]);
    return { ok: true };
  }

  if (typeof body.is_active !== "boolean") return { error: "INVALID_ACTIVE_STATUS", status: 400 };
  if (userId === admin.id && body.is_active === false) return { error: "CANNOT_DEACTIVATE_SELF", status: 409 };
  if (Boolean(target.is_active) === body.is_active) return { ok: true, user: safeUser(target) };
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(body.is_active ? 1 : 0, userId),
    env.DB.prepare("INSERT INTO audit_logs (user_id, action, entity_type, entity_id, old_value, new_value, metadata) VALUES (?, ?, 'USER', ?, ?, ?, ?)")
      .bind(admin.id, body.is_active ? "USER_ACTIVATED" : "USER_DEACTIVATED", String(userId), JSON.stringify({ is_active: Boolean(target.is_active) }), JSON.stringify({ is_active: body.is_active }), JSON.stringify({ source: "PORTAL", username: target.username }))
  ]);
  const updated = { ...target, is_active: body.is_active ? 1 : 0 };
  return { ok: true, user: safeUser(updated) };
}
