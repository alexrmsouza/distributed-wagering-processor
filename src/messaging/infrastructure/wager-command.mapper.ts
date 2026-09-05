import { z } from 'zod';

import type { ProcessWagerTransactionCommand } from '../../wagering/application/process-wager-transaction.use-case.js';
import { cloneAndFreezeCanonicalJson } from '../../shared/domain/immutable-json.js';
import { Money } from '../../shared/domain/money.js';
import { hashPayload } from '../../shared/domain/payload-hash.js';

const normalizedIdentifier = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value.trim() === value, 'Identifier must be normalized');
const providerIdentifier = normalizedIdentifier.refine((value) => value.length <= 128);
const exactTimestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => {
    const timestamp = new Date(value);
    return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
  }, 'Timestamp must be valid');
const moneySchema = z
  .object({ amount: z.string(), currency: z.string() })
  .strict()
  .superRefine((value, context) => {
    try {
      const money = Money.create(value);
      if (money.amountMinor <= 0n) {
        context.addIssue({ code: 'custom', message: 'Wager amount must be positive' });
      }
    } catch (error: unknown) {
      context.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : 'Money is invalid',
      });
    }
  });
const baseDataShape = {
  providerId: providerIdentifier,
  externalTransactionId: normalizedIdentifier,
  idempotencyKey: normalizedIdentifier,
  playerId: z.uuid(),
  walletId: z.uuid(),
  roundId: normalizedIdentifier,
  gameId: normalizedIdentifier,
  money: moneySchema,
} as const;
const wagerDataSchema = z.discriminatedUnion('kind', [
  z.object({ ...baseDataShape, kind: z.literal('BET') }).strict(),
  z.object({ ...baseDataShape, kind: z.literal('WIN') }).strict(),
  z.object({ ...baseDataShape, kind: z.literal('LOSS') }).strict(),
  z
    .object({
      ...baseDataShape,
      kind: z.literal('REFUND'),
      referenceExternalTransactionId: normalizedIdentifier,
    })
    .strict(),
  z
    .object({
      ...baseDataShape,
      kind: z.literal('ROLLBACK'),
      referenceExternalTransactionId: normalizedIdentifier,
    })
    .strict(),
]);
const wagerCommandEnvelopeSchema = z
  .object({
    messageId: normalizedIdentifier,
    type: z.literal('WagerTransactionRequested'),
    occurredAt: exactTimestamp,
    data: wagerDataSchema,
  })
  .strict();

type WagerCommandEnvelope = Readonly<z.output<typeof wagerCommandEnvelopeSchema>>;

export interface MappedWagerCommand {
  readonly envelope: WagerCommandEnvelope;
  readonly payloadHash: string;
  readonly command: ProcessWagerTransactionCommand;
}

export class MalformedWagerCommandError extends Error {
  public readonly redrive = true;

  public constructor(cause?: unknown) {
    super('SQS command envelope is malformed', { cause });
    this.name = 'MalformedWagerCommandError';
  }
}

export const WagerCommandMapper = Object.freeze({
  map(body: string): MappedWagerCommand {
    try {
      const envelope = cloneAndFreezeCanonicalJson(
        wagerCommandEnvelopeSchema.parse(JSON.parse(body) as unknown),
      );
      const money = Money.create(envelope.data.money);
      if (money.amountMinor <= 0n) {
        throw new TypeError('Wager amount must be positive');
      }
      const command = Object.freeze({
        providerId: envelope.data.providerId,
        externalTransactionId: envelope.data.externalTransactionId,
        idempotencyKey: envelope.data.idempotencyKey,
        playerId: envelope.data.playerId,
        walletId: envelope.data.walletId,
        roundId: envelope.data.roundId,
        gameId: envelope.data.gameId,
        kind: envelope.data.kind,
        money,
        ...('referenceExternalTransactionId' in envelope.data
          ? { referenceExternalTransactionId: envelope.data.referenceExternalTransactionId }
          : {}),
        correlationId: envelope.messageId,
        causationId: envelope.messageId,
      });

      return Object.freeze({ envelope, payloadHash: hashPayload(envelope), command });
    } catch (error: unknown) {
      if (error instanceof MalformedWagerCommandError) {
        throw error;
      }
      throw new MalformedWagerCommandError(error);
    }
  },
});
