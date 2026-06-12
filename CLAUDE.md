# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A standalone end-to-end health check script for the MakeCalls product. Runs on the Hermes server via cron every few days. Catches silent failures (exhausted credits, broken webhooks, failed email delivery) by exercising the real production stack with a real call.

It is **not** part of the main app repo (`callback-ai`) or the marketing site. It lives on its own and talks to the app over HTTP.

## How to run

```bash
npx tsx health-check.ts
```

Secrets are loaded from `~/.hermes/.env` (Hermes) or a local `.env` file (dev). See `.env` for required variables.

## Exit contract

- **Exit 0** — all legs passed. Silent.
- **Exit non-zero** — a leg failed. Always writes `~/health-check-result.json` first so Chuck can parse it and send an alert email.

## The 6 legs

| # | Name | What it does |
|---|------|-------------|
| 1 | CallRequest created | POST `/api/free-trial` (Bearer token) to issue a promo code, then POST `/api/payment/bypass` (debug cookie) to create a CallRequest with landlord_phone set to the responder number |
| 2 | Outbound call placed | POST `/api/schedule` with `callNow: true` — exercises the real scheduling path. Polls DB for `elevenlabs_conversation_id` |
| 3 | Transcript stored | Polls `call_recordings.transcript` via direct DB connection |
| 4 | Claude extraction | Polls `call_recordings.extracted_data` |
| 5 | Results record | Polls `call_requests.results_access_code` + `results_expires_at` |
| 6 | Results email | POST `/api/results/send-email` (smoke test skips auto-send), then checks `results_email_sent_at` and confirms Brevo reports `delivered` |

## The responder

A second Twilio number (+1 978-625-3215) pointed at a TwiML Bin (`EH7646f3c8e2eca80f46e16f40a1203961`):

```xml
<Response>
  <Pause length="5"/>
  <Say>Yes.</Say>
  <Pause length="10"/>
  <Hangup/>
</Response>
```

The 5-second pause lets the smoke test agent finish its opener before "Yes" is spoken. The agent asks "yes or no?" — hears "Yes" — ends the call.

## Smoke test agent

The health check uses `script_template: tuning_smoke_test` (set via direct DB update after bypass creates the row). This uses ElevenLabs agent `agent_4301kncs2drjf4dtkv14b13chz9z` which asks a single yes/no question and ends the call. Benefits:
- Short calls (<30s) don't trigger the "landlord unavailable" reset logic
- No need for real landlord input
- Even if extraction fails, the smoke test marks COMPLETED so legs 5/6 can still be tested

## Cleanup

Cleanup happens at the **start** of each run, not the end: `sweepResidue()` deletes any `CallRequest` rows from earlier runs (matched on the sentinel `property_address = '1 Health Check Lane, Boston, MA 02101'`, cascades to `call_recordings`) plus the synthetic `free_trial_signups` rows (`email LIKE 'token-generated-%@internal'`), then creates this run's fresh row.

This means the **most recent run's row is left as residue** — pass or fail — so a red run is always inspectable in the dashboard/DB, and the next run sweeps it. Doing it at the start (rather than an end-of-run `finally`) guarantees it fires no matter how the previous run exited: clean pass, failed leg, crash, or a hung/killed process. Tradeoff: exactly one synthetic "Test Tenant / Responder Bot" row is always present in the dashboard.

`fail()` throws (caught at the top level, which sets `process.exitCode = 1`) rather than calling `process.exit()`, so the `finally` that closes the DB connection always runs.

## Report format

`~/health-check-result.json`:
```json
{
  "timestamp": "2026-06-09T12:32:02.682Z",
  "passed": true,
  "legs": [
    { "leg": 1, "name": "CallRequest created", "passed": true },
    { "leg": 2, "name": "Outbound call placed", "passed": true },
    { "leg": 3, "name": "Transcript stored", "passed": true },
    { "leg": 4, "name": "Claude extraction", "passed": true },
    { "leg": 5, "name": "Results record", "passed": true },
    { "leg": 6, "name": "Results email", "passed": true }
  ]
}
```

## Key secrets (in ~/.hermes/.env)

| Var | Purpose |
|-----|---------|
| `APP_BASE_URL` | `https://app.makecalls.io` |
| `DB_CONNECTION_URL` | Prod Postgres direct connection |
| `FREE_TRIAL_API_TOKEN` | Bearer token for `/api/free-trial` |
| `DEBUG_SECRET` | Cookie value to enable bypass/debug endpoints |
| `RESPONDER_NUMBER` | `+19786253215` |
| `BREVO_API_KEY` | For delivery confirmation check |
| `RESULTS_RECIPIENT` | _(optional)_ results-email recipient for leg 6. **Must be a real, deliverable mailbox** — a hard bounce permanently blocklists it in Brevo and leg 6 can never pass again. Defaults to `scottblodgett+healthcheck@gmail.com` |
| `RESULTS_TENANT_EMAIL` / `RESULTS_LANDLORD_EMAIL` | _(optional)_ tenant/landlord addresses on the synthetic CallRequest. Same deliverability rule. Default to `+hc-tenant` / `+hc-landlord` Gmail aliases |

## What's next

- Copy repo to Hermes
- Wire into Chuck's cron (runs every few days, alerts on non-zero exit)
