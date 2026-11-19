#!/usr/bin/env node
// drive: a fast scripted browser for verifying Decimal on the bench. `drive help`.
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BENCH, EVIDENCE, ROOT, Drive, DriveError, apiCall, benchStatus, findChrome, findPerson, listTeams, loadTeam,
  publicTeam, requireBench, seedTeam, uploadBills,
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

Options
  --team <name>   which team (default: the last one seeded)
  --as <who>      first name or role word (default ava). ava owner, omar admin, maya clerk,
                  daniel approver, priya second approver, lena viewer, nobody signed out
  --slug <name>   evidence folder name (default: the command and a timestamp)
  --strict        console errors fail the run, not just uncaught ones
  --full          full-page screenshots

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
  d.api(method, path, body)      the bench API as the current person (read back stored values)
  d.wait(ms), d.page (raw puppeteer), d.team, d.person

A failing step stops the run, saves fail.png, and prints the error with a hint and
what the page showed. Uncaught page errors always fail the run.
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
      else if (['strict', 'full', 'help'].includes(k)) flags[k] = true;
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
  const d = await Drive.launch({ team, slug, strict: Boolean(flags.strict), full: Boolean(flags.full), log: (l) => process.stderr.write(`  ${l}\n`) });
  const began = Date.now();
  const result = { ok: true, slug, team: team.name, as: flags.as ?? 'ava', evidence: path.relative(ROOT, d.dir) };
  try {
    await d.as(flags.as ?? 'ava');
    const out = await fn(d);
    if (out !== undefined) result.result = out;
  } catch (err) {
    result.ok = false;
    result.failure = { step: d.steps.at(-1)?.n, error: err.message, ...(err.hint ? { hint: err.hint } : {}) };
    if (d.current) {
      result.failure.url = await d.page.evaluate(() => location.pathname).catch(() => null);
      const file = path.join(d.dir, 'fail.png');
      if (await d.page.screenshot({ path: file }).then(() => true).catch(() => false)) d.shots.push(file);
    }
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
      if (!args.length) throw new DriveError('which files?', 'drive upload synthetic_data/testbench/meridian-mw-1.pdf --as maya');
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
    default:
      throw new DriveError(`no command "${cmd}"`, 'drive help lists them: status, seed, team, upload, shot, run, api.');
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    print({ ok: false, error: err.message, ...(err.hint ? { hint: err.hint } : {}) });
    process.exit(1);
  });
