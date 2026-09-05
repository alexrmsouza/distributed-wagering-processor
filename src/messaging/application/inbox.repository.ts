import type { TransactionBoundRepository } from '../../shared/application/transaction-runner.js';
import type { InboxMessage } from '../domain/inbox-message.js';

export type InboxClaim = 'CLAIMED' | 'DUPLICATE';

export interface InboxRepository extends TransactionBoundRepository {
  claim(message: InboxMessage): Promise<InboxClaim>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | null>;
  save(message: InboxMessage): Promise<void>;
}
