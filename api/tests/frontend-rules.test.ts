import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

// CLAUDE.md's frontend rules, as checks rather than prose: what a person reads
// never says "multisig", "vote", "wallet" or "GL code", a redesigned page
// takes its colours from styles/ui/tokens.css rather than hardcoding them, and
// copy has no em dashes between words (PAGE-PLAYBOOK, Copy).
//
// Only what is on screen is read: JSX text and string literals, parsed with
// TypeScript, never identifiers, imports or comments. A path, key, class name
// or id (a string starting with '/' or './', or all lowercase with no spaces)
// isn't copy and is skipped.
//
// Every .tsx file is held to this except the pages the redesign hasn't reached
// yet and the frozen payment screens, listed below. That list only shrinks: a
// file on it that no longer exists fails the suite, so a redesigned or deleted
// page comes off it, and a new page is covered the day it is written.

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/src');

// The old system and the frozen payment screens (rendered in <Legacy> in
// App.tsx), the old component folders, and the landing page, which has its own
// design and is off-limits.
const NOT_YET_REDESIGNED = [
  'dec/',
  'ui/',
  'ui-primitives.tsx',
  'pages/landing-v4/',
  'pages/Accounting.tsx',
  'pages/Approvals.tsx',
  'pages/Chat.tsx',
  'pages/Knowledge.tsx',
  'pages/OrganizationProposalDetail.tsx',
  'pages/OrganizationProposals.tsx',
  'pages/PaymentDetail.tsx',
  'pages/ProposalRedirect.tsx',
  'pages/SpendingLimitDetail.tsx',
  'pages/SpendingLimits.tsx',
  'pages/TreasuryWalletDetail.tsx',
  'pages/VaultDetail.tsx',
  'pages/Wallets.tsx',
];

// Colours that are right to hardcode, with why.
const COLOUR_EXCEPTIONS: Record<string, string> = {
  'kit/Orb.tsx': 'the orb is a WebGL shader; its colours are shader inputs, not CSS',
  'pages/signin/parts.tsx': "Google's sign-in button must draw the Google logo in Google's own colours",
};

const BANNED_WORDS = /\b(multi-?sigs?|votes?|voting|wallets?|GL codes?)\b/i;
const HARDCODED_COLOUR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;
const EM_DASH_IN_PROSE = /[A-Za-z0-9.,)’'"]\s?—\s?[A-Za-z0-9(‘'"]/;

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return tsxFiles(full);
    return name.endsWith('.tsx') ? [full] : [];
  });
}

const isExempt = (rel: string) => NOT_YET_REDESIGNED.some((entry) => (entry.endsWith('/') ? rel.startsWith(entry) : rel === entry));

type Hit = { file: string; line: number; text: string };

function copyIn(file: string): Array<{ line: number; text: string }> {
  const source = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Array<{ line: number; text: string }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    let text: string | null = null;
    if (ts.isJsxText(node)) text = node.getText();
    else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text;
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) text = node.text;
    if (text !== null) {
      const t = text.trim();
      const technical = t.startsWith('/') || t.startsWith('./') || t.startsWith('../') || /^[a-z0-9_.:/-]*$/.test(t);
      if (!technical) out.push({ line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: t });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const held = tsxFiles(SRC)
  .map((file) => ({ file, rel: path.relative(SRC, file).split(path.sep).join('/') }))
  .filter(({ rel }) => !isExempt(rel));

function find(rule: RegExp, skip: (rel: string) => boolean = () => false): Hit[] {
  return held
    .filter(({ rel }) => !skip(rel))
    .flatMap(({ file, rel }) => copyIn(file).filter((c) => rule.test(c.text)).map((c) => ({ file: rel, line: c.line, text: c.text.slice(0, 80) })));
}

const report = (hits: Hit[]) => hits.map((h) => `  ${h.file}:${h.line}  ${JSON.stringify(h.text)}`).join('\n');

test('the scan reads the redesigned pages, not nothing', () => {
  assert.ok(held.length > 30, `only ${held.length} files are held to the rules`);
  assert.ok(held.some(({ rel }) => rel === 'pages/bill/BillPage.tsx'), "the bill page isn't being scanned");
  // The parser finds copy: the Bills page says "Upload a bill".
  const bills = held.find(({ rel }) => rel === 'pages/Bills.tsx');
  assert.ok(bills && copyIn(bills.file).some((c) => c.text.includes('Upload a bill')), "the scan can't see the Bills page's copy");
});

test('every file on the not-yet-redesigned list still exists, so the list only shrinks', () => {
  const missing = NOT_YET_REDESIGNED.filter((entry) => !existsSync(path.join(SRC, entry)));
  assert.deepEqual(missing, [], `Take these off NOT_YET_REDESIGNED: ${missing.join(', ')}`);
});

test("copy never says multisig, vote, wallet or GL code (it's bill, approval, approvers, Category)", () => {
  const hits = find(BANNED_WORDS);
  assert.equal(hits.length, 0, `Operator-facing copy uses a banned word (CLAUDE.md, Product vocabulary):\n${report(hits)}`);
});

test('a redesigned page takes its colours from styles/ui/tokens.css', () => {
  const hits = find(HARDCODED_COLOUR, (rel) => rel in COLOUR_EXCEPTIONS);
  assert.equal(hits.length, 0, `Hardcoded colours; use a token from styles/ui/tokens.css (add one there if needed):\n${report(hits)}`);
});

test('copy has no em dashes between words', () => {
  const hits = find(EM_DASH_IN_PROSE);
  assert.equal(hits.length, 0, `Em dashes in copy (PAGE-PLAYBOOK, Copy); use a comma, a colon or two sentences:\n${report(hits)}`);
});
