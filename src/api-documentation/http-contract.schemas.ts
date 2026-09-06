import { z } from 'zod';

const identifier = z.string().trim().min(1).max(255);
const uuid = z.uuid();

export const publicMoneySchema = z
  .object({
    amount: z.string().regex(/^\d+\.\d{2}$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
  })
  .strict();

export const signedMoneySchema = z
  .object({
    amount: z.string().regex(/^-?\d+\.\d{2}$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
  })
  .strict();

export const createWalletRequestSchema = z
  .object({
    playerId: uuid,
    initialBalance: publicMoneySchema,
  })
  .strict();

export const walletResponseSchema = z
  .object({
    id: uuid,
    playerId: uuid,
    balance: publicMoneySchema,
    version: z.number().int().nonnegative(),
  })
  .strict();

export const ledgerEntryResponseSchema = z
  .object({
    id: uuid,
    walletId: uuid,
    transactionId: uuid,
    entrySequence: z.number().int().positive(),
    direction: z.enum(['CREDIT', 'DEBIT']),
    amount: publicMoneySchema,
    balanceBefore: publicMoneySchema,
    balanceAfter: publicMoneySchema,
    previousEntryHash: z.string().nullable(),
    entryHash: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.iso.datetime(),
  })
  .strict();

export const ledgerPageResponseSchema = z
  .object({
    items: z.array(ledgerEntryResponseSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export const reconciliationResponseSchema = z
  .object({
    walletId: uuid,
    storedBalance: publicMoneySchema,
    calculatedBalance: publicMoneySchema,
    accountingBalance: publicMoneySchema,
    difference: signedMoneySchema,
    consistent: z.boolean(),
    checkedEntries: z.number().int().nonnegative(),
    accountingBalanced: z.boolean(),
    auditChainValid: z.boolean(),
  })
  .strict();

export const wagerRequestSchema = z
  .object({
    providerId: z.string().trim().min(1).max(128),
    externalTransactionId: identifier,
    playerId: uuid,
    walletId: uuid,
    roundId: identifier,
    gameId: identifier,
    kind: z.enum(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']),
    money: publicMoneySchema,
    referenceExternalTransactionId: identifier.optional(),
  })
  .strict();

export const wagerOutcomeResponseSchema = z
  .object({
    transactionId: uuid,
    status: z.enum(['FAILED', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED']),
    balance: publicMoneySchema,
    idempotentReplay: z.boolean(),
    failureCode: z.string().optional(),
  })
  .strict();

export const wagerTransactionResponseSchema = z
  .object({
    transactionId: uuid,
    providerId: z.string(),
    externalTransactionId: z.string(),
    idempotencyKey: z.string(),
    walletId: uuid,
    playerId: uuid,
    roundId: z.string(),
    gameId: z.string(),
    kind: z.enum(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']),
    money: publicMoneySchema,
    referenceExternalTransactionId: z.string().nullable(),
    referenceTransactionId: uuid.nullable(),
    status: z.enum(['FAILED', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED']),
    failureCode: z.string().nullable(),
    observedBalance: publicMoneySchema.nullable(),
    processedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .strict();

export const errorResponseSchema = z
  .object({
    failureCode: z.string(),
    message: z.string(),
  })
  .strict();

export const livenessResponseSchema = z.object({ status: z.literal('ok') }).strict();

export const readinessResponseSchema = z
  .object({
    status: z.enum(['ready', 'not_ready']),
    checks: z
      .object({
        database: z.object({ status: z.enum(['up', 'down']) }).strict(),
        sqs: z.object({ status: z.enum(['up', 'down']) }).strict(),
      })
      .strict(),
  })
  .strict();

export const walletIdSchema = uuid;
export const transactionIdSchema = uuid;
export const providerIdentifierSchema = identifier;
export const idempotencyKeySchema = identifier;
export const ledgerLimitSchema = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(100));
