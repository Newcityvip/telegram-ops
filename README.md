# Telegram Ops

Operations dashboard and Telegram ingestion on the existing Cloudflare Worker
`telegram-ops-api`, using D1 binding `DB` -> `telegram-ops-db`.

The staff portal is hosted at https://newcityvip.github.io/telegram-ops/. Its
operational APIs require a short-lived signed Bearer token. No secret is present
in the static frontend.

## Architecture

- `src/index.js`: supplied Telegram POC implementation, with a small routing hook.
  The original health, database check, and webhook code is preserved.
- `src/operations.js`: dashboard routing, read APIs, and manual case assignment.
- `src/users.js`: ADMIN-only account lifecycle APIs and safe audit writes.
- `docs/`: GitHub Pages login and role-aware portal in plain HTML/CSS/JavaScript.
- `src/auth.js`: bcrypt password verification and one-hour HMAC tokens.
- `test/operations.test.js`: in-memory SQLite tests, including a source hash
  check against the verified ingestion baseline.

`GET /dashboard` provides summary cards, status/agent/shop filters, a recent-case
table with older-page loading, and a keyboard-accessible case dialog. Unassigned
cases are highlighted and can be assigned to an active agent. The dialog shows
the original message, source sender, rule, agent, messages, audits, and responses.
Message content is rendered as text, never interpreted as HTML.

## APIs

| Method | Route | Result |
| --- | --- | --- |
| GET | `/` | Existing JSON health response |
| GET | `/db-check` | Existing D1 connectivity and table list |
| POST | `/telegram/webhook` | Existing secret-verified ingestion |
| GET | `/api/dashboard/summary` | Total/status counts, active agents and mappings |
| GET | `/api/cases` | Up to 100 cases, newest ID first, with rule/agent names |
| GET | `/api/cases/:id` | Complete case, rule, public agent fields, messages, responses, audits |
| GET | `/api/agents` | Active AGENT users; only id, username, display name, role, active flag |
| GET | `/api/shop-assignments` | Active mappings joined with agent display names |
| POST | `/api/cases/:id/assign` | Manual assignment/reassignment with audit |
| GET | `/api/auth/session` | Validate a stored token and return the current D1-backed user identity |
| GET | `/api/admin/users` | ADMIN-only safe user list; never returns password hashes |
| POST | `/api/admin/users` | ADMIN-only creation of an ADMIN or AGENT account |
| POST | `/api/admin/users/:id/password` | ADMIN-only bcrypt password reset |
| POST | `/api/admin/users/:id/status` | ADMIN-only activation/deactivation |
| POST | `/api/cases/:id/respond` | Assigned AGENT sends a configured response to the rule destination |
| GET | `/api/followup-groups` | Active logical follow-up group names for authenticated staff |
| GET | `/api/followup-requests` | Own AGENT history or complete ADMIN history |
| GET | `/api/followup-requests/:id` | Scoped read-only follow-up request details |
| POST | `/api/followup-requests/preview` | Validate and render a follow-up without storing or sending it |
| POST | `/api/followup-requests` | Submit and send an authenticated follow-up request |

Case filters: `status`, `assigned_user_id`, `shop_code` (exact match). String
filters are normalized to uppercase. `next_before_id` is the next page cursor;
pass it as `before_id` while retaining filters. Values are parameterized.

Assignment accepts JSON `{"user_id": 1}` and requires an existing case and active
AGENT. It sets `assigned_user_id` and an ISO `assigned_at`, changes UNASSIGNED to
OPEN, and preserves other statuses. Audit insertion and case update use one D1
batch transaction. Actions are `CASE_MANUALLY_ASSIGNED` or `CASE_REASSIGNED`;
`old_value`/`new_value` store JSON snapshots of agent ID, assignment time, and
status; metadata also records previous/new ownership and status. Shop mappings
are never changed by assignment. The UI offers assignment for UNASSIGNED cases;
the API also supports reassignment.

