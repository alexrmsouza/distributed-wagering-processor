import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { OnModuleDestroy } from '@nestjs/common';

import type { ReadinessProbe } from '../application/ports/readiness-probe.js';

export class PostgresReadinessProbe implements ReadinessProbe {
  public constructor(private readonly orm: MikroORM) {}

  public async check(): Promise<void> {
    await this.orm.em.getConnection().execute('select 1');
  }
}

export class SqsReadinessProbe implements ReadinessProbe, OnModuleDestroy {
  readonly #queueUrls: readonly string[];

  public constructor(
    private readonly sqsClient: SQSClient,
    queueUrl: string | readonly string[],
    private readonly ownsClient = false,
  ) {
    this.#queueUrls = Object.freeze(typeof queueUrl === 'string' ? [queueUrl] : [...queueUrl]);
    if (
      this.#queueUrls.length === 0 ||
      this.#queueUrls.some((value) => value.trim().length === 0)
    ) {
      throw new TypeError('SQS readiness requires at least one normalized queue URL');
    }
  }

  public async check(): Promise<void> {
    await Promise.all(
      this.#queueUrls.map((queueUrl) =>
        this.sqsClient.send(
          new GetQueueAttributesCommand({
            QueueUrl: queueUrl,
            AttributeNames: ['QueueArn'],
          }),
        ),
      ),
    );
  }

  public onModuleDestroy(): void {
    if (this.ownsClient) {
      this.sqsClient.destroy();
    }
  }
}
