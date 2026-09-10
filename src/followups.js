const TYPES = new Set(["OFF_WALLET", "CLOSE_SHOP"]);
const WALLETS = { NAGAD: "Nagad", BK: "Bkash", BKASH: "Bkash", RK: "Rocket", ROCKET: "Rocket" };
const CLOSE_REQUEST_TYPES = new Set(["Request to close this wallet and withdraw all remaining balance"]);
const CLOSE_REASONS = new Set(["This wallet will be replaced with a new agent number"]);
const text = (value, max = 200) => typeof value === "string" && value.trim() && value.trim().length <= max && !/[\r\n]/.test(value) ? value.trim() : null;
const amount = (value) => { const clean = text(value, 50); if (!clean || !/^\d+(?:\.\d{1,2})?$/.test(clean)) return null; const [whole, decimal] = clean.split("."), normalized = whole.replace(/^0+(?=\d)/, ""); return decimal ? `${normalized}.${decimal.replace(/0+$/, "")}`.replace(/\.$/, "") : normalized; };
const wallet = (value) => WALLETS[String(value || "").trim().toUpperCase()] || null;
const safeRequest = (row) => ({ id: row.id, submitted_by: row.submitted_by, request_type: row.request_type, shop_group: row.shop_group, shop_name: row.shop_name, wallet_number: row.wallet_number, wallet_type: row.wallet_type, off_from: row.off_from, current_balance: row.current_balance, b2b_due: row.b2b_due, close_request_type: row.close_request_type, close_reason: row.close_reason, status: row.status, error_message: row.error_message, created_at: row.created_at, sent_at: row.sent_at });

export function formatFollowupMessage(item, tag) {
  if (item.request_type === "OFF_WALLET") return `Shop Name: ${item.shop_name}\nWallet Number: ${item.wallet_number}\nWallet Type: ${item.wallet_type}\nCurrent Balance: ${item.current_balance}\nShop OFF time from: ${item.off_from}\nB2B Due: ${item.b2b_due}\nPls check team ${tag} thanks`;
  return `Shop Name: ${item.shop_name}\nWallet Number: ${item.wallet_number}\nWallet Type: ${item.wallet_type}\nRequest Type: ${item.close_request_type}\nReason: ${item.close_reason}\nPls check team ${tag} thanks`;
}

function validated(body, group) {
  if (!body || typeof body !== "object" || ["user_id", "destination_chat_id", "telegram_tag"].some((key) => Object.prototype.hasOwnProperty.call(body, key))) return null;
  const requestType = String(body.request_type || "").trim().toUpperCase(), shopGroup = String(body.shop_group || "").trim().toUpperCase(), shopName = text(body.shop_name)?.toUpperCase(), walletNumber = text(body.wallet_number, 100), walletType = wallet(body.wallet_type);
  if (!TYPES.has(requestType) || !shopGroup || !shopName || !walletNumber || !walletType || shopGroup !== group.shop_group || !shopName.startsWith(shopGroup)) return null;
  if (requestType === "OFF_WALLET") {
    const offFrom = text(body.off_from, 5), currentBalance = amount(body.current_balance), b2bDue = amount(body.b2b_due);
    if (!offFrom || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(offFrom) || currentBalance === null || b2bDue === null || text(body.close_request_type) || text(body.close_reason)) return null;
    return { request_type: requestType, shop_group: shopGroup, shop_name: shopName, wallet_number: walletNumber, wallet_type: walletType, off_from: offFrom, current_balance: currentBalance, b2b_due: b2bDue, close_request_type: null, close_reason: null };
  }
  const closeType = text(body.close_request_type), reason = text(body.close_reason);
  if (!CLOSE_REQUEST_TYPES.has(closeType) || !CLOSE_REASONS.has(reason) || text(body.off_from) || text(body.current_balance) || text(body.b2b_due)) return null;
  return { request_type: requestType, shop_group: shopGroup, shop_name: shopName, wallet_number: walletNumber, wallet_type: walletType, off_from: null, current_balance: null, b2b_due: null, close_request_type: closeType, close_reason: reason };
}