The ADMIN portal includes user management for creating accounts, resetting
passwords, and changing active status. Usernames, display names, roles,
password lengths, and status values are validated by the Worker. Passwords are
bcrypt-hashed before D1 writes and are never returned or audited. ADMIN users
cannot deactivate their own currently authenticated account. Account changes
write `USER_CREATED`, `USER_PASSWORD_RESET`, `USER_ACTIVATED`, or
`USER_DEACTIVATED` audit entries with the acting ADMIN ID. Users are deactivated
instead of deleted so historical references remain intact. Creating an AGENT
does not create or change a shop assignment.

The browser persists only the existing short-lived bearer token so a normal page
reload can restore a session. On every reload, `/api/auth/session` verifies the
token signature and expiry, then reloads the current active user and role from
D1 before showing the portal. Invalid, expired, missing-user, and deactivated-user
sessions are cleared. Logout removes the persisted token immediately. The token
still expires after one hour; no password, role, identity field, or backend secret
is trusted from browser storage.

## Agent responses

An AGENT can respond only to a case currently assigned to that same active D1
user. Case details expose the configured response choices, while Telegram chat
IDs remain server-side. The Worker validates the choice against the matched
rule's `response_type` and `response_config`, follows
`rules.destination_group_id` to an active DESTINATION/BOTH `telegram_groups`
row, and sends through the existing `TELEGRAM_BOT_TOKEN` secret.

The first supported response type is `YES_NO` (also accepting existing `YES/NO`
or `YESNO` spellings). A null/empty `response_config` provides `YES` and `NO`;
an optional JSON string array or `{ "options": [...] }` config can provide two
to ten configured choices. A response begins as `PENDING` to suppress ordinary
double-click/retry sends. Telegram rejection changes it to `FAILED` and leaves
the case unchanged, allowing a retry. Telegram confirmation is followed by one
D1 batch that marks the response `SENT`, changes the case to `ANSWERED`, records
`answered_at`, and writes `CASE_RESPONSE_SENT` audit history. The Telegram text
contains only case ID, shop code, and the selected response; source sender
identity is excluded.

For `1st Follow Up - Deposit`, configure its six choices in D1 rather than in
application code:

```sql
UPDATE rules
SET response_type = 'YES_NO',
    response_config = '["YES — RECEIVED","NO — NOT RECEIVED","NEED VIDEO PROOF","INCORRECT AMOUNT","INCORRECT REFERENCE","INCORRECT WALLET"]'
WHERE id = 2
  AND rule_name = '1st Follow Up - Deposit';
```

Response API failures use safe specific codes for rule configuration,
destination lookup, Telegram delivery, response storage, and finalization.
Telegram delivery failures store a bounded category such as an HTTP status,
without storing response bodies, request URLs, credentials, or secrets. If
Telegram succeeds but the final D1 batch fails, the response remains `PENDING`
to prevent a retry from sending a duplicate message.

Response history keeps the rule/UI type separate from the stored response
category. A literal standard `YES` or `NO` is stored with that same
`responses.response_type`; other configured choices use `TEXT`. In every case,
`responses.response_text` preserves the exact selected choice.

## Follow Up Requests

Authenticated ADMIN and AGENT users can submit independent Off Wallet or Close
Shop requests. The Worker validates all business fields, resolves the selected
active group from `followup_groups`, stores the request as `PENDING`, and sends
it using the existing Telegram bot secret. Successful requests become `SENT`;
delivery failures remain in history as `FAILED` with a safe diagnostic. Agents
see only their own history, while administrators see all requests. Routing chat
IDs and Telegram tags remain server-side.

The portal validates and renders the complete server-formatted message in a
separate review step before submission. Close Shop request type and reason are
required operator-entered text; their examples are placeholders only.

## Schema compatibility

No production schema or data is created or changed by setup, build, or tests.
No migrations or seed commands are included. Existing tables remain `users`,
`telegram_groups`, `rules`, `shop_assignments`, `cases`, `case_messages`,
`responses`, `inquiries`, and `audit_logs`.

