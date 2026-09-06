import { MikroORM } from '@mikro-orm/postgresql';

import { createMikroOrmConfig } from '../src/bootstrap/configuration/mikro-orm.config.js';
import { parseEnvironment } from '../src/bootstrap/configuration/environment.schema.js';
import { MikroOrmOutboxRepository } from '../src/messaging/infrastructure/outbox.repository.js';

export interface OutboxReplayArguments {
  readonly outboxId: string;
  readonly operatorId: string;
}

export interface OutboxReplayOptions extends OutboxReplayArguments {
  readonly orm: MikroORM;
  readonly replayedAt?: Date;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATOR_PATTERN = /^[A-Za-z0-9._@:-]{1,128}$/;

export function parseOutboxReplayArguments(arguments_: readonly string[]): OutboxReplayArguments {
  const values = new Map<string, string>();
  for (const argument of arguments_) {
    const match = /^--(outbox-id|operator)=(.+)$/.exec(argument);
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new TypeError('Expected --outbox-id=<uuid> and --operator=<normalized-identity>');
    }
    if (values.has(match[1])) {
      throw new TypeError(`Duplicate Outbox replay argument: ${match[1]}`);
    }
    values.set(match[1], match[2]);
  }

  const outboxId = values.get('outbox-id');
  const operatorId = values.get('operator');
  if (outboxId === undefined || operatorId === undefined || values.size !== 2) {
    throw new TypeError('Expected --outbox-id=<uuid> and --operator=<normalized-identity>');
  }
  if (!UUID_PATTERN.test(outboxId) || !OPERATOR_PATTERN.test(operatorId)) {
    throw new TypeError('Outbox replay arguments are invalid');
  }
  return Object.freeze({ outboxId, operatorId });
}

export function replayBlockedOutbox(options: OutboxReplayOptions): Promise<boolean> {
  const replayedAt = options.replayedAt ?? new Date();
  if (!Number.isFinite(replayedAt.getTime())) {
    throw new TypeError('Outbox replay instant is invalid');
  }
  return options.orm.em.transactional((entityManager) =>
    new MikroOrmOutboxRepository(entityManager).replayBlocked(
      options.outboxId,
      options.operatorId,
      replayedAt,
    ),
  );
}

export async function runOutboxReplayCli(arguments_: readonly string[] = Bun.argv.slice(2)) {
  let orm: MikroORM | undefined;
  try {
    const argumentsParsed = parseOutboxReplayArguments(arguments_);
    const environment = parseEnvironment();
    orm = await MikroORM.init(createMikroOrmConfig(environment));
    const replayed = await replayBlockedOutbox({ orm, ...argumentsParsed });
    process.stdout.write(
      `${JSON.stringify({ status: replayed ? 'REPLAYED' : 'NOT_BLOCKED', outboxId: argumentsParsed.outboxId })}\n`,
    );
    return replayed ? 0 : 1;
  } catch {
    console.error('Outbox replay failed safely');
    return 1;
  } finally {
    await orm?.close(true);
  }
}

if (import.meta.main) {
  process.exitCode = await runOutboxReplayCli();
}
