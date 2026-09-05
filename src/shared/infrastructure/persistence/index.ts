import {
  AccountingJournalRowSchema,
  AccountingPostingRowSchema,
  AccountRowSchema,
  WagerTransactionRowSchema,
  WalletLedgerEntryRowSchema,
  WalletRowSchema,
} from './financial-row.schemas.js';
import { InboxMessageRowSchema, OutboxMessageRowSchema } from './message-row.schemas.js';

export const PERSISTENCE_SCHEMAS = [
  WalletRowSchema,
  WagerTransactionRowSchema,
  WalletLedgerEntryRowSchema,
  AccountRowSchema,
  AccountingJournalRowSchema,
  AccountingPostingRowSchema,
  InboxMessageRowSchema,
  OutboxMessageRowSchema,
];
