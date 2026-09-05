import { describe, expect, test } from 'bun:test';

import { WagerCommandMapper } from '../../../src/messaging/infrastructure/wager-command.mapper.js';

const PLAYER_ID = '9cb7f7ce-c61d-4f9d-9e89-af71f88ac5af';
const WALLET_ID = 'ed16ce6a-517e-4fe6-a8a1-a701eb2f2881';

type WagerKind = 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';

function envelopeFor(kind: WagerKind): Readonly<Record<string, unknown>> {
  const reversal = kind === 'REFUND' || kind === 'ROLLBACK';

  return {
    messageId: `message-${kind.toLowerCase()}`,
    type: 'WagerTransactionRequested',
    occurredAt: '2026-09-04T12:00:00.000Z',
    data: {
      providerId: 'provider-a',
      externalTransactionId: `transaction-${kind.toLowerCase()}`,
      idempotencyKey: `provider-a:transaction-${kind.toLowerCase()}`,
      playerId: PLAYER_ID,
      walletId: WALLET_ID,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind,
      money: { amount: '25.00', currency: 'BRL' },
      ...(reversal ? { referenceExternalTransactionId: 'transaction-bet' } : {}),
    },
  };
}

describe('WagerCommandMapper', () => {
  for (const kind of ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const) {
    test(`strictly parses and maps a valid ${kind} envelope`, () => {
      const envelope = envelopeFor(kind);

      const mapped = WagerCommandMapper.map(JSON.stringify(envelope));
      const { money, ...commandWithoutMoney } = mapped.command;

      expect(mapped.envelope).toEqual(envelope as typeof mapped.envelope);
      expect(commandWithoutMoney).toEqual({
        providerId: 'provider-a',
        externalTransactionId: `transaction-${kind.toLowerCase()}`,
        idempotencyKey: `provider-a:transaction-${kind.toLowerCase()}`,
        playerId: PLAYER_ID,
        walletId: WALLET_ID,
        roundId: 'round-987',
        gameId: 'fortune-chimp',
        kind,
        ...(kind === 'REFUND' || kind === 'ROLLBACK'
          ? { referenceExternalTransactionId: 'transaction-bet' }
          : {}),
        correlationId: `message-${kind.toLowerCase()}`,
        causationId: `message-${kind.toLowerCase()}`,
      });
      expect(money.amountMinor).toBe(2_500n);
      expect(money.currency).toBe('BRL');
      expect(money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
      expect(mapped.payloadHash).toMatch(/^[0-9a-f]{64}$/);
      expect(Object.isFrozen(mapped)).toBe(true);
      expect(Object.isFrozen(mapped.envelope)).toBe(true);
      expect(Object.isFrozen(mapped.envelope.data)).toBe(true);
      expect(Object.isFrozen(mapped.envelope.data.money)).toBe(true);
      expect(Object.isFrozen(mapped.command)).toBe(true);
    });
  }

  test('canonicalizes the complete validated envelope before hashing', () => {
    const envelope = envelopeFor('BET');
    const reorderedEnvelope = {
      data: {
        money: { currency: 'BRL', amount: '25.00' },
        kind: 'BET',
        gameId: 'fortune-chimp',
        roundId: 'round-987',
        walletId: WALLET_ID,
        playerId: PLAYER_ID,
        idempotencyKey: 'provider-a:transaction-bet',
        externalTransactionId: 'transaction-bet',
        providerId: 'provider-a',
      },
      occurredAt: '2026-09-04T12:00:00.000Z',
      type: 'WagerTransactionRequested',
      messageId: 'message-bet',
    };

    const compact = WagerCommandMapper.map(JSON.stringify(envelope));
    const reordered = WagerCommandMapper.map(JSON.stringify(reorderedEnvelope, null, 2));

    expect(compact.payloadHash).toBe(
      '8bc25e8691034fb397d31e060005ad60bbf5b84d855493a35e848dab6da6e6eb',
    );
    expect(reordered.payloadHash).toBe(compact.payloadHash);
    expect(
      WagerCommandMapper.map(JSON.stringify({ ...envelope, messageId: 'different-message-id' }))
        .payloadHash,
    ).not.toBe(compact.payloadHash);
    expect(
      WagerCommandMapper.map(
        JSON.stringify({ ...envelope, occurredAt: '2026-09-04T12:00:01.000Z' }),
      ).payloadHash,
    ).not.toBe(compact.payloadHash);
    expect(
      WagerCommandMapper.map(
        JSON.stringify({
          ...envelope,
          data: {
            ...(envelope.data as Record<string, unknown>),
            money: { amount: '25.01', currency: 'BRL' },
          },
        }),
      ).payloadHash,
    ).not.toBe(compact.payloadHash);
  });

  test('rejects malformed JSON and non-object envelope shapes', () => {
    for (const body of ['{"messageId":', 'null', '[]', '"WagerTransactionRequested"', '42']) {
      expect(() => WagerCommandMapper.map(body)).toThrow();
    }
  });

  test('rejects invalid or mutable envelope metadata', () => {
    const envelope = envelopeFor('BET');
    const invalidEnvelopes: readonly unknown[] = [
      { ...envelope, messageId: '' },
      { ...envelope, messageId: ' message-bet' },
      { ...envelope, type: 'WagerTransactionProcessed' },
      { ...envelope, type: 'wagerTransactionRequested' },
      { ...envelope, occurredAt: 'not-a-timestamp' },
      { ...envelope, occurredAt: '2026-02-30T12:00:00.000Z' },
      { ...envelope, occurredAt: '2026-09-04T12:00:00Z' },
      { ...envelope, occurredAt: '2026-09-04T09:00:00.000-03:00' },
      { ...envelope, unexpected: true },
    ];

    for (const invalidEnvelope of invalidEnvelopes) {
      expect(() => WagerCommandMapper.map(JSON.stringify(invalidEnvelope))).toThrow();
    }
  });

  test('rejects malformed data and unknown nested keys', () => {
    const envelope = envelopeFor('BET');
    const data = envelope.data as Record<string, unknown>;
    const invalidEnvelopes: readonly unknown[] = [
      { ...envelope, data: null },
      { ...envelope, data: [] },
      { ...envelope, data: { ...data, providerId: '' } },
      { ...envelope, data: { ...data, externalTransactionId: ' transaction-bet' } },
      { ...envelope, data: { ...data, idempotencyKey: '' } },
      { ...envelope, data: { ...data, playerId: 'player-id' } },
      { ...envelope, data: { ...data, walletId: 'wallet-id' } },
      { ...envelope, data: { ...data, roundId: '' } },
      { ...envelope, data: { ...data, gameId: 'fortune-chimp ' } },
      { ...envelope, data: { ...data, kind: 'CREDIT' } },
      { ...envelope, data: { ...data, unexpected: true } },
      {
        ...envelope,
        data: { ...data, money: { amount: '25.00', currency: 'BRL', scale: 2 } },
      },
    ];

    for (const invalidEnvelope of invalidEnvelopes) {
      expect(() => WagerCommandMapper.map(JSON.stringify(invalidEnvelope))).toThrow();
    }
  });

  test('enforces exact public Money strings', () => {
    const envelope = envelopeFor('BET');
    const data = envelope.data as Record<string, unknown>;
    const invalidMoney: readonly unknown[] = [
      { amount: 25, currency: 'BRL' },
      { amount: '25', currency: 'BRL' },
      { amount: '25.0', currency: 'BRL' },
      { amount: '25.000', currency: 'BRL' },
      { amount: '-25.00', currency: 'BRL' },
      { amount: '0.00', currency: 'BRL' },
      { amount: '25.00', currency: 'brl' },
      { amount: '25.00', currency: 'BRAZILIAN_REAL' },
    ];

    for (const money of invalidMoney) {
      expect(() =>
        WagerCommandMapper.map(JSON.stringify({ ...envelope, data: { ...data, money } })),
      ).toThrow();
    }
  });

  test('requires references only for reversal kinds', () => {
    const refund = envelopeFor('REFUND');
    const refundData = refund.data as Record<string, unknown>;
    const bet = envelopeFor('BET');
    const betData = bet.data as Record<string, unknown>;
    const invalidEnvelopes: readonly unknown[] = [
      {
        ...refund,
        data: Object.fromEntries(
          Object.entries(refundData).filter(([key]) => key !== 'referenceExternalTransactionId'),
        ),
      },
      { ...refund, data: { ...refundData, referenceExternalTransactionId: '' } },
      { ...refund, data: { ...refundData, referenceExternalTransactionId: ' transaction-bet' } },
      { ...bet, data: { ...betData, referenceExternalTransactionId: 'transaction-original' } },
    ];

    for (const invalidEnvelope of invalidEnvelopes) {
      expect(() => WagerCommandMapper.map(JSON.stringify(invalidEnvelope))).toThrow();
    }
  });
});
