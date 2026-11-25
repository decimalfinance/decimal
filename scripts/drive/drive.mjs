#!/usr/bin/env node
// drive: a fast scripted browser for verifying Decimal on the bench. `drive help`.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BENCH, EVIDENCE, ROOT, Drive, DriveError, apiCall, appRoutes, benchStatus, findChrome, findPerson, listTeams, loadTeam,
  publicTeam, requireBench, seedTeam, sleep, uploadBills,
} from './lib.mjs';

const HELP = `drive: a fast scripted browser for verifying Decimal on the bench.
Every command prints one JSON object. Evidence (screenshots, run.json) goes to
.bench/evidence/<slug>/; open a PNG with the Read tool to look at it.

  drive status                      bench up?, which Chrome, known teams
  drive seed [name]                 a fresh team on the bench (6 people); becomes the default
  drive team [name]                 the team's people and links (no tokens)
  drive upload <pdf>...             upload through the real endpoint as a person and wait
                                    until the model has read it; prints bill ids and links
  drive shot <route>...             open each route, screenshot it, report what it shows
                                    (headings, buttons, fields, text) and any errors
  drive run <flow.mjs>              run a flow file:  export default async (d) => { ... }
  drive run -e '<code>'             run an inline flow, for example
                                    -e "await d.goto('bills'); await d.see('Bills'); await d.shot('bills')"
  drive api <METHOD> <path> [json]  call the bench API as a person; prints status and body
  drive smoke                       every route in App.tsx as each person, on a fresh team with
                                    one bill; fails on a crash, an uncaught error, a 5xx, or a
                                    blank page. --as <who> for one person, --no-bill to skip upload
  drive verify                      every flow in scripts/drive/flows/, each on its own fresh team,
                                    and smoke, all at once; one verdict. --only <regex> for some
                                    flows, --no-smoke to skip it. \`make verify\` runs this and make test

Options
  --team <name>   which team (default: the last one seeded)
  --as <who>      first name or role word (default ava). ava owner, omar admin, maya clerk,
                  daniel approver, priya second approver, lena viewer, nobody signed out
  --slug <name>   evidence folder name (default: the command and a timestamp)
  --strict        console errors fail the run, not just uncaught ones
  --full          full-page screenshots
  --break <regex> answer API reads whose path matches with {}: proves a check can fail

Routes: 'bills' means /organizations/<team org>/bills. A leading / is absolute,
and :org inside it becomes the team's organisation id.

Flow API (d):
  d.as(who)                      switch person; each keeps their own browser
  d.goto(route)                  open a route and wait for it to settle
  d.click(words, {nth, within, exact})   click a button, link, tab or row by its words
  d.fill(label, value)           type into a field by its label ('' clears; a <select> picks by text)
  d.upload(files)                put PDFs on the page's (or open dialog's) file input
  d.press(key)                   'Enter', 'Escape', 'Tab'...
  d.see(words, {timeout})        wait until the words are on screen (default 10 s)
  d.waitUrl(pattern, {timeout})  wait until the address matches (RegExp or substring)
  d.notSee(words)                fail if the words are on screen
  d.read()                       the screen as data: url, headings, buttons, fields, text
  d.text(css)                    the text of an element (default main)
  d.shot(name, {full})           screenshot into the evidence folder
  d.check(condition, message)    a PASS/FAIL assertion; a failure stops the run
  d.expectCrash()                wait for the crash page and return its error, without failing
  await d.breakApi(regex | null) make matching API reads return {} from now on; null mends them
  d.api(method, path, body)      the bench API as the current person (read back stored values)
  d.wait(ms), d.page (raw puppeteer), d.team, d.person

A failing step stops the run, saves fail.png, and prints the error with a hint and
what the page showed. A step that failed fails the run even if the flow caught it.
A page that crashes (the error boundary's data-app-crash) fails the next step,
unless d.expectCrash() waited for it. Uncaught errors outside React fail the run.
Test PDFs live under synthetic_data/ (see TESTING-INVOICES.md).`;

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-e') flags.eval = argv[++i];
    else if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) flags[k] = v;
      else if (['strict', 'full', 'help', 'no-bill', 'no-smoke'].includes(k)) flags[k] = true;
      else flags[k] = argv[++i];
    } else rest.push(a);
  }
  return { flags, rest };
}

const print = (obj) => process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

