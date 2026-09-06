export const FAILPOINT_NAMES = [
  'before_financial_commit',
  'after_financial_commit_before_sqs_ack',
  'after_outbox_claim_before_publish',
  'after_sqs_publish_before_outbox_mark_published',
] as const;

export type FailpointName = (typeof FAILPOINT_NAMES)[number];

export interface FailpointPort {
  trigger(name: FailpointName): Promise<void>;
}

export interface FailpointControlPort {
  arm(name: FailpointName): void;
  disarm(name: FailpointName): void;
  disarmAll(): void;
}

export class FailpointTriggeredError extends Error {
  public constructor(public readonly failpoint: FailpointName) {
    super(`Failpoint triggered: ${failpoint}`);
    this.name = 'FailpointTriggeredError';
  }
}
