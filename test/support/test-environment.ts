import {
  parseEnvironment,
  type Environment,
  type EnvironmentSource,
} from '../../src/bootstrap/configuration/environment.schema.js';

const TEST_ENVIRONMENT_DEFAULTS = Object.freeze({
  NODE_ENV: 'test',
  APP_HOST: '127.0.0.1',
  APP_PORT: '3000',
  DATABASE_HOST: '127.0.0.1',
  DATABASE_PORT: '5432',
  DATABASE_NAME: 'wagering',
  DATABASE_USER: 'wagering',
  DATABASE_PASSWORD: 'wagering',
  DATABASE_SSL: 'false',
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  SQS_ENDPOINT: 'http://127.0.0.1:4566',
  SQS_COMMAND_QUEUE_URL: 'http://127.0.0.1:4566/000000000000/wager-transactions.fifo',
  SQS_COMMAND_DLQ_URL: 'http://127.0.0.1:4566/000000000000/wager-transactions-dlq.fifo',
  SQS_EVENT_QUEUE_URL: 'http://127.0.0.1:4566/000000000000/wager-integration-events.fifo',
  SQS_CONSUMER_ENABLED: 'false',
  OUTBOX_PUBLISHER_ENABLED: 'false',
});

type TestEnvironmentVariable = keyof typeof TEST_ENVIRONMENT_DEFAULTS;
export type TestEnvironmentOverrides = Partial<Record<TestEnvironmentVariable, string>>;

export interface TestEnvironment {
  readonly appBaseUrl: string;
  readonly configuration: Environment;
  readonly variables: EnvironmentSource;
}

export function createTestEnvironment(overrides: TestEnvironmentOverrides = {}): TestEnvironment {
  const variables = Object.freeze({ ...TEST_ENVIRONMENT_DEFAULTS, ...overrides });
  const configuration = parseEnvironment(variables);

  return Object.freeze({
    appBaseUrl: `http://${configuration.APP_HOST}:${String(configuration.APP_PORT)}`,
    configuration,
    variables,
  });
}
