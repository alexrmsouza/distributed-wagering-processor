import { describe, expect, test } from 'bun:test';
import { ESLint } from 'eslint';

const eslint = new ESLint();

async function lintRuleIds(source: string, filePath: string): Promise<readonly (string | null)[]> {
  const [result] = await eslint.lintText(source, { filePath });
  if (result === undefined) {
    throw new Error(`ESLint returned no result for ${filePath}`);
  }
  return result.messages.map((message) => message.ruleId);
}

describe('ESLint architecture guardrails', () => {
  test('rejects framework and infrastructure dependencies from domain code', async () => {
    const ruleIds = await lintRuleIds(
      [
        "import { Injectable } from '@nestjs/common';",
        "import { Adapter } from '../infrastructure/adapter.js';",
        'export const dependencies = [Injectable, Adapter];',
      ].join('\n'),
      'src/wallet/domain/wallet.ts',
    );

    expect(ruleIds.filter((ruleId) => ruleId === 'no-restricted-imports')).toHaveLength(2);
  });

  test('rejects infrastructure dependencies from application code', async () => {
    const ruleIds = await lintRuleIds(
      [
        "import { Adapter } from '../infrastructure/adapter.js';",
        'export const dependency = Adapter;',
      ].join('\n'),
      'src/wallet/application/create-wallet.use-case.ts',
    );

    expect(ruleIds).toContain('no-restricted-imports');
  });

  test('rejects unsafe numeric conversion and rounding in financial domains', async () => {
    const ruleIds = await lintRuleIds(
      ['export const amount = Number("1.23");', 'export const rounded = Math.round(amount);'].join(
        '\n',
      ),
      'src/wallet/domain/wallet.ts',
    );

    expect(ruleIds.filter((ruleId) => ruleId === 'no-restricted-syntax')).toHaveLength(2);
  });
});
