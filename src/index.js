import { handleOperations } from "./operations.js";

export default {
async fetch(request, env) {
const url = new URL(request.url);
const operationsResponse = await handleOperations(request, env, url);
if (operationsResponse) return operationsResponse;
// =========================================================
// HEALTH CHECK
// =========================================================
if (request.method === "GET" && url.pathname === "/") {
  return Response.json({
    ok: true,
    service: "telegram-ops-api",
    database: "telegram-ops-db"
  });
}

// =========================================================
// DATABASE CHECK
// =========================================================
if (request.method === "GET" && url.pathname === "/db-check") {
  try {
    const result = await env.DB.prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
        AND name NOT LIKE '_cf_%'
      ORDER BY name
    `).all();

    return Response.json({
      ok: true,
      database_connected: true,
      table_count: result.results.length,
      tables: result.results.map((row) => row.name)
    });
  } catch (error) {
    console.error("D1 check failed:", error);

    return Response.json(
      {
        ok: false,
        database_connected: false,
        error: error.message
      },
      { status: 500 }
    );
  }
}

// =========================================================
// TELEGRAM WEBHOOK
// =========================================================
if (
  request.method === "POST" &&
  url.pathname === "/telegram/webhook"
) {
  const telegramSecret = request.headers.get(
    "X-Telegram-Bot-Api-Secret-Token"
  );

  if (
    !telegramSecret ||
    telegramSecret !== env.TELEGRAM_WEBHOOK_SECRET
  ) {
    console.warn("Rejected unauthorized webhook request");

    return Response.json(
      {
        ok: false,
        error: "Unauthorized"
      },
      { status: 401 }
    );
  }

  try {
    const update = await request.json();

    const message =
      update.message ||
      update.channel_post ||
      update.edited_message ||
      update.edited_channel_post;

    if (!message || !message.chat) {
      return Response.json({
        ok: true,
        ignored: true,
        reason: "NO_SUPPORTED_MESSAGE"
      });
    }

    // OWN BOT LOOP GUARD
    const configuredBotId = getConfiguredBotId(env.TELEGRAM_BOT_TOKEN);

    if (
      configuredBotId &&
      message.from?.id != null &&
      String(message.from.id) === configuredBotId
    ) {
      return Response.json({
        ok: true,
        ignored: true,
        reason: "OWN_BOT_MESSAGE"
      });
    }
    // END OWN BOT LOOP GUARD

    const chatId = String(message.chat.id);
    const messageId = message.message_id;

    const messageText = String(
      message.text || message.caption || ""
    ).trim();

    // 1. SOURCE GROUP VALIDATION
    const sourceGroup = await env.DB.prepare(`
      SELECT
        id,
        telegram_chat_id,
        group_name,
        group_type
      FROM telegram_groups
      WHERE telegram_chat_id = ?
        AND is_active = 1
        AND group_type IN ('SOURCE', 'BOTH')
      LIMIT 1
    `)
      .bind(chatId)
      .first();

    if (!sourceGroup) {
      console.log(
        `Ignored message ${messageId}: unconfigured source group ${chatId}`
      );

      return Response.json({
        ok: true,
        ignored: true,
        reason: "UNCONFIGURED_SOURCE_GROUP"
      });
    }

    // 2. DUPLICATE CHECK
    const existingCase = await env.DB.prepare(`
      SELECT id
      FROM cases
      WHERE source_chat_id = ?
        AND source_message_id = ?
      LIMIT 1
    `)
      .bind(chatId, messageId)
      .first();

    if (existingCase) {
      console.log(
        `Duplicate Telegram message ignored. Existing case: ${existingCase.id}`
      );

      return Response.json({
        ok: true,
        duplicate: true,
        case_id: existingCase.id
      });
    }

    // 3. LOAD ACTIVE RULES
    const ruleResult = await env.DB.prepare(`
      SELECT
        id,
        rule_name,
        match_type,
        match_pattern,
        response_type,
        response_config,
        destination_group_id,
        priority
      FROM rules
      WHERE is_active = 1
      ORDER BY priority ASC, id ASC
    `).all();

    let matchedRule = null;

    for (const rule of ruleResult.results) {
      if (
        ruleMatches(
          ruleMatchingText(messageText),
          rule.match_type,
          rule.match_pattern
        )
      ) {
        matchedRule = rule;
        break;
      }
    }

    if (!matchedRule) {
      console.log(
        `Ignored message ${messageId}: no active rule matched`
      );

      return Response.json({
        ok: true,
        ignored: true,
        reason: "NO_MATCHING_RULE"
      });
    }

    // 4. EXTRACT SHOP CODE
    const shopCode = extractShopCode(messageText);

    // 5. RESOLVE SHOP -> AGENT
    let assignedUserId = null;

    if (shopCode) {
      const assignment = await env.DB.prepare(`
        SELECT
          sa.assigned_user_id
        FROM shop_assignments sa
        INNER JOIN users u
          ON u.id = sa.assigned_user_id
        WHERE UPPER(sa.shop_code) = ?
          AND sa.is_active = 1
          AND u.is_active = 1
          AND u.role = 'AGENT'
        LIMIT 1
      `)
        .bind(shopCode)
        .first();

      if (assignment) {
        assignedUserId = assignment.assigned_user_id;
      }
    }

    const caseStatus = assignedUserId
      ? "OPEN"
      : "UNASSIGNED";

    // 6. TELEGRAM SENDER DETAILS
    const senderId = message.from?.id
      ? String(message.from.id)
      : null;

    const senderName = buildSenderName(message.from);

    // 7. CREATE CASE
    let caseInsert;

    try {
      caseInsert = await env.DB.prepare(`
        INSERT INTO cases (
          source_group_id,
          source_chat_id,
          source_message_id,
          source_sender_id,
          source_sender_name,
          raw_message,
          shop_code,
          matched_rule_id,
          assigned_user_id,
          status,
          assigned_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
        .bind(
          sourceGroup.id,
          chatId,
          messageId,
          senderId,
          senderName,
          messageText,
          shopCode,
          matchedRule.id,
          assignedUserId,
          caseStatus,
          assignedUserId
            ? new Date().toISOString()
            : null
        )
        .run();
    } catch (error) {
      if (
        String(error.message || error)
          .toLowerCase()
          .includes("unique")
      ) {
        const duplicate = await env.DB.prepare(`
          SELECT id
          FROM cases
          WHERE source_chat_id = ?
            AND source_message_id = ?
          LIMIT 1
        `)
          .bind(chatId, messageId)
          .first();

        return Response.json({
          ok: true,
          duplicate: true,
          case_id: duplicate?.id || null
        });
      }

      throw error;
    }

    const caseId = Number(caseInsert.meta.last_row_id);

    // 8. PRESERVE ORIGINAL TELEGRAM MESSAGE
    await env.DB.prepare(`
      INSERT INTO case_messages (
        case_id,
        telegram_chat_id,
        telegram_message_id,
        sender_telegram_id,
        sender_name,
        message_type,
        message_text,
        raw_payload
      )
      VALUES (?, ?, ?, ?, ?, 'SOURCE', ?, ?)
    `)
      .bind(
        caseId,
        chatId,
        messageId,
        senderId,
        senderName,
        messageText,
        JSON.stringify(update)
      )
      .run();

    // 9. AUDIT
    await env.DB.prepare(`
      INSERT INTO audit_logs (
        user_id,
        case_id,
        action,
        entity_type,
        entity_id,
        new_value,
        metadata
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
      .bind(
        assignedUserId,
        caseId,
        assignedUserId
          ? "CASE_AUTO_ASSIGNED"
          : "CASE_CREATED_UNASSIGNED",
        "CASE",
        String(caseId),
        caseStatus,
        JSON.stringify({
          shop_code: shopCode,
          matched_rule_id: matchedRule.id,
          matched_rule_name: matchedRule.rule_name,
          source_group_id: sourceGroup.id,
          telegram_chat_id: chatId,
          telegram_message_id: messageId
        })
      )
      .run();

    console.log(
      JSON.stringify({
        event: "CASE_CREATED",
        case_id: caseId,
        shop_code: shopCode,
        assigned_user_id: assignedUserId,
        status: caseStatus,
        rule: matchedRule.rule_name
      })
    );

    return Response.json({
      ok: true,
      created: true,
      case_id: caseId,
      shop_code: shopCode,
      assigned_user_id: assignedUserId,
      status: caseStatus,
      matched_rule: matchedRule.rule_name
    });
  } catch (error) {
    console.error("Telegram processing error:", error);

    return Response.json(
      {
        ok: false,
        error: "PROCESSING_FAILED"
      },
      { status: 500 }
    );
  }
}

return new Response("Not Found", {
  status: 404
});
}
};

function ruleMatches(text, matchType, pattern) {
if (!text || !pattern) {
return false;
}

const normalizedText = text.toLowerCase();
const normalizedPattern = String(pattern).toLowerCase();

switch (String(matchType).toUpperCase()) {
case "CONTAINS":
return normalizedText.includes(normalizedPattern);
case "STARTS_WITH":
  return normalizedText.startsWith(normalizedPattern);

case "REGEX":
  try {
    return new RegExp(pattern, "i").test(text);
  } catch (error) {
    console.error("Invalid REGEX rule:", pattern);
    return false;
  }

default:
  return false;
}
}

function extractShopCode(text) {
if (!text) {
return null;
}

const firstLine = String(text).split(/\r?\n/, 1)[0];
const compactMatch = firstLine.match(/(?:^|-)\s*((?:EARTH|SHAKER)\d+)\s*(?=-|$)/i);
const match = compactMatch || String(text).replace(/https?:\/\/\S+/gi, "").match(/\b(?:EARTH|SHAKER)\d+\b/i);

return match
? (compactMatch ? match[1] : match[0]).toUpperCase()
: null;
}

function ruleMatchingText(text) {
const firstLine = String(text || "").split(/\r?\n/, 1)[0].trim();
const compactFollowUp = /^SSP-AG-(?:EARTH|SHAKER)\d+-(?:NG|NAGAD|BK|BKASH|RK|ROCKET|UPAY)\s*-\s*(?:OLD-)?\d+$/i.test(firstLine);
return compactFollowUp ? `1st Follow Up\nDeposit\n${text}` : text;
}

function buildSenderName(from) {
if (!from) {
return null;
}

const fullName = [
from.first_name,
from.last_name
]
.filter(Boolean)
.join(" ")
.trim();

if (fullName) {
return fullName;
}

if (from.username) {
return `@${from.username}`;
}

return null;
}

// OWN BOT ID HELPER
function getConfiguredBotId(token) {
const match = String(token || "").match(/^([1-9]\d*):/);
return match ? match[1] : null;
}
// END OWN BOT ID HELPER
