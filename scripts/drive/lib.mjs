// Drive: a fast scripted browser for agents verifying Decimal on the bench.
//
// The Claude browser tools cost a model round trip per click, so a ten-step check
// takes minutes. Here a flow runs as plain code in a headless Chrome: each step is
// milliseconds to a few seconds, and the agent reads back JSON, plus screenshots
// only when it wants to look. Evidence lands in .bench/evidence/<slug>/.
//
// Safe by construction: it only ever talks to the bench (:3200 / :5274, database
// usdc_ops_bench). Zaid's stack (:3100 / :5174) is refused outright.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const BENCH = {
  api: process.env.DRIVE_API ?? 'http://127.0.0.1:3200',
  web: process.env.DRIVE_WEB ?? 'http://localhost:5274',
};
const STATE = path.join(ROOT, '.bench/drive');
export const EVIDENCE = path.join(ROOT, '.bench/evidence');
const SESSION_KEY = 'usdc_ops_v2.session_token';
const CRASH_SELECTOR = '[data-app-crash]';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// An error the agent can act on: what went wrong, and what to do instead.
export class DriveError extends Error {
  constructor(message, hint, extra = {}) {
    super(message);
    this.hint = hint;
    Object.assign(this, extra);
  }
}

for (const url of [BENCH.api, BENCH.web]) {
  if (/:(3100|5174)\b/.test(url)) {
    throw new DriveError(`refusing ${url}: that is Zaid's stack`, 'Drive only the bench: :3200 (API) and :5274 (web).');
  }
}

// ---------------------------------------------------------------------------
// The bench, Chrome, and teams

export async function benchStatus() {
  const health = await fetch(`${BENCH.api}/health`, { signal: AbortSignal.timeout(2000) })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  const web = await fetch(BENCH.web, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok).catch(() => false);
  return { api: Boolean(health), web, fakeChain: health?.fakeChain === true };
}

export async function requireBench() {
  const s = await benchStatus();
  if (!s.api || !s.web) {
    throw new DriveError(
      `the bench is down (api ${s.api ? 'up' : 'down'}, web ${s.web ? 'up' : 'down'})`,
      'Run `make bench` from the repo root (it is idempotent), then retry.',
    );
  }
  return s;
}

export function findChrome() {
  if (process.env.DRIVE_CHROME) return process.env.DRIVE_CHROME;
  const caches = [path.join(homedir(), 'Library/Caches/ms-playwright'), path.join(homedir(), '.cache/ms-playwright')];
  for (const cache of caches) {
    if (!existsSync(cache)) continue;
    const shells = readdirSync(cache)
      .filter((n) => n.startsWith('chromium_headless_shell-'))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const dir of shells) {
      for (const platform of readdirSync(path.join(cache, dir))) {
        const bin = path.join(cache, dir, platform, 'chrome-headless-shell');
        if (existsSync(bin)) return bin;
      }
    }
  }
  throw new DriveError(
    'no headless Chrome found',
    'Run `npx playwright install chromium-headless-shell`, or set DRIVE_CHROME to a Chrome binary.',
  );
}

