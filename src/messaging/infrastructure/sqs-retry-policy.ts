const SQS_ERROR_CLASSIFICATIONS = Object.freeze({
  TransientInfrastructure: 'TRANSIENT_INFRASTRUCTURE',
  PermanentInfrastructure: 'PERMANENT_INFRASTRUCTURE',
} as const);

export type SqsFailureAction = 'REDRIVE' | 'RETRY';

export interface SqsRetryPolicyOptions {
  readonly baseVisibilityTimeoutSeconds: number;
  readonly maxVisibilityTimeoutSeconds: number;
}

interface ClassifiedSqsError extends Error {
  readonly classification?: string;
  readonly redrive?: boolean;
}

export class SqsRetryPolicy {
  readonly #baseVisibilityTimeoutSeconds: number;
  readonly #maxVisibilityTimeoutSeconds: number;

  public constructor(options: SqsRetryPolicyOptions) {
    if (
      !Number.isInteger(options.baseVisibilityTimeoutSeconds) ||
      options.baseVisibilityTimeoutSeconds < 0 ||
      !Number.isInteger(options.maxVisibilityTimeoutSeconds) ||
      options.maxVisibilityTimeoutSeconds < options.baseVisibilityTimeoutSeconds ||
      options.maxVisibilityTimeoutSeconds > 43_200
    ) {
      throw new RangeError('SQS visibility timeout bounds are invalid');
    }
    this.#baseVisibilityTimeoutSeconds = options.baseVisibilityTimeoutSeconds;
    this.#maxVisibilityTimeoutSeconds = options.maxVisibilityTimeoutSeconds;
  }

  public visibilityTimeoutSeconds(receiveCount: number): number {
    if (!Number.isInteger(receiveCount) || receiveCount < 1) {
      throw new RangeError('SQS receive count must be a positive integer');
    }

    const exponent = Math.min(receiveCount - 1, 30);
    return Math.min(
      this.#baseVisibilityTimeoutSeconds * 2 ** exponent,
      this.#maxVisibilityTimeoutSeconds,
    );
  }

  public classify(error: unknown): SqsFailureAction {
    if (typeof error === 'object' && error !== null) {
      const classified = error as Partial<ClassifiedSqsError>;
      if (
        classified.redrive === true ||
        classified.classification === SQS_ERROR_CLASSIFICATIONS.PermanentInfrastructure
      ) {
        return 'REDRIVE';
      }
    }

    return 'RETRY';
  }
}
