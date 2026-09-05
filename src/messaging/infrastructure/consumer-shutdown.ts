export type ReceiptState =
  'received' | 'processing' | 'committed' | 'acknowledged' | 'retryable' | 'released';

export interface ReceiptTransition {
  readonly receiptHandle: string;
  readonly messageId?: string;
  readonly state: ReceiptState;
}

export interface ConsumerShutdownCoordinatorOptions {
  readonly gracePeriodMs: number;
  readonly onTransition?: (transition: ReceiptTransition) => void;
}

interface ActiveReceipt {
  readonly messageId?: string;
  state: ReceiptState;
}

export class ConsumerShutdownCoordinator {
  readonly #activeReceipts = new Map<string, ActiveReceipt>();
  readonly #gracePeriodMs: number;
  readonly #onTransition: ((transition: ReceiptTransition) => void) | undefined;
  #accepting = true;

  public constructor(options: ConsumerShutdownCoordinatorOptions) {
    if (!Number.isInteger(options.gracePeriodMs) || options.gracePeriodMs < 0) {
      throw new RangeError('Consumer shutdown grace period must be a non-negative integer');
    }
    this.#gracePeriodMs = options.gracePeriodMs;
    this.#onTransition = options.onTransition;
  }

  public get accepting(): boolean {
    return this.#accepting;
  }

  public get gracePeriodMs(): number {
    return this.#gracePeriodMs;
  }

  public stopAccepting(): void {
    this.#accepting = false;
  }

  public register(receiptHandle: string, messageId?: string): void {
    if (!this.#accepting) {
      throw new Error('Consumer is shutting down and cannot accept another receipt');
    }
    this.#activeReceipts.set(receiptHandle, {
      ...(messageId === undefined ? {} : { messageId }),
      state: 'received',
    });
    this.transition(receiptHandle, 'received');
  }

  public identify(receiptHandle: string, messageId: string): void {
    const receipt = this.#requiredReceipt(receiptHandle);
    this.#activeReceipts.set(receiptHandle, { ...receipt, messageId });
  }

  public transition(receiptHandle: string, state: ReceiptState): void {
    const receipt = this.#activeReceipts.get(receiptHandle);
    if (receipt === undefined) {
      if (!this.#accepting) {
        return;
      }
      throw new Error('SQS receipt is not active');
    }
    receipt.state = state;
    this.#onTransition?.(
      Object.freeze({
        receiptHandle,
        ...(receipt.messageId === undefined ? {} : { messageId: receipt.messageId }),
        state,
      }),
    );
    if (state === 'acknowledged' || state === 'released') {
      this.#activeReceipts.delete(receiptHandle);
    }
  }

  public activeReceipts(): readonly ReceiptTransition[] {
    return Object.freeze(
      [...this.#activeReceipts].map(([receiptHandle, receipt]) =>
        Object.freeze({
          receiptHandle,
          ...(receipt.messageId === undefined ? {} : { messageId: receipt.messageId }),
          state: receipt.state,
        }),
      ),
    );
  }

  #requiredReceipt(receiptHandle: string): ActiveReceipt {
    const receipt = this.#activeReceipts.get(receiptHandle);
    if (receipt === undefined) {
      throw new Error('SQS receipt is not active');
    }
    return receipt;
  }
}
