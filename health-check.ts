/**
 * MakeCalls end-to-end health check
 * Runs on Hermes via cron. Exit 0 = green (silent). Exit non-zero = red.
 * Always writes ~/health-check-result.json for Chuck to parse and email.
 * Secrets: ~/.hermes/.env
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Client } from 'pg';

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

const envPaths = [
  path.join(os.homedir(), '.hermes', '.env'),
  path.join(__dirname, '.env'),
];
for (const envPath of envPaths) {
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (match) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
}

const APP_URL          = required('APP_BASE_URL');
const DB_URL           = required('DB_CONNECTION_URL');
const FREE_TRIAL_TOKEN = required('FREE_TRIAL_API_TOKEN');
const DEBUG_SECRET     = required('DEBUG_SECRET');
const RESPONDER_NUM    = required('RESPONDER_NUMBER');
const BREVO_API_KEY    = required('BREVO_API_KEY');

function required(name: string): string {
  const v = process.env[name];
  if (!v) { console.error(`Missing env var: ${name}`); process.exit(1); }
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

const RESPONDER_NUM_10 = RESPONDER_NUM.replace(/^\+1/, '');
const REPORT_PATH = path.join(os.homedir(), 'health-check-result.json');

// The results email recipient. MUST be a real, deliverable mailbox: a hard
// bounce puts the address on Brevo's permanent block list, after which every
// send is silently `blocked` and leg 6 can never pass again. Uses +tag aliases
// on a real inbox so nothing bounces and the run mail stays filterable. This is
// also the spec's "lands in your real inbox for manual eyeball when red" backstop.
// Overridable via env (in ~/.hermes/.env); defaults keep existing setups working.
const RESULTS_RECIPIENT  = optional('RESULTS_RECIPIENT', 'scottblodgett+healthcheck@gmail.com');
const TENANT_EMAIL       = optional('RESULTS_TENANT_EMAIL', 'scottblodgett+hc-tenant@gmail.com');
const LANDLORD_EMAIL     = optional('RESULTS_LANDLORD_EMAIL', 'scottblodgett+hc-landlord@gmail.com');

// Sentinel that marks a CallRequest as belonging to this harness. No real
// customer (or real /tuning session) ever submits this exact property address,
// so it's a safe key for sweeping prior runs' rows without touching real data.
const HC_PROPERTY_ADDRESS = '1 Health Check Lane, Boston, MA 02101';

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const LEG_NAMES: Record<number, string> = {
  1: 'CallRequest created',
  2: 'Outbound call placed',
  3: 'Transcript stored',
  4: 'Claude extraction',
  5: 'Results record',
  6: 'Results email',
};

type LegResult = { leg: number; name: string; passed: boolean; error?: string };
const legs: LegResult[] = [];
let currentLeg = 0;

function startLeg(n: number) {
  currentLeg = n;
  console.log(`Leg ${n}: ${LEG_NAMES[n]}...`);
}

function pasLeg() {
  legs.push({ leg: currentLeg, name: LEG_NAMES[currentLeg], passed: true });
}

function writeReport(passed: boolean) {
  // Mark any legs that never ran as not reached
  for (let i = 1; i <= 6; i++) {
    if (!legs.find(l => l.leg === i)) {
      legs.push({ leg: i, name: LEG_NAMES[i], passed: false, error: 'not reached' });
    }
  }
  legs.sort((a, b) => a.leg - b.leg);
  const report = { timestamp: new Date().toISOString(), passed, legs };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`\nReport written to ${REPORT_PATH}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LEG_TIMEOUTS: Record<number, number> = {
  1: 15_000,
  2: 30_000,
  3: 120_000,
  4: 120_000,
  5: 120_000,
  6: 120_000,
};

type BrevoEvent = { event: string; date: string; messageId?: string; reason?: string };

// A leg failed as designed (already reported). Throwing instead of exiting lets
// the promise chain's `.finally` close the DB connection cleanly on the way out.
class LegFailure extends Error {}

function fail(leg: number, expected: string, got: string): never {
  legs.push({ leg, name: LEG_NAMES[leg], passed: false, error: got });
  writeReport(false);
  console.error(`\nLEG ${leg} FAILED`);
  console.error(`  expected: ${expected}`);
  console.error(`  got:      ${got}`);
  throw new LegFailure(`leg ${leg}`);
}

async function poll<T>(
  fn: () => Promise<T | null>,
  timeoutMs: number,
  intervalMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result !== null) return result;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error('timed out');
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------

let db: Client;

async function dbConnect() {
  db = new Client({ connectionString: DB_URL });
  await db.connect();
  await db.query('SET search_path TO public');
}

async function dbQuery<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await db.query(sql, params);
  return res.rows as T[];
}

// ---------------------------------------------------------------------------
// Residue sweep + connection close
// ---------------------------------------------------------------------------

let callRequestId: string | null = null;
let promoCode: string | null = null;

// Delete rows left by EARLIER runs. Runs at the START of a run (not the end),
// so it fires no matter how the previous run exited — clean pass, failed leg,
// crash, or a hung/killed process. The current run's row is created afterward
// and survives as the single inspectable "last run" residue (pass or fail)
// until the next run sweeps it. Keyed on the harness sentinels so it can never
// touch a real customer or real /tuning row.
async function sweepResidue() {
  const cr = await db.query(
    'DELETE FROM call_requests WHERE property_address = $1',
    [HC_PROPERTY_ADDRESS],
  ); // cascades to call_recordings
  const ft = await db.query(
    "DELETE FROM free_trial_signups WHERE email LIKE 'token-generated-%@internal'",
  );
  console.log(`  swept ${cr.rowCount ?? 0} prior call_request(s), ${ft.rowCount ?? 0} promo signup(s)`);
}

// Always runs last. Cleanup of THIS run's row is deferred to the next run's
// sweep (so the row stays around to inspect); here we just close the socket.
async function cleanup() {
  if (db) await db.end();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await dbConnect();

  // -------------------------------------------------------------------------
  // LEG 1: Issue promo code + create CallRequest via bypass
  // -------------------------------------------------------------------------
  startLeg(1);

  await sweepResidue();

  const ftRes = await post(
    `${APP_URL}/api/free-trial`,
    { skip_email: true },
    { Authorization: `Bearer ${FREE_TRIAL_TOKEN}` },
  );
  if (!ftRes.ok) fail(1, 'free-trial 200', `${ftRes.status}: ${await ftRes.text()}`);
  const ftJson = await ftRes.json() as { promo_code: string };
  promoCode = ftJson.promo_code;
  if (!promoCode) fail(1, 'promo_code in response', 'undefined');

  const bypassRes = await post(
    `${APP_URL}/api/payment/bypass`,
    {
      requester_name:   'Health Check',
      requester_email:  RESULTS_RECIPIENT,
      tenant_name:      'Test Tenant',
      tenant_email:     TENANT_EMAIL,
      property_address: HC_PROPERTY_ADDRESS,
      landlord_name:    'Responder Bot',
      landlord_email:   LANDLORD_EMAIL,
      landlord_phone:   RESPONDER_NUM,
      previous_address: HC_PROPERTY_ADDRESS,
      move_in_date:     '2023-01',
      move_out_date:    '2024-01',
      monthly_rent:     1000,
    },
    { Cookie: `debug_key=${DEBUG_SECRET}` },
  );
  if (!bypassRes.ok) fail(1, 'bypass 200', `${bypassRes.status}: ${await bypassRes.text()}`);
  const { redirectUrl } = await bypassRes.json() as { redirectUrl: string };
  callRequestId = new URL(redirectUrl, APP_URL).searchParams.get('call_request_id');
  if (!callRequestId) fail(1, 'call_request_id in redirectUrl', redirectUrl);

  const [req] = await dbQuery<{ status: string; schedule_token: string }>(
    'SELECT status, schedule_token FROM call_requests WHERE id = $1',
    [callRequestId],
  );
  if (!req) fail(1, 'CallRequest row in DB', 'not found');
  if (!req.schedule_token) fail(1, 'schedule_token on CallRequest', 'null');

  await db.query(
    "UPDATE call_requests SET script_template = 'tuning_smoke_test' WHERE id = $1",
    [callRequestId],
  );
  pasLeg();
  console.log(`  ✓ CallRequest ${callRequestId}`);

  // -------------------------------------------------------------------------
  // LEG 2: Schedule call via /api/schedule (callNow)
  // -------------------------------------------------------------------------
  startLeg(2);

  const schedRes = await post(`${APP_URL}/api/schedule`, {
    token:    req.schedule_token,
    callNow:  true,
    phone:    RESPONDER_NUM_10,
    timezone: 'America/New_York',
  });
  if (!schedRes.ok) fail(2, '/api/schedule 200', `${schedRes.status}: ${await schedRes.text()}`);

  let convId: string;
  try {
    convId = await poll(async () => {
      const [row] = await dbQuery<{ status: string; elevenlabs_conversation_id: string | null }>(
        'SELECT status, elevenlabs_conversation_id FROM call_requests WHERE id = $1',
        [callRequestId!],
      );
      if (row?.status === 'FAILED') throw new Error('status=FAILED');
      return row?.elevenlabs_conversation_id ?? null;
    }, LEG_TIMEOUTS[2]);
  } catch (e) {
    fail(2, 'elevenlabs_conversation_id written', String(e));
  }
  pasLeg();
  console.log(`  ✓ elevenlabs_conversation_id=${convId}`);

  // -------------------------------------------------------------------------
  // LEG 3: Transcript stored
  // -------------------------------------------------------------------------
  startLeg(3);

  let transcript: string;
  try {
    transcript = await poll(async () => {
      const [row] = await dbQuery<{ transcript: string | null; status: string }>(
        `SELECT cr.status, rec.transcript
         FROM call_requests cr
         LEFT JOIN call_recordings rec ON rec.call_request_id = cr.id
         WHERE cr.id = $1`,
        [callRequestId!],
      );
      if (row?.status === 'FAILED') throw new Error(`status=FAILED`);
      return row?.transcript ?? null;
    }, LEG_TIMEOUTS[3]);
  } catch (e) {
    fail(3, 'transcript stored', String(e));
  }
  pasLeg();
  console.log(`  ✓ transcript stored (${transcript.length} chars)`);

  // -------------------------------------------------------------------------
  // LEG 4: Claude extraction
  // -------------------------------------------------------------------------
  startLeg(4);

  try {
    await poll(async () => {
      const [row] = await dbQuery<{ extracted_data: unknown }>(
        'SELECT extracted_data FROM call_recordings WHERE call_request_id = $1',
        [callRequestId!],
      );
      return row?.extracted_data != null ? true : null;
    }, LEG_TIMEOUTS[4]);
  } catch (e) {
    fail(4, 'extracted_data written', String(e));
  }
  pasLeg();
  console.log('  ✓ extracted_data present');

  // -------------------------------------------------------------------------
  // LEG 5: Results record + access code
  // -------------------------------------------------------------------------
  startLeg(5);

  try {
    await poll(async () => {
      const [row] = await dbQuery<{ results_access_code: string | null; results_expires_at: Date | null }>(
        'SELECT results_access_code, results_expires_at FROM call_requests WHERE id = $1',
        [callRequestId!],
      );
      return row?.results_access_code && row?.results_expires_at ? true : null;
    }, LEG_TIMEOUTS[5]);
  } catch (e) {
    fail(5, 'results_access_code + results_expires_at set', String(e));
  }
  pasLeg();
  console.log('  ✓ access code and expiry set');

  // -------------------------------------------------------------------------
  // LEG 6: Results email
  // -------------------------------------------------------------------------
  startLeg(6);

  // Capture a floor timestamp BEFORE triggering the send so we only consider
  // Brevo events belonging to this run, never a stale `delivered` from a prior
  // run (which would otherwise mask a real outage with a false green). 30s of
  // slack absorbs clock skew between this box and Brevo.
  const sendFloor = Date.now() - 30_000;

  const emailRes = await post(
    `${APP_URL}/api/results/send-email`,
    { callRequestId },
    { Cookie: `debug_key=${DEBUG_SECRET}` },
  );
  if (!emailRes.ok) fail(6, '/api/results/send-email 200', `${emailRes.status}: ${await emailRes.text()}`);

  try {
    await poll(async () => {
      const [row] = await dbQuery<{ results_email_sent_at: Date | null }>(
        'SELECT results_email_sent_at FROM call_requests WHERE id = $1',
        [callRequestId!],
      );
      return row?.results_email_sent_at ? true : null;
    }, LEG_TIMEOUTS[6]);
  } catch (e) {
    fail(6, 'results_email_sent_at set', String(e));
  }

  // Confirm Brevo actually delivered THIS send. Scope to events newer than
  // sendFloor and fail fast on a block/bounce — a `blocked` event means the
  // recipient is on Brevo's suppression list (the failure mode that produced
  // this very bug), and asserting "delivered" alone would let it slip through
  // on a stale event.
  const recipientParam = encodeURIComponent(RESULTS_RECIPIENT);
  try {
    await poll(async () => {
      const res = await fetch(
        `https://api.brevo.com/v3/smtp/statistics/events?email=${recipientParam}&limit=20&sort=desc`,
        { headers: { 'api-key': BREVO_API_KEY } },
      );
      if (!res.ok) throw new Error(`Brevo API ${res.status}`);
      const data = await res.json() as { events?: BrevoEvent[] };
      const recent = (data.events ?? []).filter(e => new Date(e.date).getTime() >= sendFloor);
      const bad = recent.find(e => e.event === 'blocked' || e.event === 'hardBounces');
      if (bad) throw new Error(`Brevo event=${bad.event}${bad.reason ? ` (${bad.reason})` : ''}`);
      return recent.some(e => e.event === 'delivered') ? true : null;
    }, LEG_TIMEOUTS[6]);
  } catch (e) {
    fail(6, 'Brevo event=delivered for this send', String(e));
  }
  pasLeg();
  console.log('  ✓ Brevo reports delivered');

  writeReport(true);
}

main()
  .catch(e => {
    // LegFailure is an expected, already-reported failure. Anything else is a
    // crash we still need to report. Set the exit code (don't exit) so cleanup
    // in .finally runs first.
    if (!(e instanceof LegFailure)) {
      console.error('\nUNEXPECTED ERROR:', e);
      writeReport(false);
    }
    process.exitCode = 1;
  })
  .finally(cleanup);