async function withDrive(flags, slug, fn) {
  await requireBench();
  const team = loadTeam(flags.team);
  const d = await Drive.launch({ team, slug, strict: Boolean(flags.strict), full: Boolean(flags.full), breakApi: flags.break, log: (l) => process.stderr.write(`  ${l}\n`) });
  const began = Date.now();
  const result = { ok: true, slug, team: team.name, as: flags.as ?? 'ava', evidence: path.relative(ROOT, d.dir) };
  try {
    await d.as(flags.as ?? 'ava');
    const out = await fn(d);
    if (out !== undefined) result.result = out;
    await d.finalCheck();
  } catch (err) {
    result.ok = false;
    result.failure = { step: d.steps.at(-1)?.n, error: err.message, ...(err.hint ? { hint: err.hint } : {}) };
    if (d.current) {
      result.failure.url = await d.page.evaluate(() => location.pathname).catch(() => null);
      const file = path.join(d.dir, 'fail.png');
      if (await d.page.screenshot({ path: file }).then(() => true).catch(() => false)) d.shots.push(file);
    }
  }
  // A step that failed fails the run, even if the flow caught the error.
  const failedStep = d.steps.find((st) => st.ok === false);
  if (result.ok && failedStep) {
    result.ok = false;
    result.failure = { step: failedStep.n, error: `step ${failedStep.n} (${failedStep.action}) failed and the flow carried on: ${failedStep.error}`, hint: 'To check a crash on purpose use d.expectCrash(); to check something is absent use d.notSee().' };
  }
  const errors = d.errors();
  const uncaught = Object.values(errors).some((e) => e.pageErrors.length);
  const consoleErrs = Object.values(errors).some((e) => e.console.length);
  if (result.ok && (uncaught || (d.strict && consoleErrs))) {
    result.ok = false;
    result.failure = { error: uncaught ? 'the page threw an uncaught error' : 'the console logged errors (--strict)', hint: 'See errors.' };
  }
  result.seconds = Math.round((Date.now() - began) / 100) / 10;
  result.steps = d.steps.map(({ n, action, arg, as, ok, ms, error }) => ({ n, action, ...(arg != null ? { arg: String(arg).slice(0, 120) } : {}), as, ok, ms, ...(error ? { error } : {}) }));
  result.shots = d.shots.map((f) => path.relative(ROOT, f));
  if (Object.keys(errors).length) result.errors = errors;
  writeFileSync(path.join(d.dir, 'run.json'), JSON.stringify(result, null, 2));
  await d.close();
  return result;
}

// Every route in App.tsx, as each person, on a fresh team with one bill read by
// the model. A route fails on a crash, an uncaught error, a 5xx from the API,
// "Can't reach Decimal", or a page area still empty after 8 s.
const SMOKE_PDF = 'synthetic_data/invoices/A-routing/A3-first-bill-312.pdf';