- Queries use columns evidenced in the supplied POC and the supplied cases,
  users, audit_logs, and responses schemas. `received_at` is confirmed; null
  values display a dash. Cases use descending ID order with a stable page cursor.
- `responses.case_id` is confirmed. Detail retains a read-only
  `PRAGMA table_info(responses)` guard for incomplete local fixtures; if absent,
  it returns `responses_available: false` with an explicit warning. No alternative
  key is guessed. Audit and response histories are ordered by their confirmed IDs.
  Message history does not assume additional columns beyond the ingestion SQL.
- Summary includes actual status counts plus OPEN, UNASSIGNED, ANSWERED, CLOSED
  counters (zero when absent). No new status is inserted by summary queries.
- The supplied audit schema defines `action TEXT NOT NULL` without a listed CHECK
  restriction, allowing both manual audit action names. Only supplied schemas and
  baseline queries were validated; the live production schema was not inspected.
  SQL failures roll back the assignment batch. Tests cover failure of either
  statement and an agent becoming inactive before the transaction.

## Local setup and checks

Use Node.js 24 LTS (tests use built-in `node:sqlite`, which may emit an experimental
warning). Run `npm ci`, then:

```sh
npm run check
npm test
npm run build
npm run dev
```

`build` is `wrangler deploy --dry-run`; it does not deploy. `dev` uses local D1.
Open `/dashboard` on the local URL. A fresh local D1 has no production schema, so
database APIs report errors until the exact existing schema and local fixtures
are supplied independently. Tests use disposable in-memory fixtures; they are
not a schema specification and never contact production.

If testing the webhook locally, create ignored `.dev.vars` entries with local
`NAME=value` pairs. `.dev.vars.example` lists names only: `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_WEBHOOK_SECRET`. Existing Cloudflare secret values stay outside Git.

## Preserved Telegram behavior

Only active SOURCE/BOTH groups are accepted. Active rules are evaluated by
priority/id using CONTAINS, STARTS_WITH, or REGEX. EARTH followed by digits is
extracted and resolved through an active shop assignment to an active AGENT.
Mapped cases become OPEN; unmapped cases become UNASSIGNED. The original update
is saved in `case_messages` and case creation is audited. Duplicate protection
uses source chat/message IDs and existing UNIQUE constraints. Unconfigured groups
and unmatched messages are ignored.

Reported verified examples: `TEST EARTH003` -> OPEN/user 1; `TEST EARTH999` ->
UNASSIGNED; `HELLO EARTH003` -> no case. The real Follow Up/Deposit message with
EARTH020 matched existing rule 2 and created UNASSIGNED case 4. These are historical
production observations, not seed data or automated production tests.

## Deployment

GitHub `main` is connected to Cloudflare Workers Git deployment for the existing
Worker. Pushing this branch triggers that integration. No manual Wrangler deploy
is needed for this milestone. The D1 ID, compatibility date (`2026-09-07`), and
absence of compatibility flags are preserved. URL:
https://telegram-ops-api.mdrobiulislam.workers.dev/dashboard

No Telegram responses, inquiries, new rules, webhook changes, or database
migrations are implemented here.

GitHub Pages must use **GitHub Actions** as its deployment source under repository
Settings → Pages. The workflow publishes `docs/` without repository secrets.

Production must retain `AUTH_SECRET`, `GSHEET_SYNC_URL`, and
`GSHEET_SYNC_SECRET` as Worker secrets. To prepare an ADMIN password locally, run
`npm run hash-password`, enter a new password of at least 12 characters, copy the
resulting bcrypt string, then execute this manually against the intended D1:

```sql
UPDATE users
SET password_hash = ?, updated_at = CURRENT_TIMESTAMP
WHERE username = ? AND role = 'ADMIN' AND is_active = 1;
```

Bind the generated hash and exact existing admin username; verify exactly one row
changed. Create an ADMIN row manually first only if none exists, supplying the
existing table's required values and the generated hash. No default password is
created by this repository.

References: [D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/)
and [Worker asset bindings](https://developers.cloudflare.com/workers/static-assets/binding/).
