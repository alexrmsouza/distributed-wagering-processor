import { AccountingJournal } from '../../accounting/domain/accounting-journal.js';
import { AccountingPosting } from '../../accounting/domain/accounting-posting.js';
import type { Money } from '../../shared/domain/money.js';
import type { ReversalDirection } from '../domain/reversal-rules.js';

interface WagerAccountingJournalInput {
  readonly journalId: string;
  readonly debitPostingId: string;
  readonly creditPostingId: string;
  readonly transactionId: string;
  readonly walletId: string;
  readonly playerAccountId: string;
  readonly clearingAccountId: string;
  readonly direction: ReversalDirection;
  readonly amount: Money;
  readonly occurredAt: Date;
}

export function createWagerAccountingJournal(
  input: WagerAccountingJournalInput,
): AccountingJournal {
  const debitAccountId =
    input.direction === 'DEBIT' ? input.playerAccountId : input.clearingAccountId;
  const creditAccountId =
    input.direction === 'DEBIT' ? input.clearingAccountId : input.playerAccountId;
  return AccountingJournal.create({
    id: input.journalId,
    transactionId: input.transactionId,
    walletId: input.walletId,
    createdAt: input.occurredAt,
    postings: [
      AccountingPosting.create({
        id: input.debitPostingId,
        journalId: input.journalId,
        accountId: debitAccountId,
        direction: 'DEBIT',
        amount: input.amount,
        createdAt: input.occurredAt,
      }),
      AccountingPosting.create({
        id: input.creditPostingId,
        journalId: input.journalId,
        accountId: creditAccountId,
        direction: 'CREDIT',
        amount: input.amount,
        createdAt: input.occurredAt,
      }),
    ],
  });
}
