import { describe, expect, test } from 'bun:test';

import { Money } from '../../../../src/shared/domain/money.js';

const CREATED_AT = new Date('2026-09-04T12:00:00.000Z');
const JOURNAL_ID = '01991a20-7b40-7000-8000-000000000020';

async function createOpeningPostings(debit = '100.00', credit = '100.00') {
  const { AccountingPosting } =
    await import('../../../../src/accounting/domain/accounting-posting.js');

  return [
    AccountingPosting.create({
      id: '01991a20-7b40-7000-8000-000000000021',
      journalId: JOURNAL_ID,
      accountId: '01991a20-7b40-7000-8000-000000000022',
      direction: 'DEBIT',
      amount: Money.create({ amount: debit, currency: 'BRL' }),
      createdAt: CREATED_AT,
    }),
    AccountingPosting.create({
      id: '01991a20-7b40-7000-8000-000000000023',
      journalId: JOURNAL_ID,
      accountId: '01991a20-7b40-7000-8000-000000000024',
      direction: 'CREDIT',
      amount: Money.create({ amount: credit, currency: 'BRL' }),
      createdAt: CREATED_AT,
    }),
  ] as const;
}

async function loadJournal() {
  return import('../../../../src/accounting/domain/accounting-journal.js');
}

describe('AccountingJournal', () => {
  test('creates an immutable journal with exactly two balanced postings', async () => {
    const { AccountingJournal } = await loadJournal();
    const postings = await createOpeningPostings();
    const journal = AccountingJournal.create({
      id: JOURNAL_ID,
      transactionId: '01991a20-7b40-7000-8000-000000000025',
      walletId: '01991a20-7b40-7000-8000-000000000026',
      postings,
      createdAt: CREATED_AT,
    });

    expect(journal.postings).toHaveLength(2);
    expect(journal.debitTotal.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(journal.creditTotal.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(journal.isBalanced()).toBe(true);
    expect(Object.isFrozen(journal)).toBe(true);
    expect(Object.isFrozen(journal.postings)).toBe(true);
  });

  test('rejects an unbalanced journal', async () => {
    const { AccountingJournal, UnbalancedAccountingJournalError } = await loadJournal();
    const postings = await createOpeningPostings('100.00', '99.99');

    expect(() =>
      AccountingJournal.create({
        id: JOURNAL_ID,
        transactionId: '01991a20-7b40-7000-8000-000000000025',
        walletId: '01991a20-7b40-7000-8000-000000000026',
        postings,
        createdAt: CREATED_AT,
      }),
    ).toThrow(UnbalancedAccountingJournalError);
  });

  test('rejects a journal without exactly one debit and one credit', async () => {
    const { AccountingJournal, InvalidAccountingJournalError } = await loadJournal();
    const [debit] = await createOpeningPostings();

    expect(() =>
      AccountingJournal.create({
        id: JOURNAL_ID,
        transactionId: '01991a20-7b40-7000-8000-000000000025',
        walletId: '01991a20-7b40-7000-8000-000000000026',
        postings: [debit],
        createdAt: CREATED_AT,
      }),
    ).toThrow(InvalidAccountingJournalError);
  });

  test('rejects postings that belong to another journal', async () => {
    const { AccountingJournal, InvalidAccountingJournalError } = await loadJournal();
    const { AccountingPosting } =
      await import('../../../../src/accounting/domain/accounting-posting.js');
    const [debit] = await createOpeningPostings();
    const foreignPosting = AccountingPosting.create({
      id: '01991a20-7b40-7000-8000-000000000027',
      journalId: '01991a20-7b40-7000-8000-000000000099',
      accountId: '01991a20-7b40-7000-8000-000000000028',
      direction: 'CREDIT',
      amount: Money.create({ amount: '100.00', currency: 'BRL' }),
      createdAt: CREATED_AT,
    });

    expect(() =>
      AccountingJournal.create({
        id: JOURNAL_ID,
        transactionId: '01991a20-7b40-7000-8000-000000000025',
        walletId: '01991a20-7b40-7000-8000-000000000026',
        postings: [debit, foreignPosting],
        createdAt: CREATED_AT,
      }),
    ).toThrow(InvalidAccountingJournalError);
  });

  test('rejects postings in different currencies', async () => {
    const { AccountingJournal, InvalidAccountingJournalError } = await loadJournal();
    const { AccountingPosting } =
      await import('../../../../src/accounting/domain/accounting-posting.js');
    const [debit] = await createOpeningPostings();
    const usdCredit = AccountingPosting.create({
      id: '01991a20-7b40-7000-8000-000000000027',
      journalId: JOURNAL_ID,
      accountId: '01991a20-7b40-7000-8000-000000000028',
      direction: 'CREDIT',
      amount: Money.create({ amount: '100.00', currency: 'USD' }),
      createdAt: CREATED_AT,
    });

    expect(() =>
      AccountingJournal.create({
        id: JOURNAL_ID,
        transactionId: '01991a20-7b40-7000-8000-000000000025',
        walletId: '01991a20-7b40-7000-8000-000000000026',
        postings: [debit, usdCredit],
        createdAt: CREATED_AT,
      }),
    ).toThrow(InvalidAccountingJournalError);
  });
});
