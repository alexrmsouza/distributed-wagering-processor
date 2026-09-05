import { SQSClient } from '@aws-sdk/client-sqs';

import type { Environment } from '../../bootstrap/configuration/environment.schema.js';

export interface SqsQueueConfiguration {
  readonly commandQueueUrl: string;
  readonly commandDeadLetterQueueUrl?: string;
  readonly eventQueueUrl?: string;
  readonly waitTimeSeconds?: number;
  readonly visibilityTimeoutSeconds?: number;
  readonly maxNumberOfMessages?: number;
}

export function createSqsClient(environment: Environment): SQSClient {
  return new SQSClient({
    region: environment.AWS_REGION,
    ...(environment.SQS_ENDPOINT === undefined ? {} : { endpoint: environment.SQS_ENDPOINT }),
    ...(environment.SQS_ENDPOINT === undefined
      ? {}
      : {
          credentials: {
            accessKeyId: environment.AWS_ACCESS_KEY_ID,
            secretAccessKey: environment.AWS_SECRET_ACCESS_KEY,
          },
        }),
  });
}

export function createSqsQueueConfiguration(environment: Environment): SqsQueueConfiguration {
  return Object.freeze({
    commandQueueUrl: environment.SQS_COMMAND_QUEUE_URL,
    commandDeadLetterQueueUrl: environment.SQS_COMMAND_DLQ_URL,
    eventQueueUrl: environment.SQS_EVENT_QUEUE_URL,
    waitTimeSeconds: environment.SQS_POLL_WAIT_TIME_SECONDS,
    visibilityTimeoutSeconds: environment.SQS_VISIBILITY_TIMEOUT_SECONDS,
    maxNumberOfMessages: environment.SQS_MAX_NUMBER_OF_MESSAGES,
  });
}
