import { randomUUID } from 'node:crypto';

import type { EntityManager } from '@mikro-orm/core';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';

import { IntegrationEvent } from '../../src/messaging/domain/integration-event.js';
import { OutboxMessage } from '../../src/messaging/domain/outbox-message.js';
import { MikroOrmOutboxRepository } from '../../src/messaging/infrastructure/outbox.repository.js';
import {
  createDatabaseTestContext,
  type DatabaseTestContext,
} from '../support/database-test-context.js';

let databaseContext: DatabaseTestContext | undefined;

setDefaultTimeout(60_000);

function context(): DatabaseTestContext {
  if (databaseContext === undefined) {
    throw new Error('Database test context is unavailable');
  }

  return databaseContext;
}

function outboxMessage(options: {
  readonly aggregateId: string;
  readonly occurredAt: Date;
  readonly nextAttemptAt?: Date;
}): OutboxMessage {
  const message = OutboxMessage.enqueue({
    id: randomUUID(),
    event: IntegrationEvent.create({
      eventId: randomUUID(),
      eventType: 'TestIntegrationEvent',
      aggregateId: options.aggregateId,
      correlationId: randomUUID(),
      occurredAt: options.occurredAt,
      version: 1,
      data: { aggregateId: options.aggregateId },
    }),
  });

  if (options.nextAttemptAt === undefined) {
    return message;
  }

  return OutboxMessage.rehydrate({
    ...message.toState(),
    nextAttemptAt: options.nextAttemptAt,
  });
}

async function withOutbox<TResult>(
  work: (repository: MikroOrmOutboxRepository, entityManager: EntityManager) => Promise<TResult>,
): Promise<TResult> {
  return context().orm.em.transactional((entityManager) =>
    work(new MikroOrmOutboxRepository(entityManager), entityManager),
  );
}

async function insert(...messages: readonly OutboxMessage[]): Promise<void> {
  await withOutbox(async (repository) => {
    for (const message of messages) {
      await repository.insert(message);
    }
  });
}

beforeAll(async () => {
  databaseContext = await createDatabaseTestContext('outbox_claim');
  await databaseContext.orm.migrator.up();
});

afterAll(async () => {
  await databaseContext?.close();
});

afterEach(async () => {
  await context()
    .orm.em.getConnection()
    .execute(
      `update outbox_messages
        set published_at = coalesce(published_at, now()),
            lease_token = null,
            lease_expires_at = null
      where published_at is null`,
    );
});

