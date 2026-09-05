import type { Clock } from '../../shared/application/clock.js';
import { SystemClock } from '../../shared/application/clock.js';
import type { CorrelationContext } from '../../shared/application/correlation-context.js';
import {
  DIAGNOSTIC_EVENT_NAMES,
  type DiagnosticAttributes,
  type DiagnosticEventName,
  type OperationalLogger,
} from '../application/operational-logger.js';

const REDACTION_MARKER = '[REDACTED]';

export interface RedactingJsonLoggerOptions {
  readonly write?: (line: string) => void;
  readonly clock?: Clock;
}

const SUPPORTED_EVENTS = new Set<string>(DIAGNOSTIC_EVENT_NAMES);
const SENSITIVE_KEY =
  /(?:money|amount|payload|body|headers?|authorization|cookie|receipt.?handle|connection.?string|password|secret|token|credentials?|error)/i;
const MONEY_VALUE = /^-?\d+\.\d{2}$/;
const CREDENTIAL_URL = /^[a-z][a-z0-9+.-]*:\/\/[^\s/:]+:[^\s/@]+@/i;
const AUTHORIZATION_VALUE = /^(?:basic|bearer)\s+/i;
const RESERVED_FIELDS = new Set([
  'level',
  'time',
  'event',
  'correlationId',
  'messageId',
  'transactionId',
  'walletId',
  'providerId',
  'outboxMessageId',
  'eventId',
  'causationId',
]);

function redactValue(value: unknown, key: string | undefined, seen: WeakSet<object>): unknown {
  const normalizedKey = key?.replaceAll(/[^a-z0-9]/gi, '').toLowerCase();
  if (
    key !== undefined &&
    (SENSITIVE_KEY.test(key) ||
      (normalizedKey?.includes('balance') === true && !normalizedKey.endsWith('balanced')))
  ) {
    return REDACTION_MARKER;
  }
  if (typeof value === 'string') {
    return MONEY_VALUE.test(value) || CREDENTIAL_URL.test(value) || AUTHORIZATION_VALUE.test(value)
      ? REDACTION_MARKER
      : value;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value !== 'object' || value instanceof Error || seen.has(value)) {
    return REDACTION_MARKER;
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, undefined, seen));
    }
    const redacted: Record<string, unknown> = {};
    for (const [property, propertyValue] of Object.entries(value)) {
      redacted[property] = redactValue(propertyValue, property, seen);
    }
    return redacted;
  } finally {
    seen.delete(value);
  }
}

export class RedactingJsonLogger implements OperationalLogger {
  readonly #write: (line: string) => void;
  readonly #clock: Clock;

  public constructor(options: RedactingJsonLoggerOptions = {}) {
    this.#write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
    this.#clock = options.clock ?? new SystemClock();
  }

  public info(
    event: DiagnosticEventName,
    context: CorrelationContext,
    attributes: DiagnosticAttributes = {},
  ): void {
    if (!SUPPORTED_EVENTS.has(event)) {
      throw new TypeError('Unsupported diagnostic event name');
    }
    const now = this.#clock.now();
    if (!Number.isFinite(now.getTime())) {
      throw new TypeError('Diagnostic clock returned an invalid instant');
    }

    const filteredAttributes = Object.fromEntries(
      Object.entries(attributes).filter(([name]) => !RESERVED_FIELDS.has(name)),
    );
    const record = {
      ...filteredAttributes,
      level: 'info',
      time: now.toISOString(),
      event,
      correlationId: context.correlationId,
      ...(context.messageId === undefined ? {} : { messageId: context.messageId }),
      ...(context.transactionId === undefined ? {} : { transactionId: context.transactionId }),
      ...(context.walletId === undefined ? {} : { walletId: context.walletId }),
      ...(context.providerId === undefined ? {} : { providerId: context.providerId }),
      ...(context.outboxMessageId === undefined
        ? {}
        : { outboxMessageId: context.outboxMessageId }),
      ...(context.eventId === undefined ? {} : { eventId: context.eventId }),
      ...(context.causationId === undefined ? {} : { causationId: context.causationId }),
    };
    this.#write(JSON.stringify(redactValue(record, undefined, new WeakSet())));
  }
}

let defaultLogger: RedactingJsonLogger | undefined;

export function getDefaultRedactingJsonLogger(): RedactingJsonLogger {
  defaultLogger ??= new RedactingJsonLogger();
  return defaultLogger;
}