function devAuthSecret() {
  const envFile = path.join(ROOT, 'api/.env');
  const line = existsSync(envFile) ? readFileSync(envFile, 'utf8').match(/^DEV_AUTH_SECRET=(.*)$/m) : null;
  const secret = line?.[1]?.trim().replace(/^["']|["']$/g, '');
  if (!secret) throw new DriveError('DEV_AUTH_SECRET is not set in api/.env', 'The bench needs it for /auth/dev/seed. Add it, then `make bench`.');
  return secret;
}

// One team per check keeps checks apart on the one bench: two agents can run at
// once without seeing each other's bills.
export const PEOPLE = [
  { first: 'Ava', last: 'Chen', access: 'primary_admin', roles: [], what: 'primary admin (owner)' },
  { first: 'Omar', last: 'Haddad', access: 'admin', roles: [], what: 'admin' },
  { first: 'Maya', last: 'Ortiz', access: 'member', roles: ['bill_clerk'], what: 'bill clerk' },
  { first: 'Daniel', last: 'Brooks', access: 'member', roles: ['approver'], what: 'approver' },
  { first: 'Priya', last: 'Shah', access: 'member', roles: ['approver'], what: 'second approver' },
  { first: 'Lena', last: 'Park', access: 'member', roles: ['viewer'], what: 'viewer' },
];
const ROLE_WORDS = { owner: 'ava', primary: 'ava', admin: 'omar', clerk: 'maya', approver: 'daniel', viewer: 'lena' };

const tag = () => Math.random().toString(36).slice(2, 7);

export async function seedTeam(name = tag()) {
  if (!/^[a-z0-9-]{1,24}$/.test(name)) {
    throw new DriveError(`bad team name "${name}"`, 'Use 1–24 lowercase letters, digits or dashes, or leave it out for a random one.');
  }
  await requireBench();
  const mail = (p) => `${p.first.toLowerCase()}.${name}@dev.decimal.test`;
  const [owner, ...members] = PEOPLE;
  const body = {
    secret: devAuthSecret(),
    organizationName: `Drive ${name}`,
    owner: { email: mail(owner), displayName: `${owner.first} ${owner.last}` },
    members: members.map((p) => ({ email: mail(p), displayName: `${p.first} ${p.last}`, access: p.access, roles: p.roles })),
  };
  const res = await fetch(`${BENCH.api}/auth/dev/seed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new DriveError(`seeding failed (${res.status}): ${JSON.stringify(json).slice(0, 300)}`, 'See `./scripts/bench.sh logs`.');
  }
  const team = {
    name,
    organizationId: json.organizationId,
    organizationName: json.organizationName,
    seededAt: new Date().toISOString(),
    people: json.users.map((u) => {
      const first = u.displayName.split(' ')[0];
      return {
        first: first.toLowerCase(),
        displayName: u.displayName,
        email: u.email,
        access: u.access,
        roles: u.roles,
        what: PEOPLE.find((p) => p.first === first)?.what ?? u.access,
        sessionToken: u.sessionToken,
      };
    }),
  };
  mkdirSync(path.join(STATE, 'teams'), { recursive: true });
  writeFileSync(path.join(STATE, 'teams', `${name}.json`), JSON.stringify(team, null, 2), { mode: 0o600 });
  writeFileSync(path.join(STATE, 'last-team'), name);
  return team;
}

export function loadTeam(name) {
  const last = path.join(STATE, 'last-team');
  const wanted = name ?? (existsSync(last) ? readFileSync(last, 'utf8').trim() : null);
  if (!wanted) throw new DriveError('no team yet', 'Run `drive seed` first: it makes a fresh team and remembers it.');
  const file = path.join(STATE, 'teams', `${wanted}.json`);
  if (!existsSync(file)) throw new DriveError(`no team called "${wanted}"`, 'Run `drive seed` for a fresh one, or `drive status` to list teams.');
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function listTeams() {
  const dir = path.join(STATE, 'teams');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) : [];
}

export function findPerson(team, who = 'ava') {
  const key = String(who).toLowerCase();
  const first = ROLE_WORDS[key] ?? key;
  const person = team.people.find((p) => p.first === first);
  if (!person) {
    const names = team.people.map((p) => `${p.first} (${p.what})`).join(', ');
    throw new DriveError(`no one called "${who}" in team ${team.name}`, `Use a first name or a role word. People: ${names}.`);
  }
  return person;
}

// What a team looks like without its session tokens.
export function publicTeam(team) {
  return {
    team: team.name,
    organization: team.organizationName,
    organizationId: team.organizationId,
    home: `${BENCH.web}/organizations/${team.organizationId}/inbox`,
    people: team.people.map(({ first, displayName, email, what }) => ({ as: first, name: displayName, email, is: what })),
  };
}

export const orgPath = (team, p = '') => {
  if (/^https?:\/\//.test(p)) return p;
  if (p.startsWith('/')) return p.replaceAll(':org', team.organizationId).replaceAll(':organizationId', team.organizationId);
  return `/organizations/${team.organizationId}/${p}`;
};

// ---------------------------------------------------------------------------
// The API, as a person

export async function apiCall(team, person, method, p, body) {
  const url = BENCH.api + orgPath(team, p);
  const res = await fetch(url, {
    method,
    headers: {
      ...(person ? { authorization: `Bearer ${person.sessionToken}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (res.status === 401 && person) {
    throw new DriveError(`${person.displayName}'s session was refused (401)`, 'Sessions expire. Run `drive seed` for a fresh team.');
  }
  return { status: res.status, ok: res.ok, data };
}

const STILL_READING = /pending|queued|processing|extracting|reading|uploaded/i;

// Upload through the real endpoint and wait until the model has read each file.
export async function uploadBills(team, person, files, { timeoutMs = 180_000 } = {}) {
  await requireBench();
  const out = [];
  for (const file of files) {
    const abs = path.resolve(file);
    if (!existsSync(abs)) throw new DriveError(`no file at ${abs}`, 'Test PDFs live under synthetic_data/ (see TESTING-INVOICES.md).');
    const body = { filename: path.basename(abs), mimeType: 'application/pdf', dataBase64: readFileSync(abs).toString('base64') };
    const up = await apiCall(team, person, 'POST', 'invoices/upload-async', body);
    if (!up.ok) {
      out.push({ file: path.basename(abs), ok: false, status: up.status, error: JSON.stringify(up.data).slice(0, 300) });
      continue;
    }
    const docId = up.data.invoiceDocumentId;
    const began = Date.now();
    let s = null;
    while (Date.now() - began < timeoutMs) {
      await sleep(1500);
      s = (await apiCall(team, person, 'GET', `invoice-documents/${docId}/status`)).data;
      if (s?.status && !STILL_READING.test(s.status)) break;
    }
    const bills = (s?.paymentOrders ?? []).map((o) => ({
      billId: o.paymentOrderId,
      state: o.state,
      link: `${BENCH.web}/organizations/${team.organizationId}/bills/${o.paymentOrderId}`,
    }));
    out.push({
      file: path.basename(abs),
      ok: Boolean(s?.status) && !STILL_READING.test(s.status),
      invoiceDocumentId: docId,
      status: s?.status ?? 'unknown',
      seconds: Math.round((Date.now() - began) / 1000),
      bills,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The browser

// Runs in the page. Finds the element a person would mean by `query`: a button or
// link by its words for 'click', a form field by its label for 'fill'. An open
// dialog takes precedence, as it does for a person. Marks the pick so Node can
// grab it, or returns what is on screen so the error can say what to use instead.
function pickInPage(kind, query, opts, mark) {
  const norm = (s) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const q = norm(query);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  };
  let scope = document;
  if (opts.within) {
    scope = [...document.querySelectorAll(opts.within)].find(visible);
    if (!scope) return { found: false, why: `nothing visible matches within="${opts.within}"`, options: [] };
  } else {
    const dialogs = [...document.querySelectorAll('[role=dialog], [role=alertdialog], dialog[open], [aria-modal=true]')].filter(visible);
    if (dialogs.length) scope = dialogs[dialogs.length - 1];
  }
  const labelledBy = (el) =>
    (el.getAttribute('aria-labelledby') ?? '')
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.innerText ?? '')
      .join(' ');
  let candidates;
  let nameOf;
  if (kind === 'fill') {
    candidates = [...scope.querySelectorAll('input, textarea, select, [contenteditable=true], [role=textbox], [role=combobox]')].filter(
      (el) => !['hidden', 'file', 'checkbox', 'radio', 'submit', 'button'].includes(el.type) && visible(el),
    );
    nameOf = (el) => {
      const own = el.labels?.[0]?.innerText || el.getAttribute('aria-label') || labelledBy(el);
      if (own) return own;
      // A field in a wrapper whose first label-like child names it.
      const wrap = el.closest('label, .field, .bp-field, [class*=field]');
      const lab = wrap?.querySelector('label, .field-label, .bp-label, legend');
      return lab?.innerText || el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('title') || '';
    };
  } else {
    const CLICKABLE =
      'button, a[href], [role=button], [role=link], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=tab], [role=option], [role=switch], [role=checkbox], [role=radio], [role=row], input[type=submit], input[type=button], input[type=checkbox], input[type=radio], summary, label, tr[tabindex], [tabindex="0"]';
    candidates = [...scope.querySelectorAll(CLICKABLE)].filter(visible);
    nameOf = (el) => el.getAttribute('aria-label') || labelledBy(el) || el.innerText || el.value || el.getAttribute('title') || '';
  }
  const scored = [];
  for (const el of candidates) {
    const name = norm(nameOf(el));
    if (!name) continue;
    const score = name === q ? 3 : name.startsWith(q) ? 2 : name.includes(q) ? 1 : 0;
    if (score && (!opts.exact || score === 3)) scored.push({ el, name, score });
  }
  // Nothing with a role: fall back to the smallest visible element whose own words
  // match exactly (a div with an onClick). The click bubbles to its handler.
  if (!scored.length && kind === 'click') {
    for (const el of scope.querySelectorAll('body *')) {
      if (!visible(el) || norm(el.innerText) !== q) continue;
      if ([...el.children].some((c) => visible(c) && norm(c.innerText) === q)) continue;
      scored.push({ el, name: q, score: 3 });
    }
  }
  if (!scored.length) {
    const options = [...new Set(candidates.map((el) => (nameOf(el) ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, 30);
    return { found: false, why: scope === document ? 'on the page' : opts.within ? `within ${opts.within}` : 'in the open dialog', options };
  }
  const best = Math.max(...scored.map((s) => s.score));
  const top = scored.filter((s) => s.score === best).sort((a, b) => a.name.length - b.name.length);
  const index = Math.max(0, (opts.nth ?? 1) - 1);
  const chosen = top[index] ?? top[0];
  chosen.el.setAttribute('data-drive-pick', mark);
  return {
    found: true,
    name: chosen.name,
    tag: chosen.el.tagName.toLowerCase(),
    matches: top.length,
    disabled: Boolean(chosen.el.disabled) || chosen.el.getAttribute('aria-disabled') === 'true',
  };
}

// What a person sees, as data: cheaper to read than a screenshot.
function readInPage() {
  const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  };
  const dialogs = [...document.querySelectorAll('[role=dialog], [role=alertdialog], dialog[open], [aria-modal=true]')].filter(visible);
  const scope = dialogs.length ? dialogs[dialogs.length - 1] : document;
  const all = (sel) => [...scope.querySelectorAll(sel)].filter(visible);
  const crash = document.querySelector('[data-app-crash]');
  return {
    url: location.pathname + location.search,
    title: document.title,
    crashed: crash ? clean(crash.innerText).slice(0, 400) : null,
    dialog: dialogs.length ? clean(dialogs[dialogs.length - 1].getAttribute('aria-label') || dialogs[dialogs.length - 1].querySelector('h1,h2,h3')?.innerText || 'open') : null,
    headings: all('h1, h2, h3').map((h) => clean(h.innerText)).filter(Boolean).slice(0, 20),
    buttons: [...new Set(all('button, [role=button], a[href], [role=tab], [role=menuitem]').map((b) => clean(b.getAttribute('aria-label') || b.innerText)).filter(Boolean))].slice(0, 50),
    fields: all('input, textarea, select').filter((f) => !['hidden', 'file'].includes(f.type)).map((f) => ({
      label: clean(f.labels?.[0]?.innerText || f.getAttribute('aria-label') || f.getAttribute('placeholder') || f.name || ''),
      value: f.type === 'checkbox' || f.type === 'radio' ? f.checked : String(f.value ?? '').slice(0, 120),
      ...(f.disabled ? { disabled: true } : {}),
    })).slice(0, 50),
    text: clean((scope === document ? document.querySelector('main') ?? document.body : scope).innerText).slice(0, 2500),
  };
}

let markCounter = 0;

export class Drive {
  constructor({ browser, team, slug, strict = false, full = false, log = () => {} }) {
    this.browser = browser;
    this.team = team;
    this.slug = slug;
    this.dir = path.join(EVIDENCE, slug);
    this.strict = strict;
    this.full = full;
    this.log = log;
    this.sessions = new Map();
    this.current = null;
    this.steps = [];
    this.shots = [];
    mkdirSync(this.dir, { recursive: true });
  }

  static async launch(opts) {
    const browser = await puppeteer.launch({
      executablePath: findChrome(),
      headless: 'shell',
      defaultViewport: null,
      args: ['--window-size=1440,900', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--lang=en-US', '--force-color-profile=srgb'],
    });
    return new Drive({ browser, ...opts });
  }

  get page() {
    if (!this.current) throw new DriveError('no one is signed in yet', 'Call `await d.as("ava")` first, or pass --as to the command.');
    return this.current.page;
  }

  get person() {
    return this.current?.person ?? null;
  }

  // Switch to a person (first name or role word), or 'nobody' for a signed-out
  // browser. Each person keeps their own browser context, so switching back is free.
  async as(who) {
    const key = String(who).toLowerCase();
    if (!this.sessions.has(key)) {
      const person = key === 'nobody' ? null : findPerson(this.team, key);
      const context = await this.browser.createBrowserContext();
      const page = await context.newPage();
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await page.emulateMediaFeatures([
        { name: 'prefers-reduced-motion', value: 'reduce' },
        { name: 'prefers-color-scheme', value: 'light' },
      ]);
      if (person) {
        await page.evaluateOnNewDocument(
          (k, t) => {
            try {
              window.localStorage.setItem(k, t);
            } catch {}
          },
          SESSION_KEY,
          person.sessionToken,
        );
      }
      const s = { key, person, context, page, inflight: new Map(), lastNet: Date.now(), console: [], pageErrors: [], apiErrors: [] };
      // The live-events stream (accept: text/event-stream) never finishes; it isn't work to wait for.
      const isApi = (r) =>
        ['xhr', 'fetch'].includes(r.resourceType()) && r.url().startsWith(BENCH.api) && !/event-stream/.test(r.headers().accept ?? '');
      const short = (u) => u.replace(BENCH.api, '').replace(this.team.organizationId, ':org');
      page.on('request', (r) => {
        if (isApi(r)) {
          s.inflight.set(r, Date.now());
          s.lastNet = Date.now();
        }
      });
      const done = (r) => {
        if (s.inflight.delete(r)) s.lastNet = Date.now();
      };
      page.on('requestfinished', done);
      page.on('requestfailed', (r) => {
        done(r);
        // ERR_ABORTED is the page navigating away mid-request, not a failure.
        const error = r.failure()?.errorText ?? 'failed';
        if (isApi(r) && error !== 'net::ERR_ABORTED') s.apiErrors.push({ method: r.method(), url: short(r.url()), error });
      });
      page.on('response', (res) => {
        const r = res.request();
        if (isApi(r) && res.status() >= 400) s.apiErrors.push({ method: r.method(), url: short(res.url()), status: res.status() });
      });
      page.on('console', (m) => {
        if (m.type() === 'error') s.console.push(m.text().slice(0, 400));
      });
      page.on('pageerror', (e) => s.pageErrors.push(String(e?.message ?? e).slice(0, 400)));
      this.sessions.set(key, s);
    }
    this.current = this.sessions.get(key);
    this.steps.push({ n: this.steps.length + 1, action: 'as', arg: key, ok: true, ms: 0 });
    return this;
  }

  // Wait until the app's own API calls have gone quiet. Calls open for more than
  // three seconds (a stream, a long poll) don't hold it up.
  async settle({ quiet = 250, max = 8000 } = {}) {
    const s = this.current;
    const began = Date.now();
    while (Date.now() - began < max) {
      const now = Date.now();
      const busy = [...s.inflight.values()].some((t) => now - t < 3000);
      if (!busy && now - s.lastNet >= quiet) break;
      await sleep(40);
    }
    await this.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r()))).catch(() => {});
  }

  async #crashCheck() {
    const crash = await this.page.$eval(CRASH_SELECTOR, (el) => el.innerText.replace(/\s+/g, ' ').trim().slice(0, 400)).catch(() => null);
    if (crash) throw new DriveError(`the page crashed: ${crash}`, 'The error boundary caught a render error. See pageErrors and the console for the stack.');
  }

  async step(action, arg, fn) {
    const began = Date.now();
    const entry = { n: this.steps.length + 1, action, arg, as: this.current?.key };
    this.steps.push(entry);
    this.log(`${entry.n} ${action} ${arg ?? ''}`);
    try {
      const result = await fn();
      if (this.current && action !== 'as') await this.#crashCheck();
      entry.ok = true;
      return result;
    } catch (err) {
      entry.ok = false;
      entry.error = err.message;
      throw err;
    } finally {
      entry.ms = Date.now() - began;
    }
  }

  url(p = '') {
    return /^https?:\/\//.test(p) ? p : BENCH.web + orgPath(this.team, p);
  }

  async goto(p = 'inbox') {
    return this.step('goto', p, async () => {
      await this.page.goto(this.url(p), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const painted = await this.page
        .waitForFunction(() => (document.getElementById('root')?.childElementCount ?? 0) > 0, { timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      if (!painted) throw new DriveError(`${p} rendered nothing: #root stayed empty for 15 s`, 'Check pageErrors and the console in the result.');
      await this.settle();
    });
  }

  async #pick(kind, query, opts = {}) {
    const mark = `p${++markCounter}`;
    const timeout = opts.timeout ?? 5000;
    const began = Date.now();
    let res;
    for (;;) {
      res = await this.page.evaluate(pickInPage, kind, String(query), { within: opts.within, nth: opts.nth, exact: opts.exact }, mark);
      if (res.found || Date.now() - began > timeout) break;
      await sleep(150);
    }
    if (!res.found) {
      const what = kind === 'fill' ? 'field labelled' : 'anything to click called';
      throw new DriveError(
        `no ${what} "${query}" ${res.why}`,
        res.options?.length ? `What is there: ${res.options.map((o) => `"${o.slice(0, 60)}"`).join(', ')}` : 'Nothing matching is on screen. Try d.read() to see the page.',
      );
    }
    if (res.disabled && kind === 'click') throw new DriveError(`"${res.name}" is disabled`, 'Something on the page has to happen first; d.read() shows the state.');
    const handle = await this.page.$(`[data-drive-pick="${mark}"]`);
    return { handle, info: res, cleanup: () => handle.evaluate((el) => el.removeAttribute('data-drive-pick')).catch(() => {}) };
  }

  // Click a button, link, tab, row or menu item by the words on it.
  // Options: nth (1-based among equal matches), within (CSS selector), exact, timeout.
  async click(target, opts = {}) {
    return this.step('click', target, async () => {
      const { handle, info, cleanup } = await this.#pick('click', target, opts);
      await handle.click();
      await cleanup();
      await handle.dispose();
      await this.settle();
      if (info.matches > 1) return { note: `${info.matches} matches; clicked the ${opts.nth ? `#${opts.nth}` : 'first'}` };
    });
  }

  // Type into a field found by its label (or aria-label, or placeholder). '' clears it.
  async fill(label, value, opts = {}) {
    return this.step('fill', `${label} = ${JSON.stringify(value)}`, async () => {
      const { handle, cleanup } = await this.#pick('fill', label, opts);
      const isSelect = await handle.evaluate((el) => el.tagName === 'SELECT');
      if (isSelect) {
        const option = await handle.evaluate((el, v) => {
          const n = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
          const o = [...el.options].find((x) => n(x.text) === n(v) || x.value === v);
          return o ? o.value : null;
        }, String(value));
        if (option === null) throw new DriveError(`"${label}" has no option "${value}"`, 'd.read() lists the fields; open it with d.click to see options.');
        await handle.select(option);
      } else {
        await handle.click();
        await handle.evaluate((el) => {
          if (typeof el.select === 'function') el.select();
          else document.execCommand('selectAll');
        });
        await this.page.keyboard.press('Backspace');
        if (value !== '') await this.page.keyboard.type(String(value));
      }
      await cleanup();
      await handle.dispose();
      await this.settle();
    });
  }

  // Put files on the page's file input (the open dialog's first), as a drop would.
  async upload(files, { within } = {}) {
    const list = (Array.isArray(files) ? files : [files]).map((f) => path.resolve(ROOT, f));
    return this.step('upload', list.map((f) => path.basename(f)).join(', '), async () => {
      for (const f of list) if (!existsSync(f)) throw new DriveError(`no file at ${f}`, 'Test PDFs live under synthetic_data/ (see TESTING-INVOICES.md).');
      const input = within
        ? await this.page.$(`${within} input[type=file]`)
        : ((await this.page.$('[role=dialog] input[type=file]')) ?? (await this.page.$('input[type=file]')));
      if (!input) throw new DriveError('no file input on this page', 'Open the upload dialog first (for example d.click("Upload a bill")).');
      await input.uploadFile(...list);
      await input.dispose();
      await this.settle();
    });
  }

  async press(key) {
    return this.step('press', key, async () => {
      await this.page.keyboard.press(key);
      await this.settle();
    });
  }

  // Wait until the words are on screen (case and spacing ignored). For slow work
  // (a model reading a bill) pass a longer timeout: d.see('Checked', { timeout: 90000 }).
  async see(text, { timeout = 10_000, within } = {}) {
    return this.step('see', text, async () => {
      const ok = await this.page
        .waitForFunction(
          (t, w) => {
            const n = (s) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
            const root = w ? document.querySelector(w) : document.body;
            return root ? n(root.innerText).includes(n(t)) : false;
          },
          { timeout, polling: 200 },
          String(text),
          within ?? null,
        )
        .then(() => true)
        .catch(() => false);
      if (!ok) {
        const shown = await this.page.evaluate(readInPage);
        throw new DriveError(`"${text}" never appeared within ${Math.round(timeout / 1000)} s`, `The page shows: ${shown.text.slice(0, 600)}`);
      }
    });
  }

  // Wait until the address matches (a RegExp or a substring), e.g. after the app
  // moves on by itself: d.waitUrl(/\/bills\/[0-9a-f-]{36}/, { timeout: 90000 }).
  async waitUrl(pattern, { timeout = 10_000 } = {}) {
    return this.step('waitUrl', String(pattern), async () => {
      const test = (u) => (pattern instanceof RegExp ? pattern.test(u) : u.includes(pattern));
      const began = Date.now();
      while (!test(this.page.url())) {
        if (Date.now() - began > timeout) {
          throw new DriveError(`the address never matched ${pattern} within ${Math.round(timeout / 1000)} s`, `It is ${new URL(this.page.url()).pathname}.`);
        }
        await sleep(150);
      }
      await this.settle();
      return new URL(this.page.url()).pathname;
    });
  }

  async notSee(text, { within } = {}) {
    return this.step('notSee', text, async () => {
      const present = await this.page.evaluate(
        (t, w) => {
          const n = (s) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
          const root = w ? document.querySelector(w) : document.body;
          return root ? n(root.innerText).includes(n(t)) : false;
        },
        String(text),
        within ?? null,
      );
      if (present) throw new DriveError(`"${text}" is on screen and shouldn't be`, 'd.read() shows the whole page.');
    });
  }

  async read() {
    return this.step('read', null, () => this.page.evaluate(readInPage));
  }

  async text(selector = 'main') {
    return this.step('text', selector, () =>
      this.page.evaluate((s) => ((document.querySelector(s) ?? document.body).innerText ?? '').replace(/\s+\n/g, '\n').trim(), selector),
    );
  }

  async shot(name = 'shot', { full } = {}) {
    return this.step('shot', name, async () => {
      const file = path.join(this.dir, `${String(this.shots.length + 1).padStart(2, '0')}-${name.replace(/[^a-z0-9-]+/gi, '-')}.png`);
      await this.page.screenshot({ path: file, fullPage: full ?? this.full });
      this.shots.push(file);
      return file;
    });
  }

  check(condition, message) {
    const entry = { n: this.steps.length + 1, action: 'check', arg: message, as: this.current?.key, ok: Boolean(condition), ms: 0 };
    this.steps.push(entry);
    if (!condition) throw new DriveError(`check failed: ${message}`, 'The step before it shows the state; d.read() or a shot shows more.');
  }

  // Call the bench API as the current person. 'bills/x/detail' is under the team's org.
  async api(method, p, body) {
    return this.step('api', `${method} ${p}`, async () => {
      const res = await apiCall(this.team, this.person, method, p, body);
      return res;
    });
  }

  async wait(ms) {
    return this.step('wait', `${ms} ms`, () => sleep(ms));
  }

  // Everything the browser noticed, per person.
  errors() {
    const out = {};
    for (const [key, s] of this.sessions) {
      if (s.pageErrors.length || s.console.length || s.apiErrors.length) {
        out[key] = { pageErrors: s.pageErrors, console: s.console, apiErrors: s.apiErrors };
      }
    }
    return out;
  }

  async close() {
    await this.browser.close().catch(() => {});
  }
}