describe('Transactional Outbox lease claims', () => {
  test('keeps a blocked aggregate head ordered while independent aggregates progress', async () => {
    const now = new Date('2026-09-05T15:00:00.000Z');
    const blockedAggregateId = randomUUID();
    const blockedHead = outboxMessage({
      aggregateId: blockedAggregateId,
      occurredAt: new Date(now.getTime() - 3_000),
    });
    const blockedFollower = outboxMessage({
      aggregateId: blockedAggregateId,
      occurredAt: new Date(now.getTime() - 2_000),
    });
    const independent = outboxMessage({
      aggregateId: randomUUID(),
      occurredAt: new Date(now.getTime() - 1_000),
    });
    await insert(blockedHead, blockedFollower, independent);

    const leaseToken = randomUUID();
    await withOutbox(async (repository) => {
      await repository.claimDue({
        now,
        leaseToken,
        leaseExpiresAt: new Date(now.getTime() + 30_000),
        limit: 1,
      });
      expect(
        await repository.block(blockedHead.id, leaseToken, 1, 'PERMANENT_PUBLISH_FAILURE', now),
      ).toBe(true);
    });

    const claims = await withOutbox((repository) =>
      repository.claimDue({
        now,
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(now.getTime() + 30_000),
        limit: 10,
      }),
    );
    expect(claims.map(({ id }) => id)).toEqual([independent.id]);

    await withOutbox(async (repository) => {
      expect(await repository.replayBlocked(blockedHead.id, 'operator-1', now)).toBe(true);
    });
    const replayClaims = await withOutbox((repository) =>
      repository.claimDue({
        now,
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(now.getTime() + 30_000),
        limit: 10,
      }),
    );
    expect(replayClaims.map(({ id }) => id)).toEqual([blockedHead.id]);

    const audit = await context()
      .orm.em.getConnection()
      .execute<
        {
          outbox_id: string;
          operator_id: string;
          blocked_reason: string;
          previous_attempts: number;
        }[]
      >(
        `select outbox_id, operator_id, blocked_reason, previous_attempts
         from outbox_replay_audit
        where outbox_id = ?`,
        [blockedHead.id],
      );
    expect(audit).toEqual([
      {
        outbox_id: blockedHead.id,
        operator_id: 'operator-1',
        blocked_reason: 'PERMANENT_PUBLISH_FAILURE',
        previous_attempts: 1,
      },
    ]);
  });

  test('claims only the earliest unpublished event per aggregate while independent aggregates progress', async () => {
    const now = new Date('2026-09-04T12:00:00.000Z');
    const firstAggregateId = randomUUID();
    const secondAggregateId = randomUUID();
    const firstForWallet = outboxMessage({
      aggregateId: firstAggregateId,
      occurredAt: new Date(now.getTime() - 3_000),
    });
    const secondForWallet = outboxMessage({
      aggregateId: firstAggregateId,
      occurredAt: new Date(now.getTime() - 2_000),
    });
    const independentWallet = outboxMessage({
      aggregateId: secondAggregateId,
      occurredAt: new Date(now.getTime() - 1_000),
    });
    await insert(firstForWallet, secondForWallet, independentWallet);

    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + 30_000);
    const claims = await withOutbox((repository) =>
      repository.claimDue({ now, leaseToken, leaseExpiresAt, limit: 10 }),
    );

    expect(
      claims.map((message) => ({
        id: message.id,
        aggregateId: message.toState().aggregateId,
        leaseToken: message.toState().leaseToken,
        leaseExpiresAt: message.toState().leaseExpiresAt,
      })),
    ).toEqual([
      {
        id: firstForWallet.id,
        aggregateId: firstAggregateId,
        leaseToken,
        leaseExpiresAt,
      },
      {
        id: independentWallet.id,
        aggregateId: secondAggregateId,
        leaseToken,
        leaseExpiresAt,
      },
    ]);

    const competingClaims = await withOutbox((repository) =>
      repository.claimDue({
        now,
        leaseToken: randomUUID(),
        leaseExpiresAt,
        limit: 10,
      }),
    );

    expect(competingClaims).toEqual([]);

    await withOutbox(async (repository) => {
      expect(await repository.markPublished(firstForWallet.id, leaseToken, now)).toBe(true);
    });

    const nextClaims = await withOutbox((repository) =>
      repository.claimDue({
        now,
        leaseToken: randomUUID(),
        leaseExpiresAt,
        limit: 10,
      }),
    );

    expect(nextClaims.map(({ id }) => id)).toEqual([secondForWallet.id]);
  });

  test('does not let a later event overtake an earlier event delayed for retry', async () => {
    const now = new Date('2026-09-04T13:00:00.000Z');
    const blockedAggregateId = randomUUID();
    const independentAggregateId = randomUUID();
    const delayedHead = outboxMessage({
      aggregateId: blockedAggregateId,
      occurredAt: new Date(now.getTime() - 3_000),
      nextAttemptAt: new Date(now.getTime() + 60_000),
    });
    const dueFollower = outboxMessage({
      aggregateId: blockedAggregateId,
      occurredAt: new Date(now.getTime() - 2_000),
    });
    const dueIndependent = outboxMessage({
      aggregateId: independentAggregateId,
      occurredAt: new Date(now.getTime() - 1_000),
    });
    await insert(delayedHead, dueFollower, dueIndependent);

    const claims = await withOutbox((repository) =>
      repository.claimDue({
        now,
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(now.getTime() + 30_000),
        limit: 10,
      }),
    );

    expect(claims.map(({ id }) => id)).toEqual([dueIndependent.id]);
  });

  test('recovers an expired lease and rejects publication or rescheduling by stale owners', async () => {
    const initialNow = new Date('2026-09-04T14:00:00.000Z');
    const message = outboxMessage({
      aggregateId: randomUUID(),
      occurredAt: new Date(initialNow.getTime() - 1_000),
    });
    await insert(message);

    const expiredLeaseToken = randomUUID();
    await withOutbox((repository) =>
      repository.claimDue({
        now: initialNow,
        leaseToken: expiredLeaseToken,
        leaseExpiresAt: new Date(initialNow.getTime() + 1_000),
        limit: 1,
      }),
    );

    const recoveryNow = new Date(initialNow.getTime() + 2_000);
    const recoveryLeaseToken = randomUUID();
    const recovered = await withOutbox((repository) =>
      repository.claimDue({
        now: recoveryNow,
        leaseToken: recoveryLeaseToken,
        leaseExpiresAt: new Date(recoveryNow.getTime() + 30_000),
        limit: 1,
      }),
    );

    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.toState()).toMatchObject({
      id: message.id,
      leaseToken: recoveryLeaseToken,
      attempts: 0,
      publishedAt: null,
    });

    await withOutbox(async (repository) => {
      expect(await repository.markPublished(message.id, expiredLeaseToken, recoveryNow)).toBe(
        false,
      );
      expect(
        await repository.reschedule(
          message.id,
          expiredLeaseToken,
          1,
          new Date(recoveryNow.getTime() + 5_000),
        ),
      ).toBe(false);
    });

    const afterStaleUpdates = await context()
      .orm.em.getConnection()
      .execute<
        {
          readonly attempts: number;
          readonly lease_token: string | null;
          readonly published_at: Date | null;
        }[]
      >(
        `select attempts, lease_token, published_at
         from outbox_messages
        where id = ?`,
        [message.id],
      );
    expect(afterStaleUpdates[0]).toEqual({
      attempts: 0,
      lease_token: recoveryLeaseToken,
      published_at: null,
    });

    await withOutbox(async (repository) => {
      expect(
        await repository.reschedule(
          message.id,
          recoveryLeaseToken,
          1,
          new Date(recoveryNow.getTime() + 5_000),
        ),
      ).toBe(true);
    });

    const retryNow = new Date(recoveryNow.getTime() + 5_001);
    const publicationLeaseToken = randomUUID();
    const retried = await withOutbox((repository) =>
      repository.claimDue({
        now: retryNow,
        leaseToken: publicationLeaseToken,
        leaseExpiresAt: new Date(retryNow.getTime() + 30_000),
        limit: 1,
      }),
    );
    expect(retried[0]?.toState()).toMatchObject({ attempts: 1, leaseToken: publicationLeaseToken });

    await withOutbox(async (repository) => {
      expect(await repository.markPublished(message.id, publicationLeaseToken, retryNow)).toBe(
        true,
      );
    });

    const published = await context()
      .orm.em.getConnection()
      .execute<
        {
          readonly lease_token: string | null;
          readonly lease_expires_at: Date | null;
          readonly published_at: Date | null;
        }[]
      >(
        `select lease_token, lease_expires_at, published_at
         from outbox_messages
        where id = ?`,
        [message.id],
      );
    expect(
      published[0] === undefined
        ? undefined
        : {
            ...published[0],
            published_at:
              published[0].published_at === null ? null : new Date(published[0].published_at),
          },
    ).toEqual({
      lease_token: null,
      lease_expires_at: null,
      published_at: retryNow,
    });
  });
});
