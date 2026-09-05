export const TRANSACTION_RUNNER = Symbol('TRANSACTION_RUNNER');

export interface TransactionBoundRepository {
  readonly transactionBound: true;
}

type TransactionWork<TContext, TResult> = (context: TContext) => Promise<TResult>;

export interface TransactionRunner<TContext> {
  run<TResult>(work: TransactionWork<TContext, TResult>): Promise<TResult>;
}
