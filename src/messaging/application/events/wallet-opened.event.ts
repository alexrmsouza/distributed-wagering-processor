import type { PublicMoney } from '../../../shared/domain/money.js';
import { IntegrationEvent, type IntegrationEventState } from '../integration-event.js';

export interface WalletOpenedData extends Readonly<Record<string, unknown>> {
  readonly walletId: string;
  readonly playerId: string;
  readonly initialBalance: PublicMoney;
  readonly walletVersion: number;
}

export class WalletOpenedEvent extends IntegrationEvent<'WalletOpened', WalletOpenedData> {
  private constructor(
    state: Omit<IntegrationEventState<'WalletOpened', WalletOpenedData>, 'eventType' | 'version'>,
  ) {
    super({ ...state, eventType: 'WalletOpened', version: 1 });
  }

  public static from(state: {
    readonly eventId: string;
    readonly walletId: string;
    readonly playerId: string;
    readonly initialBalance: PublicMoney;
    readonly correlationId: string;
    readonly causationId?: string;
    readonly occurredAt: Date;
  }): WalletOpenedEvent {
    return new WalletOpenedEvent({
      eventId: state.eventId,
      aggregateId: state.walletId,
      correlationId: state.correlationId,
      ...(state.causationId === undefined ? {} : { causationId: state.causationId }),
      occurredAt: state.occurredAt,
      data: {
        walletId: state.walletId,
        playerId: state.playerId,
        initialBalance: state.initialBalance,
        walletVersion: 1,
      },
    });
  }
}
