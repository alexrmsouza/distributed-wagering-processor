import type { EntityManager } from '@mikro-orm/core';

import { executeStatement } from '../../../shared/infrastructure/persistence/transactional-query.js';
import type {
  OpeningTransactionRepository,
  OpeningTransactionState,
} from '../../application/ports/opening-transaction.repository.js';

export class MikroOrmOpeningTransactionRepository implements OpeningTransactionRepository {
  public readonly transactionBound = true as const;

  public constructor(private readonly entityManager: EntityManager) {}

  public async insertOpening(state: OpeningTransactionState): Promise<void> {
    await executeStatement(
      this.entityManager,
      `insert into wager_transactions
         (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id, kind, amount_minor, currency,
          status, observed_balance_minor, observed_balance_currency, retry_attempts,
          processed_at, created_at, updated_at)
       values (?, 'internal', ?, ?, ?, ?, ?, 'wallet-opening', 'wallet-opening',
               'OPENING', ?, ?, 'PROCESSED', ?, ?, 0, ?, ?, ?)`,
      [
        state.id,
        state.externalTransactionId,
        state.idempotencyKey,
        state.payloadHash,
        state.walletId,
        state.playerId,
        state.amountMinor.toString(),
        state.currency,
        state.observedBalanceMinor.toString(),
        state.currency,
        state.occurredAt,
        state.occurredAt,
        state.occurredAt,
      ],
    );
  }
}
