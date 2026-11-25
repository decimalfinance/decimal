// Reads back what generate.mjs wrote and fails loudly if the exam is inconsistent.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addMonths } from './util.mjs';
import { checkBooks } from './check-books.mjs';
import { checkAnswers } from './check-answers.mjs';
import { checkExpectations } from './check-spec.mjs';

export function checkAll({ dir, today, ids }) {
  const since = addMonths(today, -24);
  const problems = [];
  for (const id of ids) {
    const fail = (message) => problems.push(`${id}: ${message}`);
    let co;
    let answers;
    try {
      co = JSON.parse(readFileSync(join(dir, 'companies', `${id}.json`), 'utf8'));
      answers = JSON.parse(readFileSync(join(dir, 'answers', `${id}.json`), 'utf8'));
    } catch (error) {
      fail(`could not read the written files: ${error.message}`);
      continue;
    }
    if (answers.companyId !== id) fail(`answers.companyId is ${answers.companyId}`);
    checkBooks(co, answers, today, since, fail);
    checkAnswers(co, answers, today, since, fail);
    checkExpectations(id, co, answers, today, since, fail);
  }
  return problems;
}
