import type { TransactionBoundRepository } from '../../shared/application/transaction-runner.js';
import type { OutboxMessage } from '../domain/outbox-message.js';

export interface ClaimDueOutboxMessages {
  readonly now: Date;
  readonly leaseToken: string;
  readonly leaseExpiresAt: Date;
  readonly limit: number;
}

export interface OutboxRepository extends TransactionBoundRepository {
  insert(message: OutboxMessage): Promise<void>;
  claimDue(options: ClaimDueOutboxMessages): Promise<readonly OutboxMessage[]>;
  markPublished(outboxId: string, leaseToken: string, publishedAt: Date): Promise<boolean>;
  reschedule(
    outboxId: string,
    leaseToken: string,
    attempts: number,
    nextAttemptAt: Date,
  ): Promise<boolean>;
}
