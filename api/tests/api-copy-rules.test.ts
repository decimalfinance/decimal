import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

// The API writes copy people read: flag messages, status lines, History
// entries, errors that pages show as they are. That copy follows the same rule
// as the pages (PAGE-PLAYBOOK, Copy): no em dashes between words.
// frontend-rules.test.ts can't see it, because the API writes it.
//
// Every string literal in api/src is held to this, except:
// - what goes to a log (logger.*, console.*), which a person never reads;
// - text written for a model, listed below by its top-level declaration.
//   Rewording a prompt changes what the model does, and the evals were run on
//   these words, so prompts are left alone;
// - the frozen payment code, which isn't developed without a product decision.
// Both lists only shrink: an entry that no longer exists fails the suite.

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

const MODEL_TEXT: Record<string, string> = {
  'accounting/ocr-coding.ts#matchExpenseAccounts': 'builds the Category-matching prompt',
  'approvals/flow.ts#ASSIST_SYSTEM': "the approval-flow assistant's system prompt",
  'companion/chat-tools-org.ts#orgTools': "tool descriptions the companion's model reads",
  'companion/chat.ts#system': "the companion chat's system prompt",
  'payments/document-extract.ts#USER_PROMPT_PREFIX': 'the extraction prompt',
  'payments/question-fields.ts#PROMPT': 'the prompt that picks fields for a question',
};

const FROZEN = ['squads/', 'agents/payment-automation.ts', 'payments/release-gate.ts'];

const EM_DASH_IN_PROSE = /[A-Za-z0-9.,)’'"”]\s?—\s?[A-Za-z0-9(‘'"“$]/;

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return name.endsWith('.ts') ? [full] : [];
  });
}

const rel = (file: string) => path.relative(SRC, file).split(path.sep).join('/');
const isFrozen = (r: string) => FROZEN.some((entry) => (entry.endsWith('/') ? r.startsWith(entry) : r === entry));

// The names a source file declares at its top level.
function topLevelNames(sf: ts.SourceFile): string[] {
  return sf.statements.flatMap((s) => {
    if (ts.isVariableStatement(s)) return s.declarationList.declarations.map((d) => d.name.getText(sf));
    if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name) return [s.name.text];
    return [];
  });
}

// The top-level declaration a node sits in.
function topLevelOf(node: ts.Node): string {
  let p = node;
  while (p.parent && !ts.isSourceFile(p.parent)) p = p.parent;
  if (ts.isVariableStatement(p)) return p.declarationList.declarations.map((d) => d.name.getText()).join(',');
  if ((ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p)) && p.name) return p.name.text;
  return '';
}

function inLogCall(node: ts.Node): boolean {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isCallExpression(p) && /^(logger|console)\./.test(p.expression.getText())) return true;
  }
  return false;
}

type Hit = { file: string; line: number; text: string };

function dashesIn(file: string): Hit[] {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const r = rel(file);
  const hits: Hit[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    const isText =
      ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
    if (isText && EM_DASH_IN_PROSE.test(node.text) && !inLogCall(node) && !(`${r}#${topLevelOf(node)}` in MODEL_TEXT)) {
      hits.push({ file: r, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: node.text.replace(/\s+/g, ' ').trim().slice(0, 90) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

const held = tsFiles(SRC).filter((f) => !isFrozen(rel(f)));

test('the API scan reads the API, not nothing', () => {
  assert.ok(held.length > 100, `only ${held.length} API files are held to the rule`);
  assert.ok(held.some((f) => rel(f) === 'payments/bill-flags.ts'), "the bill flags, which pages show as written, aren't being scanned");
});

test('every model-text and frozen entry still exists, so both lists only shrink', () => {
  const gone = Object.keys(MODEL_TEXT).filter((key) => {
    const [file, name] = key.split('#') as [string, string];
    const full = path.join(SRC, file);
    if (!existsSync(full)) return true;
    return !topLevelNames(ts.createSourceFile(full, readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true)).includes(name);
  });
  const frozenGone = FROZEN.filter((entry) => !existsSync(path.join(SRC, entry)));
  assert.deepEqual([...gone, ...frozenGone], [], 'Take these off MODEL_TEXT or FROZEN');
});

test('copy the API writes has no em dashes between words', () => {
  const hits = held.flatMap(dashesIn);
  assert.equal(
    hits.length,
    0,
    `Em dashes in copy the API writes (PAGE-PLAYBOOK, Copy); use a full stop, a colon or a comma. If it is text for a model, add its declaration to MODEL_TEXT with why:\n${hits
      .map((h) => `  api/src/${h.file}:${h.line}  ${JSON.stringify(h.text)}`)
      .join('\n')}`,
  );
});