async function smoke(flags) {
  await requireBench();
  const began = Date.now();
  const team = flags.team ? loadTeam(flags.team) : await seedTeam(`smoke-${Math.random().toString(36).slice(2, 6)}`, { remember: false });
  const ids = { organizationId: team.organizationId, system: ['quickbooks', 'xero'] };
  const setup = {};
  if (!flags['no-bill']) {
    const [up] = await uploadBills(team, findPerson(team, 'maya'), [path.join(ROOT, SMOKE_PDF)]);
    if (up?.ok && up.bills[0]) {
      ids.paymentOrderId = up.bills[0].billId;
      ids.invoiceDocumentId = up.invoiceDocumentId;
      const detail = await apiCall(team, findPerson(team, 'ava'), 'GET', `bills/${ids.paymentOrderId}/detail`);
      if (detail.data?.draft?.vendor?.counterpartyId) ids.counterpartyId = detail.data.draft.vendor.counterpartyId;
      setup.bill = { id: ids.paymentOrderId, readIn: `${up.seconds} s` };
    } else {
      setup.bill = { failed: up ?? 'no upload result', note: 'bill routes are skipped' };
    }
  }
  const { routes, skipped } = appRoutes(ids);
  const people = !flags.as || flags.as === 'all' ? team.people.map((p) => p.first) : [String(flags.as).toLowerCase()];
  const slug = flags.slug ?? `smoke-${stamp()}`;
  const d = await Drive.launch({ team, slug, strict: Boolean(flags.strict), breakApi: flags.break, log: () => {} });
  const failures = [];
  const warnings = [];
  for (const who of people) {
    await d.as(who);
    const s = d.current;
    process.stderr.write(`  ${who}: ${routes.length} routes\n`);
    for (const { pattern, route } of routes) {
      const mark = { pageErrors: s.pageErrors.length, console: s.console.length, apiErrors: s.apiErrors.length };
      const problems = [];
      try {
        // The last route's crash is already recorded against it; don't charge it to this one.
        d.crashExpected = true;
        await d.goto(route);
        const seen = await d.page.evaluate(() => {
          const area = document.querySelector('main') ?? document.getElementById('root');
          return {
            blank: !area?.innerText.trim() && !document.querySelector('[data-app-crash]'),
            cantReach: [...document.querySelectorAll('h1')].some((h) => /Can’t reach Decimal/.test(h.innerText)),
          };
        });
        if (seen.blank) problems.push('the page area was still empty after 8 s');
        if (seen.cantReach) problems.push('"Can’t reach Decimal": the session check failed');
      } catch (err) {
        problems.push(err.message);
      }
      await sleep(150);
      // A crash can land after the step settled; the boundary's mark says so.
      const crashed = await d.page.$eval('[data-app-crash]', (el) => el.getAttribute('data-app-crash')).catch(() => null);
      if (crashed && !problems.some((p) => p.startsWith('the page crashed'))) problems.push(`the page crashed: ${crashed}`);
      const thrown = s.pageErrors.slice(mark.pageErrors);
      const logged = s.console.slice(mark.console);
      const serverErrors = s.apiErrors.slice(mark.apiErrors).filter((e) => (e.status ?? 0) >= 500);
      if (thrown.length) problems.push(`uncaught: ${thrown.join(' | ')}`);
      if (serverErrors.length) problems.push(`the API failed: ${serverErrors.map((e) => `${e.status} ${e.method} ${e.url}`).join(', ')}`);
      if (logged.length && flags.strict) problems.push(`console: ${logged.join(' | ')}`);
      else if (logged.length) warnings.push({ as: who, route: pattern, console: logged.slice(0, 3) });
      const landed = await d.page.evaluate(() => location.pathname).catch(() => null);
      if (problems.length) {
        const file = path.join(d.dir, `fail-${who}-${pattern.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}.png`);
        await d.page.screenshot({ path: file }).catch(() => {});
        failures.push({ as: who, route: pattern, landed: landed?.replaceAll(team.organizationId, ':org'), problems, shot: path.relative(ROOT, file) });
      }
    }
  }
  await d.close();
  const result = {
    ok: failures.length === 0,
    team: team.name,
    people,
    routes: routes.length,
    loads: routes.length * people.length,
    failed: failures.length,
    seconds: Math.round((Date.now() - began) / 1000),
    setup,
    failures,
    ...(warnings.length ? { consoleWarnings: warnings.length, warnings: warnings.slice(0, 15) } : {}),
    skipped,
    evidence: path.relative(ROOT, d.dir),
  };
  writeFileSync(path.join(d.dir, 'run.json'), JSON.stringify(result, null, 2));
  return result;
}

// Every lasting flow, each on a team seeded just for it, and the smoke run, side
// by side: each is its own process with its own browser, so one can't disturb
// another. The verdict is all of them.
async function verify(flags) {
  await requireBench();
  const began = Date.now();
  const dir = path.join(ROOT, 'scripts/drive/flows');
  const only = flags.only ? new RegExp(flags.only) : null;
  const flows = readdirSync(dir).filter((f) => f.endsWith('.mjs')).map((f) => path.basename(f, '.mjs')).filter((n) => !only || only.test(n)).sort();
  if (!flows.length) throw new DriveError(`no flows match ${flags.only}`, `ls scripts/drive/flows`);
  const id = stamp();
  const self = fileURLToPath(import.meta.url);
  const child = (args) =>
    new Promise((resolve) => {
      execFile(process.execPath, [self, ...args], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60_000 }, (err, stdout) => {
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve({ ok: false, error: `no verdict: ${(err?.message ?? 'empty output').slice(0, 300)}` });
        }
      });
    });
  const runFlow = async (name) => {
    const t = Date.now();
    const team = await seedTeam(`v${Math.random().toString(36).slice(2, 6)}-${name}`.slice(0, 24).replace(/-+$/, ''), { remember: false });
    const r = await child(['run', path.join(dir, `${name}.mjs`), '--team', team.name, '--slug', `verify-${id}-${name}`]);
    return {
      flow: name,
      ok: r.ok === true,
      seconds: Math.round((Date.now() - t) / 1000),
      team: team.name,
      checks: (r.steps ?? []).filter((s) => s.action === 'check').length,
      ...(r.ok ? {} : { failure: r.failure ?? { error: r.error, hint: r.hint } }),
      evidence: r.evidence ?? path.relative(ROOT, path.join(EVIDENCE, `verify-${id}-${name}`)),
    };
  };
  const [flowResults, smokeResult] = await Promise.all([
    Promise.all(flows.map(runFlow)),
    flags['no-smoke'] ? null : child(['smoke', '--slug', `verify-${id}-smoke`]),
  ]);
  const smokeOk = !smokeResult || smokeResult.ok === true;
  const result = {
    ok: flowResults.every((f) => f.ok) && smokeOk,
    seconds: Math.round((Date.now() - began) / 1000),
    flows: flowResults,
    ...(smokeResult
      ? {
          smoke: {
            ok: smokeResult.ok === true,
            loads: smokeResult.loads,
            failed: smokeResult.failed,
            seconds: smokeResult.seconds,
            ...(smokeResult.ok ? {} : { failures: (smokeResult.failures ?? []).slice(0, 10), error: smokeResult.error }),
            evidence: smokeResult.evidence,
          },
        }
      : {}),
  };
  mkdirSync(path.join(EVIDENCE, `verify-${id}`), { recursive: true });
  writeFileSync(path.join(EVIDENCE, `verify-${id}`, 'verify.json'), JSON.stringify(result, null, 2));
  return result;
}

