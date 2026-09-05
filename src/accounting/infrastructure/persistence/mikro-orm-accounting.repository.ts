import type { EntityManager } from '@mikro-orm/core';

import {
  executeStatement,
  queryRows,
} from '../../../shared/infrastructure/persistence/transactional-query.js';
import type {
  AccountingRepository,
  WalletAccountingPosting,
} from '../../application/ports/accounting.repository.js';
import { Account, type AccountKind } from '../../domain/account.js';
import type { AccountingJournal } from '../../domain/accounting-journal.js';
import type { PostingDirection } from '../../domain/accounting-posting.js';

interface AccountDatabaseRow {
  readonly id: string;
  readonly kind: AccountKind;
  readonly owner_id: string;
  readonly currency: string;
  readonly created_at: Date;
}

interface WalletAccountingPostingDatabaseRow {
  readonly journal_id: string;
  readonly account_kind: AccountKind;
  readonly account_owner_id: string;
  readonly direction: PostingDirection;
  readonly amount_minor: string | bigint;
  readonly currency: string;
}

export class MikroOrmAccountingRepository implements AccountingRepository {
  public readonly transactionBound = true as const;

  public constructor(private readonly entityManager: EntityManager) {}

  public async getOrCreateAccount(account: Account): Promise<Account> {
    const state = account.toState();
    await executeStatement(
      this.entityManager,
      `insert into accounts (id, kind, owner_id, currency, created_at)
       values (?, ?, ?, ?, ?)
       on conflict (kind, owner_id, currency) do nothing`,
      [state.id, state.kind, state.ownerId, state.currency, state.createdAt],
    );

    const rows = await queryRows<AccountDatabaseRow>(
      this.entityManager,
      `select id, kind, owner_id, currency, created_at
         from accounts
        where kind = ? and owner_id = ? and currency = ?`,
      [state.kind, state.ownerId, state.currency],
    );
    const persisted = rows[0];
    if (persisted === undefined) {
      throw new Error('Account creation did not produce a persisted account');
    }

    return Account.rehydrate({
      id: persisted.id,
      kind: persisted.kind,
      ownerId: persisted.owner_id,
      currency: persisted.currency.trim(),
      createdAt: new Date(persisted.created_at),
    });
  }

  public async insertJournal(journal: AccountingJournal): Promise<void> {
    await executeStatement(
      this.entityManager,
      `insert into accounting_journals (id, transaction_id, wallet_id, created_at)
       values (?, ?, ?, ?)`,
      [journal.id, journal.transactionId, journal.walletId, journal.createdAt],
    );

    for (const posting of journal.postings) {
      const state = posting.toState();
      await executeStatement(
        this.entityManager,
        `insert into accounting_postings
           (id, journal_id, account_id, direction, amount_minor, currency, created_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
        [
          state.id,
          state.journalId,
          state.accountId,
          state.direction,
          state.amountMinor.toString(),
          state.currency,
          state.createdAt,
        ],
      );
    }
  }

  public async listWalletPostings(walletId: string): Promise<readonly WalletAccountingPosting[]> {
    const rows = await queryRows<WalletAccountingPostingDatabaseRow>(
      this.entityManager,
      `select posting.journal_id, account.kind as account_kind,
              account.owner_id as account_owner_id, posting.direction,
              posting.amount_minor, posting.currency
         from accounting_journals journal
         join accounting_postings posting on posting.journal_id = journal.id
         join accounts account on account.id = posting.account_id
        where journal.wallet_id = ?
        order by journal.created_at, journal.id, posting.id`,
      [walletId],
    );

    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          journalId: row.journal_id,
          accountKind: row.account_kind,
          accountOwnerId: row.account_owner_id,
          direction: row.direction,
          amountMinor: BigInt(row.amount_minor),
          currency: row.currency.trim(),
        }),
      ),
    );
  }
}
