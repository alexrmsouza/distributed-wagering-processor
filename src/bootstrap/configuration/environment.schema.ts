import { z } from 'zod';

const portSchema = z.coerce.number().int().min(1).max(65_535);
const booleanSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(['true', 'false']))
  .transform((value) => value === 'true');
const boundedInteger = (minimum: number, maximum: number) =>
  z.coerce.number().int().min(minimum).max(maximum);

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_HOST: z.string().trim().min(1).default('0.0.0.0'),
  APP_PORT: portSchema.default(3000),
  DATABASE_HOST: z.string().trim().min(1),
  DATABASE_PORT: portSchema.default(5432),
  DATABASE_NAME: z.string().trim().min(1),
  DATABASE_USER: z.string().trim().min(1),
  DATABASE_PASSWORD: z.string().min(1),
  DATABASE_SSL: booleanSchema.default(false),
  DATABASE_LOCK_TIMEOUT_MS: boundedInteger(1, 300_000).default(5_000),
  DATABASE_STATEMENT_TIMEOUT_MS: boundedInteger(1, 900_000).default(30_000),
  DATABASE_TRANSACTION_MAX_ATTEMPTS: boundedInteger(1, 5).default(3),
  DATABASE_TRANSACTION_RETRY_BASE_DELAY_MS: boundedInteger(0, 1_000).default(25),
  AWS_REGION: z.string().trim().min(1).default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().trim().min(1).default('test'),
  AWS_SECRET_ACCESS_KEY: z.string().trim().min(1).default('test'),
  SQS_ENDPOINT: z.url().optional(),
  SQS_COMMAND_QUEUE_URL: z.url(),
  SQS_COMMAND_DLQ_URL: z.url(),
  SQS_EVENT_QUEUE_URL: z.url(),
  SQS_CONSUMER_ENABLED: booleanSchema.default(true),
  SQS_CONSUMER_NAME: z.string().trim().min(1).max(128).default('wager-command-consumer'),
  SQS_POLL_WAIT_TIME_SECONDS: boundedInteger(0, 20).default(20),
  SQS_VISIBILITY_TIMEOUT_SECONDS: boundedInteger(0, 43_200).default(30),
  SQS_MAX_NUMBER_OF_MESSAGES: boundedInteger(1, 10).default(10),
  SQS_SHUTDOWN_GRACE_PERIOD_MS: boundedInteger(0, 300_000).default(10_000),
  SQS_QUEUE_METRICS_INTERVAL_MS: boundedInteger(1_000, 300_000).default(15_000),
  SQS_QUEUE_METRICS_TIMEOUT_MS: boundedInteger(100, 30_000).default(2_000),
  OUTBOX_PUBLISHER_ENABLED: booleanSchema.default(true),
  OUTBOX_PUBLISHER_BATCH_SIZE: boundedInteger(1, 100).default(25),
  OUTBOX_PUBLISHER_LEASE_DURATION_MS: boundedInteger(1, 300_000).default(30_000),
  OUTBOX_PUBLISHER_POLL_INTERVAL_MS: boundedInteger(1, 60_000).default(1_000),
  OUTBOX_PUBLISHER_SHUTDOWN_GRACE_PERIOD_MS: boundedInteger(0, 300_000).default(10_000),
  OUTBOX_PUBLISHER_MAX_ATTEMPTS: boundedInteger(1, 100).default(10),
  HEALTH_READINESS_TIMEOUT_MS: boundedInteger(1, 30_000).default(2_000),
});

export type Environment = Readonly<z.output<typeof environmentSchema>>;
export type EnvironmentSource = Readonly<Record<string, string | undefined>>;

export function parseEnvironment(source: EnvironmentSource = process.env): Environment {
  return Object.freeze(environmentSchema.parse(source));
}
