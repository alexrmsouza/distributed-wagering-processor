import { describe, expect, test } from 'bun:test';

import {
  createLoadPlan,
  executeLoadPlan,
  type LoadDispatchResult,
  type LoadPlanConfiguration,
} from '../../../scripts/load.js';

const configuration: LoadPlanConfiguration = {
  seed: 'distributed-load-seed',
  runId: 'run-a',
  operationCount: 100,
  occurredAt: '2026-09-04T12:00:00.000Z',
  hotWallet: {
    walletId: '9c8576bb-d350-490b-a0eb-a91af3a19e6a',
    playerId: 'cff0c56c-019a-438c-a880-1680c537141e',
  },
  independentWallets: [
    {
      walletId: '4ae56fa6-e194-4e53-b6d4-4eb19179962f',
      playerId: '5ee1ef97-09f9-44bf-aa22-e9a5646d369c',
    },
    {
      walletId: 'ba75082a-a3be-4bb8-8b00-ac75192d163d',
      playerId: 'dd0d8cc1-4b47-426f-bc4a-d5a805f7e22a',
    },
  ],
};

describe('seeded load generator', () => {
  test('uses an isolated deterministic artifact lifecycle', async () => {
    const loadModule = (await import('../../../scripts/load.js')) as Record<string, unknown>;
    expect(loadModule.resolveLoadArtifactPaths).toBeFunction();
    const resolveLoadArtifactPaths = loadModule.resolveLoadArtifactPaths as (
      root: string,
      runId: string,
    ) => Record<string, string>;
    expect(resolveLoadArtifactPaths('artifacts/load', 'evaluation-run')).toEqual({
      directory: 'artifacts/load/evaluation-run',
      executionJson: 'artifacts/load/evaluation-run/execution.json',
      reportJson: 'artifacts/load/evaluation-run/report.json',
      reportMarkdown: 'artifacts/load/evaluation-run/report.md',
    });
    expect(() => resolveLoadArtifactPaths('artifacts/load', '../unsafe')).toThrow(
      'runId must be a safe artifact identifier',
    );
  });

  test('creates a reproducible mixed plan with the documented traffic profile', () => {
    const first = createLoadPlan(configuration);
    const second = createLoadPlan(configuration);

    expect(first).toEqual(second);
    expect(first.operations).toHaveLength(100);
    expect(first.profile).toEqual({
      hotWallet: 55,
      exactDuplicate: 20,
      independentWallet: 15,
      outOfOrderReference: 10,
    });
    expect(new Set(first.operations.map((operation) => operation.transport))).toEqual(
      new Set(['http', 'sqs']),
    );
  });

  test('preserves one canonical business command across duplicate transports', () => {
    const duplicateOperations = createLoadPlan(configuration).operations.filter(
      (operation) => operation.scenario === 'exact_duplicate',
    );

    expect(duplicateOperations).toHaveLength(20);
    expect(new Set(duplicateOperations.map((operation) => operation.transport))).toEqual(
      new Set(['http', 'sqs']),
    );
    expect(
      new Set(duplicateOperations.map((operation) => JSON.stringify(operation.command))).size,
    ).toBe(1);
    expect(new Set(duplicateOperations.map((operation) => operation.envelope.messageId)).size).toBe(
      duplicateOperations.length,
    );
  });

  test('isolates business and transport identities by run', () => {
    const first = createLoadPlan(configuration);
    const second = createLoadPlan({ ...configuration, runId: 'run-b' });
    const firstBusinessIdentities = new Set(
      first.operations.map((operation) => operation.command.externalTransactionId),
    );
    const firstMessageIdentities = new Set(
      first.operations.map((operation) => operation.envelope.messageId),
    );

    expect(
      second.operations.every(
        (operation) => !firstBusinessIdentities.has(operation.command.externalTransactionId),
      ),
    ).toBeTrue();
    expect(
      second.operations.every(
        (operation) => !firstMessageIdentities.has(operation.envelope.messageId),
      ),
    ).toBeTrue();
  });

  test('orders pending reversals before their referenced source commands', () => {
    const operations = createLoadPlan(configuration).operations;
    const outOfOrder = operations.filter(
      (operation) => operation.scenario === 'out_of_order_reference',
    );

    for (let index = 0; index < outOfOrder.length; index += 2) {
      const reversal = outOfOrder[index];
      const source = outOfOrder[index + 1];

      expect(reversal?.command.kind).toBe('REFUND');
      expect(reversal?.command.referenceExternalTransactionId).toBe(
        source?.command.externalTransactionId,
      );
      expect(reversal?.command.roundId).toBe(source?.command.roundId);
      expect(reversal?.command.gameId).toBe(source?.command.gameId);
      expect(reversal?.command.playerId).toBe(source?.command.playerId);
      expect(reversal?.command.walletId).toBe(source?.command.walletId);
      expect(reversal?.command.money).toEqual(source?.command.money);
      expect(source?.command.kind).toBe('BET');
      expect(reversal?.transport).toBe('http');
      expect(source?.transport).toBe('sqs');
      expect(source?.afterOperationId).toBe(reversal?.operationId);
    }
  });

  test('does not dispatch a reference source before its reversal is accepted', async () => {
    const plan = createLoadPlan({ ...configuration, operationCount: 20 });
    const completed = new Set<string>();
    const violations: string[] = [];
    const dispatch = async (operation: (typeof plan.operations)[number]) => {
      if (operation.command.kind === 'REFUND') {
        await Bun.sleep(5);
        completed.add(operation.operationId);
      }
      if (operation.afterOperationId !== undefined && !completed.has(operation.afterOperationId)) {
        violations.push(operation.operationId);
      }
      return { outcome: 'processed' as const };
    };

    await executeLoadPlan(plan, { http: dispatch, sqs: dispatch }, { concurrency: 20 });

    expect(violations).toEqual([]);
  });

  test('captures bounded caller-side results without business payloads or money', async () => {
    const plan = createLoadPlan({ ...configuration, operationCount: 20 });
    let active = 0;
    let maximumActive = 0;
    const dispatch = async (): Promise<LoadDispatchResult> => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Bun.sleep(2);
      active -= 1;
      return { outcome: 'processed', statusCode: 200, idempotentReplay: false };
    };

    const result = await executeLoadPlan(
      plan,
      { http: dispatch, sqs: dispatch },
      {
        concurrency: 3,
        operationTimeoutMs: 1_000,
        runTimeoutMs: 5_000,
      },
    );

    expect(maximumActive).toBeLessThanOrEqual(3);
    expect(result.traffic.attempted).toBe(20);
    expect(result.traffic.completed).toBe(20);
    expect(result.traffic.terminalLatencyMs).toHaveLength(20);
    expect(result.outcomes.processed).toBe(20);
    expect(result.samples).toHaveLength(20);
    expect(JSON.stringify(result)).not.toContain('amount');
    expect(JSON.stringify(result)).not.toContain('money');
    expect(JSON.stringify(result)).not.toContain('1.00');
  });

  test('separates transient attempts from completed terminal operations', async () => {
    const plan = createLoadPlan({ ...configuration, operationCount: 20 });
    let attempts = 0;
    const dispatch = (): Promise<LoadDispatchResult> => {
      attempts += 1;
      return Promise.resolve(
        attempts === 1 ? { outcome: 'transient_error' } : { outcome: 'processed' },
      );
    };

    const result = await executeLoadPlan(plan, { http: dispatch, sqs: dispatch });

    expect(result.traffic.attempted).toBe(20);
    expect(result.traffic.completed).toBe(19);
    expect(result.traffic.terminalLatencyMs).toHaveLength(19);
    expect(result.outcomes.transientError).toBe(1);
  });
});
