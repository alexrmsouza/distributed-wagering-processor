import { EntitySchema } from '@mikro-orm/core';

export class WalletRow {
  declare id: string;
  declare playerId: string;
  declare currency: string;
  declare balanceMinor: bigint;
  declare version: bigint;
  declare ledgerSequence: bigint;
  declare lastLedgerHash: string | null;
  declare createdAt: Date;
  declare updatedAt: Date;
}

export class WagerTransactionRow {
  declare id: string;
  declare providerId: string;
  declare externalTransactionId: string;
  declare idempotencyKey: string;
  declare payloadHash: string;
  declare walletId: string;
  declare playerId: string;
  declare roundId: string;
  declare gameId: string;
  declare kind: string;
  declare amountMinor: bigint;
  declare currency: string;
  declare referenceExternalTransactionId: string | null;
  declare referenceTransactionId: string | null;
  declare status: string;
  declare failureCode: string | null;
  declare observedBalanceMinor: bigint | null;
  declare observedBalanceCurrency: string | null;
  declare retryAttempts: number;
  declare nextRetryAt: Date | null;
  declare retryExpiresAt: Date | null;
  declare pendingCorrelationId: string | null;
  declare pendingCausationId: string | null;
  declare pendingLeaseToken: string | null;
  declare pendingLeaseExpiresAt: Date | null;
  declare processedAt: Date | null;
  declare createdAt: Date;
  declare updatedAt: Date;
}

export class WalletLedgerEntryRow {
  declare id: string;
  declare walletId: string;
  declare transactionId: string;
  declare entrySequence: bigint;
  declare direction: string;
  declare amountMinor: bigint;
  declare currency: string;
  declare balanceBeforeMinor: bigint;
  declare balanceAfterMinor: bigint;
  declare previousEntryHash: string | null;
  declare entryHash: string;
  declare createdAt: Date;
}

export class AccountRow {
  declare id: string;
  declare kind: string;
  declare ownerId: string;
  declare currency: string;
  declare createdAt: Date;
}

export class AccountingJournalRow {
  declare id: string;
  declare transactionId: string;
  declare walletId: string;
  declare createdAt: Date;
}

export class AccountingPostingRow {
  declare id: string;
  declare journalId: string;
  declare accountId: string;
  declare direction: string;
  declare amountMinor: bigint;
  declare currency: string;
  declare createdAt: Date;
}

const timestamp = { type: Date } as const;
const uuid = { type: 'uuid' } as const;
const bigint = { type: 'bigint', runtimeType: 'bigint' } as const;

export const WalletRowSchema = new EntitySchema<WalletRow>({
  class: WalletRow,
  tableName: 'wallets',
  properties: {
    id: { ...uuid, primary: true },
    playerId: { ...uuid, fieldName: 'player_id' },
    currency: { type: 'string', length: 3 },
    balanceMinor: { ...bigint, fieldName: 'balance_minor' },
    version: bigint,
    ledgerSequence: { ...bigint, fieldName: 'ledger_sequence' },
    lastLedgerHash: { type: 'string', fieldName: 'last_ledger_hash', nullable: true, length: 64 },
    createdAt: { ...timestamp, fieldName: 'created_at' },
    updatedAt: { ...timestamp, fieldName: 'updated_at' },
  },
});