async function submit(request, env, user) {
  let body; try { body = await request.json(); } catch { return { error: "INVALID_JSON", status: 400 }; }
  const groupName = typeof body?.shop_group === "string" ? body.shop_group.trim().toUpperCase() : "";
  const group = groupName ? await env.DB.prepare("SELECT shop_group,telegram_chat_id,telegram_tag FROM followup_groups WHERE shop_group=? AND is_active=1 LIMIT 1").bind(groupName).first() : null;
  if (!group) return { error: "FOLLOWUP_GROUP_UNAVAILABLE", status: 409 };
  const item = validated(body, group); if (!item) return { error: "INVALID_FOLLOWUP_REQUEST", status: 400 };
  if (!env.TELEGRAM_BOT_TOKEN) return { error: "TELEGRAM_NOT_CONFIGURED", status: 503 };
  let insert;
  try { insert = await env.DB.prepare(`INSERT INTO followup_requests(user_id,request_type,shop_group,shop_name,wallet_number,wallet_type,off_from,current_balance,b2b_due,close_request_type,close_reason,destination_chat_id,telegram_tag,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'PENDING')`).bind(user.id,item.request_type,item.shop_group,item.shop_name,item.wallet_number,item.wallet_type,item.off_from,item.current_balance,item.b2b_due,item.close_request_type,item.close_reason,group.telegram_chat_id,group.telegram_tag).run(); }
  catch { return { error: "FOLLOWUP_STORAGE_FAILED", status: 500 }; }
  const id = Number(insert.meta.last_row_id); let telegramId, failure = "Telegram request failed";
  try { const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: group.telegram_chat_id, text: formatFollowupMessage(item, group.telegram_tag) }) }); if (!response.ok) { failure = `Telegram rejected request (HTTP ${response.status})`; throw Error(); } const result = await response.json(); if (result?.ok !== true || !Number.isSafeInteger(result?.result?.message_id)) { failure = "Telegram returned an invalid response"; throw Error(); } telegramId = result.result.message_id; }
  catch { try { await env.DB.prepare("UPDATE followup_requests SET status='FAILED',error_message=? WHERE id=? AND status='PENDING'").bind(failure,id).run(); } catch {} return { error: "TELEGRAM_SEND_FAILED", status: 502 }; }
  const sentAt = new Date().toISOString();
  try { await env.DB.prepare("UPDATE followup_requests SET status='SENT',telegram_message_id=?,sent_at=?,error_message=NULL WHERE id=? AND status='PENDING'").bind(telegramId,sentAt,id).run(); }
  catch { try { await env.DB.prepare("UPDATE followup_requests SET error_message=? WHERE id=? AND status='PENDING'").bind("Follow-up finalization failed",id).run(); } catch {} return { error: "FOLLOWUP_FINALIZATION_FAILED", status: 500 }; }
  return { ok: true, request_id: id, request_status: "SENT" };
}

async function list(env, user) { const own = user.role === "AGENT" ? " WHERE f.user_id=?" : "", values = user.role === "AGENT" ? [user.id] : []; const rows = await env.DB.prepare(`SELECT f.*,u.display_name submitted_by FROM followup_requests f INNER JOIN users u ON u.id=f.user_id${own} ORDER BY f.id DESC LIMIT 100`).bind(...values).all(); return { ok: true, requests: rows.results.map(safeRequest) }; }
async function detail(env, user, id) { if (!/^\d+$/.test(id)) return { error: "FOLLOWUP_NOT_FOUND", status: 404 }; const own = user.role === "AGENT" ? " AND f.user_id=?" : "", values = user.role === "AGENT" ? [Number(id), user.id] : [Number(id)]; const row = await env.DB.prepare(`SELECT f.*,u.display_name submitted_by FROM followup_requests f INNER JOIN users u ON u.id=f.user_id WHERE f.id=?${own} LIMIT 1`).bind(...values).first(); return row ? { ok: true, request: safeRequest(row) } : { error: "FOLLOWUP_NOT_FOUND", status: 404 }; }

export async function handleFollowups(request, env, user, path) {
  if (path === "/api/followup-groups") { if (request.method !== "GET") return { error: "METHOD_NOT_ALLOWED", status: 405 }; const rows = await env.DB.prepare("SELECT shop_group FROM followup_groups WHERE is_active=1 ORDER BY shop_group").all(); return { ok: true, groups: rows.results.map((row) => row.shop_group) }; }
  if (path === "/api/followup-requests") return request.method === "GET" ? list(env,user) : request.method === "POST" ? submit(request,env,user) : { error: "METHOD_NOT_ALLOWED", status: 405 };
  const match = path.match(/^\/api\/followup-requests\/(\d+)$/); return match && request.method === "GET" ? detail(env,user,match[1]) : { error: "NOT_FOUND", status: 404 };
}
