import { randomUUID } from 'node:crypto';

import type { EntityManager } from '@mikro-orm/core';
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';

import type { IntegrationEventEnvelope } from '../../src/messaging/domain/integration-event.js';
import { EventSinkConsumer } from '../support/event-sink.consumer.js';
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

function envelope(options: {
  readonly eventId: string;
  readonly amount?: string;
}): IntegrationEventEnvelope {
  return Object.freeze({
    eventId: options.eventId,
    eventType: 'WalletBalanceChanged',
    aggregateId: randomUUID(),
    correlationId: randomUUID(),
    causationId: randomUUID(),
    occurredAt: '2026-09-04T15:00:00.000Z',
    version: 1,
    data: Object.freeze({
      walletId: randomUUID(),
      balance: Object.freeze({ amount: options.amount ?? '125.00', currency: 'BRL' }),
    }),
  });
}

async function persistedCounts(consumerName: string, eventId: string) {
  const rows = await context()
    .orm.em.getConnection()
    .execute<
      {
        readonly effects: string;
        readonly inbox_messages: string;
        readonly processed_inbox_messages: string;
      }[]
    >(
      `select
       (select count(*)::text
          from integration_event_sink_effects
         where consumer_name = ? and event_id = ?::uuid) as effects,
       (select count(*)::text
          from inbox_messages
         where consumer_name = ? and message_id = ?) as inbox_messages,
       (select count(*)::text
          from inbox_messages
         where consumer_name = ? and message_id = ? and processed_at is not null)
         as processed_inbox_messages`,
      [consumerName, eventId, consumerName, eventId, consumerName, eventId],
    );

  const row = rows[0];
  if (row === undefined) {
    throw new Error('Event sink persistence counts are unavailable');
  }
  return row;
}

function createSink(consumerName: string): EventSinkConsumer {
  return new EventSinkConsumer({
    orm: context().orm,
    consumerName,
    onEvent: async (event: IntegrationEventEnvelope, entityManager: EntityManager) => {
      await entityManager.getConnection().execute(
        `insert into integration_event_sink_effects
           (consumer_name, event_id, event_type, payload)
         values (?, ?::uuid, ?, ?::jsonb)`,
        [consumerName, event.eventId, event.eventType, JSON.stringify(event)],
        'run',
        entityManager.getTransactionContext(),
      );
    },
  });
}

async function captureError(operation: () => Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await operation();
  } catch (error: unknown) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }

  throw new Error('Expected operation to fail');
}

beforeAll(async () => {
  databaseContext = await createDatabaseTestContext('integration_event_inbox');
  await databaseContext.orm.migrator.up();
  await databaseContext.orm.em.getConnection().execute(`
    create table integration_event_sink_effects (
      consumer_name varchar(128) not null,
      event_id uuid not null,
      event_type varchar(128) not null,
      payload jsonb not null,
      primary key (consumer_name, event_id)
    )
  `);
});

afterAll(async () => {
  await databaseContext?.close();
});

describe('Durable downstream integration-event Inbox', () => {
  test('turns repeated delivery into one durable logical effect across consumer restarts', async () => {
    const consumerName = `integration-event-sink-${randomUUID()}`;
    const event = envelope({ eventId: randomUUID() });

    const first = await createSink(consumerName).processEnvelope(event);
    const duplicateAfterRestart = await createSink(consumerName).processEnvelope(event);

    expect(first).toEqual({ status: 'PROCESSED', eventId: event.eventId });
    expect(duplicateAfterRestart).toEqual({ status: 'DUPLICATE', eventId: event.eventId });
    expect(await persistedCounts(consumerName, event.eventId)).toEqual({
      effects: '1',
      inbox_messages: '1',
      processed_inbox_messages: '1',
    });
  });

  test('rejects divergent reuse of an event identity without a second effect', async () => {
    const consumerName = `integration-event-sink-${randomUUID()}`;
    const eventId = randomUUID();
    const original = envelope({ eventId });
    await createSink(consumerName).processEnvelope(original);
    const beforeConflict = await persistedCounts(consumerName, eventId);

    const error = await captureError(() =>
      createSink(consumerName).processEnvelope({
        ...original,
        data: {
          ...original.data,
          balance: { amount: '999.00', currency: 'BRL' },
        },
      }),
    );

    expect(error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await persistedCounts(consumerName, eventId)).toEqual(beforeConflict);
  });

  test('rolls back the Inbox claim when the downstream effect fails', async () => {
    const consumerName = `integration-event-sink-${randomUUID()}`;
    const event = envelope({ eventId: randomUUID() });
    const failingSink = new EventSinkConsumer({
      orm: context().orm,
      consumerName,
      onEvent: async (_event: IntegrationEventEnvelope, entityManager: EntityManager) => {
        await entityManager.getConnection().execute(
          `insert into integration_event_sink_effects
             (consumer_name, event_id, event_type, payload)
           values (?, ?::uuid, ?, ?::jsonb)`,
          [consumerName, event.eventId, event.eventType, JSON.stringify(event)],
          'run',
          entityManager.getTransactionContext(),
        );
        throw new Error('simulated downstream failure');
      },
    });

    const failure = await captureError(() => failingSink.processEnvelope(event));
    expect(failure.message).toBe('simulated downstream failure');
    expect(await persistedCounts(consumerName, event.eventId)).toEqual({
      effects: '0',
      inbox_messages: '0',
      processed_inbox_messages: '0',
    });

    expect(await createSink(consumerName).processEnvelope(event)).toEqual({
      status: 'PROCESSED',
      eventId: event.eventId,
    });
    expect(await persistedCounts(consumerName, event.eventId)).toEqual({
      effects: '1',
      inbox_messages: '1',
      processed_inbox_messages: '1',
    });
  });
});
