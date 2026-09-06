import type { CorrelationContext } from '../../shared/application/correlation-context.js';

export const DIAGNOSTIC_EVENT_NAMES = Object.freeze([
  'received',
  'idempotency_decision',
  'wallet_lock',
  'outbox_persisted',
  'transaction_committed',
  'acknowledged',
  'outbox_claimed',
  'outbox_blocked',
  'outbox_replayed',
  'published',
  'retry_scheduled',
  'dead_letter_observed',
  'reconciliation_diverged',
  'failpoint_activated',
] as const);

export type DiagnosticEventName = (typeof DIAGNOSTIC_EVENT_NAMES)[number];
export type DiagnosticAttributes = Readonly<Record<string, unknown>>;

export interface OperationalLogger {
  info(
    event: DiagnosticEventName,
    context: CorrelationContext,
    attributes?: DiagnosticAttributes,
  ): void;
}

export const NOOP_OPERATIONAL_LOGGER: OperationalLogger = Object.freeze({
  info: () => undefined,
});
