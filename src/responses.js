import { normalizeWalletName } from "./wallets.js";

const validId = (value) => /^\d+$/.test(String(value)) && Number(value) > 0;
const storedResponseType = (selected) => ["YES", "NO"].includes(selected) ? selected : "TEXT";
const responseStatuses = {
  "YES — RECEIVED": "YES Received",
  "NO — NOT RECEIVED": "NO Not Received",
  "NEED VIDEO PROOF": "Need Video Proof",
  "INCORRECT AMOUNT": "Incorrect Amount",
  "INCORRECT REFERENCE": "Incorrect Reference",
  "INCORRECT WALLET": "Incorrect Wallet"
};
const lineValue = (message, label) => String(message || "").match(new RegExp(`^${label}\\s*:\\s*([^\\r\\n]+)`, "im"))?.[1].trim() || null;
const readable = (value) => String(value || "").replace(/[_-]+/g, " ").trim().toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Unknown";

export function parsePaymentDetails(rawMessage) {
  const lines = String(rawMessage || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const compact = lines[0]?.match(/^SSP-AG-((?:EARTH|SHAKER)\d+)-([A-Z]+)-OLD-\d+$/i);
  const compactReference = compact && /^[A-Z0-9]+$/i.test(lines[1] || "") ? lines[1] : null;
  const compactAmount = compact && /^\d+(?:[.,]\d+)?$/.test(lines[2] || "") ? lines[2] : null;
  const agent = lineValue(rawMessage, "Agent");
  const walletCode = agent ? agent.split("-").at(-1).trim().toUpperCase() : compact?.[2] || "";
  return {
    compactShopCode: compact?.[1]?.toUpperCase() || null,
    wallet: normalizeWalletName(walletCode) || (agent ? readable(walletCode) : "Unknown"),
    amount: lineValue(rawMessage, "Amount") || compactAmount || "Not provided",
    reference: lineValue(rawMessage, "Ref") || compactReference || "Not provided"
  };
}

export function formatTelegramResponse(shopCode, rawMessage, selected) {
  const shop = String(shopCode || "Not provided").trim().toUpperCase();
  const { wallet, amount, reference } = parsePaymentDetails(rawMessage);
  const status = responseStatuses[selected] || readable(selected);
  return `Shop Name: ${shop}\nWallet Type: ${wallet}\nAmount: ${amount}\nReference: ${reference}\nStatus: ${status}`;
}

export function responseDefinition(type, config) {
  const normalizedType = String(type || "").trim().toUpperCase();
  if (!["YES_NO", "YES/NO", "YESNO"].includes(normalizedType)) return null;
  if (config == null || String(config).trim() === "") return { type: "YES_NO", options: ["YES", "NO"] };
  try {
    const parsed = typeof config === "string" ? JSON.parse(config) : config;
    const options = Array.isArray(parsed) ? parsed : parsed?.options;
    if (!Array.isArray(options) || options.length < 2 || options.length > 10) return null;
    const clean = options.map((option) => String(option).trim().toUpperCase());
    if (clean.some((option) => !option || option.length > 50) || new Set(clean).size !== clean.length) return null;
    return { type: "YES_NO", options: clean };
  } catch { return null; }
}

export async function respondToCase(request, env, user, caseId) {
  if (user.role !== "AGENT") return { error: "FORBIDDEN", status: 403 };
  if (!validId(caseId)) return { error: "CASE_NOT_FOUND", status: 404 };
  let body;
  try { body = await request.json(); } catch { return { error: "INVALID_JSON", status: 400 }; }

  let item;
  try {
    item = await env.DB.prepare(`
      SELECT c.id, c.shop_code, c.raw_message, c.matched_rule_id, c.assigned_user_id,
        r.response_type, r.response_config, r.destination_group_id
      FROM cases c
      LEFT JOIN rules r ON r.id = c.matched_rule_id
      WHERE c.id = ?
      LIMIT 1
    `).bind(caseId).first();
  } catch { return { error: "RESPONSE_LOOKUP_FAILED", status: 500 }; }
  if (!item || item.assigned_user_id !== user.id) return { error: "CASE_NOT_FOUND", status: 404 };

  const definition = responseDefinition(item.response_type, item.response_config);
  if (!definition) return { error: "RESPONSE_NOT_CONFIGURED", status: 409 };
  const selected = typeof body?.response === "string" ? body.response.trim().toUpperCase() : "";
  if (!definition.options.includes(selected)) return { error: "INVALID_RESPONSE", status: 400 };
  if (!validId(item.destination_group_id)) return { error: "DESTINATION_NOT_CONFIGURED", status: 409 };

  let destination;
  try {
    destination = await env.DB.prepare(`
      SELECT id, telegram_chat_id, group_name
      FROM telegram_groups
      WHERE id = ? AND is_active = 1 AND group_type IN ('DESTINATION', 'BOTH')
      LIMIT 1
    `).bind(item.destination_group_id).first();
  } catch { return { error: "DESTINATION_LOOKUP_FAILED", status: 500 }; }
  if (!destination) return { error: "DESTINATION_UNAVAILABLE", status: 409 };
  if (!env.TELEGRAM_BOT_TOKEN) return { error: "TELEGRAM_NOT_CONFIGURED", status: 503 };

  let claim;
  try {
    claim = await env.DB.prepare(`
      INSERT INTO responses (case_id, user_id, response_type, response_text, destination_chat_id, status)
      SELECT ?, ?, ?, ?, ?, 'PENDING'
      WHERE NOT EXISTS (
        SELECT 1 FROM responses WHERE case_id = ? AND status IN ('PENDING', 'SENT')
      )
    `).bind(caseId, user.id, storedResponseType(selected), selected, destination.telegram_chat_id, caseId).run();
  } catch { return { error: "RESPONSE_STORAGE_FAILED", status: 500 }; }
  if (!claim.meta.changes) return { error: "RESPONSE_ALREADY_SUBMITTED", status: 409 };
  const responseId = Number(claim.meta.last_row_id);
  const message = formatTelegramResponse(item.shop_code, item.raw_message, selected);

  let telegramMessageId, failureReason = "Telegram request failed";
  try {
    const telegram = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: destination.telegram_chat_id, text: message })
    });
    if (!telegram.ok) { failureReason = `Telegram rejected request (HTTP ${telegram.status})`; throw Error(); }
    const result = await telegram.json();
    if (result?.ok !== true || !Number.isSafeInteger(result?.result?.message_id)) { failureReason = "Telegram returned an invalid response"; throw Error(); }
    telegramMessageId = result.result.message_id;
  } catch {
    try { await env.DB.prepare("UPDATE responses SET status = 'FAILED', error_message = ? WHERE id = ? AND status = 'PENDING'").bind(failureReason, responseId).run(); } catch {}
    return { error: "TELEGRAM_SEND_FAILED", status: 502 };
  }

  const sentAt = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare("UPDATE responses SET status = 'SENT', telegram_response_message_id = ?, sent_at = ?, error_message = NULL WHERE id = ? AND status = 'PENDING'").bind(telegramMessageId, sentAt, responseId),
      env.DB.prepare("UPDATE cases SET status = 'ANSWERED', answered_at = ?, updated_at = ? WHERE id = ? AND assigned_user_id = ?").bind(sentAt, sentAt, caseId, user.id),
      env.DB.prepare("INSERT INTO audit_logs (user_id, case_id, action, entity_type, entity_id, new_value, metadata) VALUES (?, ?, 'CASE_RESPONSE_SENT', 'RESPONSE', ?, ?, ?)")
        .bind(user.id, caseId, String(responseId), selected, JSON.stringify({ matched_rule_id: item.matched_rule_id, destination_group_id: destination.id, destination_group_name: destination.group_name, telegram_message_id: telegramMessageId }))
    ]);
  } catch {
    try { await env.DB.prepare("UPDATE responses SET error_message = ? WHERE id = ? AND status = 'PENDING'").bind("Response finalization failed", responseId).run(); } catch {}
    return { error: "RESPONSE_FINALIZATION_FAILED", status: 500 };
  }
  return { ok: true, response_id: responseId, response: selected, response_status: "SENT" };
}