async function main() {
  const { flags, rest } = parseArgs(process.argv.slice(2));
  const [cmd, ...args] = rest;
  if (!cmd || cmd === 'help' || flags.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  switch (cmd) {
    case 'status': {
      const s = await benchStatus();
      let chrome;
      try {
        chrome = findChrome();
      } catch (e) {
        chrome = `missing: ${e.hint}`;
      }
      print({ bench: { ...s, api: s.api ? BENCH.api : 'down', web: s.web ? BENCH.web : 'down' }, chrome, teams: listTeams(), evidence: path.relative(ROOT, EVIDENCE), ...(s.api && s.web ? {} : { hint: 'Run `make bench`.' }) });
      return s.api && s.web ? 0 : 1;
    }
    case 'seed': {
      const team = await seedTeam(args[0]);
      print({ ok: true, ...publicTeam(team), note: 'Now the default team for every command.' });
      return 0;
    }
    case 'team': {
      print(publicTeam(loadTeam(args[0] ?? flags.team)));
      return 0;
    }
    case 'upload': {
      if (!args.length) throw new DriveError('which files?', 'drive upload synthetic_data/invoices/A-routing/A3-first-bill-312.pdf --as maya');
      const team = loadTeam(flags.team);
      const results = await uploadBills(team, findPerson(team, flags.as ?? 'maya'), args);
      print({ ok: results.every((r) => r.ok), team: team.name, as: flags.as ?? 'maya', uploads: results });
      return results.every((r) => r.ok) ? 0 : 1;
    }
    case 'api': {
      const [method, p, body] = args;
      if (!method || !p) throw new DriveError('usage: drive api <METHOD> <path> [json]', "drive api GET 'bills?limit=5' --as ava");
      const team = loadTeam(flags.team);
      const res = await apiCall(team, findPerson(team, flags.as ?? 'ava'), method.toUpperCase(), p, body ? JSON.parse(body) : undefined);
      print(res);
      return res.ok ? 0 : 1;
    }
    case 'shot': {
      if (!args.length) throw new DriveError('which routes?', "drive shot bills inbox 'bills/<billId>'");
      const result = await withDrive(flags, flags.slug ?? `shot-${stamp()}`, async (d) => {
        const pages = [];
        for (const route of args) {
          await d.goto(route);
          const seen = await d.read();
          const file = await d.shot(route.replace(/^\//, '').replace(/[^a-z0-9]+/gi, '-') || 'root');
          pages.push({ route, shot: path.relative(ROOT, file), ...seen });
        }
        return pages;
      });
      print(result);
      return result.ok ? 0 : 1;
    }
    case 'run': {
      let flow;
      let name;
      if (flags.eval) {
        const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
        flow = new AsyncFunction('d', flags.eval);
        name = 'inline';
      } else {
        const file = args[0] && path.resolve(args[0]);
        if (!file || !existsSync(file)) throw new DriveError(`no flow file at ${args[0] ?? '(none)'}`, "drive run scripts/drive/flows/<name>.mjs, or drive run -e '<code>'");
        flow = (await import(pathToFileURL(file).href)).default;
        if (typeof flow !== 'function') throw new DriveError(`${args[0]} has no default export`, 'export default async (d) => { ... }');
        name = path.basename(file, '.mjs');
      }
      const result = await withDrive(flags, flags.slug ?? `${name}-${stamp()}`, (d) => flow(d));
      print(result);
      return result.ok ? 0 : 1;
    }
    case 'smoke': {
      const result = await smoke(flags);
      print(result);
      return result.ok ? 0 : 1;
    }
    case 'verify': {
      const result = await verify(flags);
      print(result);
      return result.ok ? 0 : 1;
    }
    default:
      throw new DriveError(`no command "${cmd}"`, 'drive help lists them: status, seed, team, upload, shot, run, api, smoke, verify.');
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    print({ ok: false, error: err.message, ...(err.hint ? { hint: err.hint } : {}) });
    process.exit(1);
  });
