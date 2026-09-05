import type { ProcessWagerTransactionCommand } from './process-wager-transaction.use-case.js';
import { InvalidWagerRequestError } from './wagering-errors.js';

const PROCESSABLE_WAGER_KINDS = new Set(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']);

export function createWagerBusinessPayload(
  command: ProcessWagerTransactionCommand,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    providerId: command.providerId,
    externalTransactionId: command.externalTransactionId,
    playerId: command.playerId,
    walletId: command.walletId,
    roundId: command.roundId,
    gameId: command.gameId,
    kind: command.kind,
    money: command.money.toJSON(),
    referenceExternalTransactionId: command.referenceExternalTransactionId ?? null,
  });
}

export function deterministicWagerResultId(payloadHash: string): string {
  const hexadecimal = Array.from(payloadHash.slice(0, 32));
  hexadecimal[12] = '5';
  hexadecimal[16] = ((Number.parseInt(hexadecimal[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  const value = hexadecimal.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

export function assertValidWagerCommand(command: ProcessWagerTransactionCommand): void {
  if (!PROCESSABLE_WAGER_KINDS.has(command.kind)) {
    throw new InvalidWagerRequestError('Wager transaction kind is not supported');
  }
  const isReversal = command.kind === 'REFUND' || command.kind === 'ROLLBACK';
  if (
    (isReversal &&
      (command.referenceExternalTransactionId === undefined ||
        command.referenceExternalTransactionId.length === 0 ||
        command.referenceExternalTransactionId.trim() !==
          command.referenceExternalTransactionId)) ||
    (!isReversal && command.referenceExternalTransactionId !== undefined)
  ) {
    throw new InvalidWagerRequestError(
      'Reference external transaction identity must match the transaction kind',
    );
  }
  if (command.money.amountMinor <= 0n) {
    throw new InvalidWagerRequestError('Wager transaction amount must be positive');
  }
  for (const value of [
    command.providerId,
    command.externalTransactionId,
    command.idempotencyKey,
    command.playerId,
    command.walletId,
    command.roundId,
    command.gameId,
    command.correlationId,
  ]) {
    if (value.length === 0 || value.trim() !== value) {
      throw new InvalidWagerRequestError();
    }
  }
}