export const WagerTransactionRowSchema = new EntitySchema<WagerTransactionRow>({
  class: WagerTransactionRow,
  tableName: 'wager_transactions',
  properties: {
    id: { ...uuid, primary: true },
    providerId: { type: 'string', fieldName: 'provider_id' },
    externalTransactionId: { type: 'string', fieldName: 'external_transaction_id' },
    idempotencyKey: { type: 'string', fieldName: 'idempotency_key' },
    payloadHash: { type: 'string', fieldName: 'payload_hash', length: 64 },
    walletId: { ...uuid, fieldName: 'wallet_id' },
    playerId: { ...uuid, fieldName: 'player_id' },
    roundId: { type: 'string', fieldName: 'round_id' },
    gameId: { type: 'string', fieldName: 'game_id' },
    kind: { type: 'string' },
    amountMinor: { ...bigint, fieldName: 'amount_minor' },
    currency: { type: 'string', length: 3 },
    referenceExternalTransactionId: {
      type: 'string',
      fieldName: 'reference_external_transaction_id',
      nullable: true,
    },
    referenceTransactionId: {
      ...uuid,
      fieldName: 'reference_transaction_id',
      nullable: true,
    },
    status: { type: 'string' },
    failureCode: { type: 'string', fieldName: 'failure_code', nullable: true },
    observedBalanceMinor: {
      ...bigint,
      fieldName: 'observed_balance_minor',
      nullable: true,
    },
    observedBalanceCurrency: {
      type: 'string',
      fieldName: 'observed_balance_currency',
      nullable: true,
      length: 3,
    },
    retryAttempts: { type: 'integer', fieldName: 'retry_attempts' },
    nextRetryAt: { ...timestamp, fieldName: 'next_retry_at', nullable: true },
    retryExpiresAt: { ...timestamp, fieldName: 'retry_expires_at', nullable: true },
    pendingCorrelationId: {
      type: 'string',
      fieldName: 'pending_correlation_id',
      nullable: true,
    },
    pendingCausationId: {
      type: 'string',
      fieldName: 'pending_causation_id',
      nullable: true,
    },
    pendingLeaseToken: {
      ...uuid,
      fieldName: 'pending_lease_token',
      nullable: true,
    },
    pendingLeaseExpiresAt: {
      ...timestamp,
      fieldName: 'pending_lease_expires_at',
      nullable: true,
    },
    processedAt: { ...timestamp, fieldName: 'processed_at', nullable: true },
    createdAt: { ...timestamp, fieldName: 'created_at' },
    updatedAt: { ...timestamp, fieldName: 'updated_at' },
  },
});

export const WalletLedgerEntryRowSchema = new EntitySchema<WalletLedgerEntryRow>({
  class: WalletLedgerEntryRow,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { ...uuid, primary: true },
    walletId: { ...uuid, fieldName: 'wallet_id' },
    transactionId: { ...uuid, fieldName: 'transaction_id' },
    entrySequence: { ...bigint, fieldName: 'entry_sequence' },
    direction: { type: 'string' },
    amountMinor: { ...bigint, fieldName: 'amount_minor' },
    currency: { type: 'string', length: 3 },
    balanceBeforeMinor: { ...bigint, fieldName: 'balance_before_minor' },
    balanceAfterMinor: { ...bigint, fieldName: 'balance_after_minor' },
    previousEntryHash: {
      type: 'string',
      fieldName: 'previous_entry_hash',
      nullable: true,
      length: 64,
    },
    entryHash: { type: 'string', fieldName: 'entry_hash', length: 64 },
    createdAt: { ...timestamp, fieldName: 'created_at' },
  },
});

export const AccountRowSchema = new EntitySchema<AccountRow>({
  class: AccountRow,
  tableName: 'accounts',
  properties: {
    id: { ...uuid, primary: true },
    kind: { type: 'string' },
    ownerId: { type: 'string', fieldName: 'owner_id' },
    currency: { type: 'string', length: 3 },
    createdAt: { ...timestamp, fieldName: 'created_at' },
  },
});

export const AccountingJournalRowSchema = new EntitySchema<AccountingJournalRow>({
  class: AccountingJournalRow,
  tableName: 'accounting_journals',
  properties: {
    id: { ...uuid, primary: true },
    transactionId: { ...uuid, fieldName: 'transaction_id' },
    walletId: { ...uuid, fieldName: 'wallet_id' },
    createdAt: { ...timestamp, fieldName: 'created_at' },
  },
});

export const AccountingPostingRowSchema = new EntitySchema<AccountingPostingRow>({
  class: AccountingPostingRow,
  tableName: 'accounting_postings',
  properties: {
    id: { ...uuid, primary: true },
    journalId: { ...uuid, fieldName: 'journal_id' },
    accountId: { ...uuid, fieldName: 'account_id' },
    direction: { type: 'string' },
    amountMinor: { ...bigint, fieldName: 'amount_minor' },
    currency: { type: 'string', length: 3 },
    createdAt: { ...timestamp, fieldName: 'created_at' },
  },
});
