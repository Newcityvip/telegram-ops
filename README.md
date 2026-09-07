# Telegram operations Worker

Cloudflare Worker `telegram-ops-api` receives Telegram updates and uses the existing
D1 database `telegram-ops-db` through binding `DB`. The baseline is intended to
keep request handling in `src/index.js`; dashboard and additional API development
are future work.

`src/index.js` contains the supplied deployed POC implementation. Only Markdown
code fences and escaped underscores from the pasted source were removed; SQL and
request-processing logic are preserved. No schema has been inferred.

## Local setup

1. Install a current Node.js LTS release and run `npm install`.
2. Keep the existing D1 database ID placeholder until configuring deployment.
3. Create an ignored `.dev.vars` file with local `NAME=value` entries for the two
   names in `.dev.vars.example`. That example is a names-only inventory, not a
   ready-to-use dotenv file. Never commit secret values.
4. Run `npm run check` for JavaScript syntax and `npm run build` for a dry-run
   bundle. Neither command deploys the Worker.
5. Run `npm run dev` for local development. D1 is local; it does not contain the
   production schema or data. Database-dependent tests require an independently
   supplied copy of the exact existing schema and local fixtures. This repository
   does not create tables, migrations, or test records.

## Existing verified POC behavior

The following behavior was reported as verified in the existing deployment; it
is preserved in the supplied source. Local syntax/build checks do not revalidate
production D1 constraints or production data:

- `GET /` returns JSON health; `GET /db-check` checks D1 and lists tables.
- `POST /telegram/webhook` verifies `X-Telegram-Bot-Api-Secret-Token` against
  `TELEGRAM_WEBHOOK_SECRET` and accepts Telegram messages.
- Only active SOURCE/BOTH entries in `telegram_groups` are processed.
  Unconfigured groups and unmatched messages are safely ignored.
- Active rules run in priority order and support CONTAINS, STARTS_WITH, and REGEX.
- EARTH followed by digits identifies a shop. `shop_assignments` resolves an
  active AGENT user. Mapped cases are OPEN; unmapped cases are UNASSIGNED.
- Duplicate protection uses `source_chat_id` + `source_message_id`, with existing
  database UNIQUE constraints providing final protection against races.
- `case_messages` preserves the original message/update. `audit_logs` records
  CASE_AUTO_ASSIGNED or CASE_CREATED_UNASSIGNED.

Existing tables: `audit_logs`, `case_messages`, `cases`, `inquiries`, `responses`,
`rules`, `shop_assignments`, `telegram_groups`, and `users`. Their definitions are
owned by the existing database and are not reproduced or modified here.

Reported fixtures: source group `-1003878565041` (EARTH DP ESCALATION, row 1);
rule 1 TEST Shop Message (CONTAINS TEST, priority 10); user 1 `test_agent`
(Test Agent, AGENT); EARTH003 maps to user 1. `TEST EARTH003` creates an assigned
OPEN case, `TEST EARTH999` creates an UNASSIGNED case, and `HELLO EARTH003` creates
no case. Duplicate rejection, message preservation, and audit creation were
confirmed in the existing POC. These records are documentation, not seed scripts.

## Deployment configuration (future manual step)

Replace `REPLACE_WITH_EXISTING_D1_DATABASE_ID` with the ID of the existing
`telegram-ops-db`; do not create a replacement database. Confirm the existing
Worker's compatibility date and any compatibility flags before deployment to
preserve runtime behavior. The date in this scaffold is provisional.

`TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` already exist in Cloudflare;
keep their values outside Git. Future deployment requires authorized Cloudflare
credentials and the correct account. `npm run deploy` is an explicit manual
deployment command. No CI deployment integration is configured.

Existing URL: https://telegram-ops-api.mdrobiulislam.workers.dev
Webhook path: `/telegram/webhook`. This setup does not deploy, connect GitHub to
Cloudflare, change the webhook, modify production data, add the real Deposit /
Follow Up rule, or build a dashboard.

Configuration reference: [Cloudflare Wrangler documentation](https://developers.cloudflare.com/workers/wrangler/configuration/).
