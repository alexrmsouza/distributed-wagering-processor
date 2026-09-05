import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';

import type { OutboxMessage } from '../domain/outbox-message.js';

export interface IntegrationEventPublisher {
  publish(message: OutboxMessage): Promise<void>;
}

export class SqsIntegrationEventPublisher implements IntegrationEventPublisher {
  public constructor(
    private readonly sqsClient: SQSClient,
    private readonly eventQueueUrl: string,
  ) {
    if (eventQueueUrl.trim().length === 0 || eventQueueUrl !== eventQueueUrl.trim()) {
      throw new TypeError('Integration event queue URL must be normalized');
    }
  }

  public async publish(message: OutboxMessage): Promise<void> {
    const state = message.toState();
    await this.sqsClient.send(
      new SendMessageCommand({
        QueueUrl: this.eventQueueUrl,
        MessageBody: JSON.stringify(state.payload),
        MessageGroupId: state.aggregateId,
        MessageDeduplicationId: state.eventId,
      }),
    );
  }
}
