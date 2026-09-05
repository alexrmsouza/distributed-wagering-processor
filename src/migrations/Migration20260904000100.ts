import { Migration } from '@mikro-orm/migrations';

export class Migration20260904000100 extends Migration {
  override up(): void {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id uuid not null,
        currency char(3) not null,
        balance_minor bigint not null default 0,
        version bigint not null default 1,
        ledger_sequence bigint not null default 0,
        last_ledger_hash char(64),
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_player_currency_unique unique (player_id, currency)
      );
    `);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id varchar(128) not null,
        external_transaction_id varchar(255) not null,
        idempotency_key varchar(255) not null,
        payload_hash char(64) not null,
        wallet_id uuid not null references wallets (id),
        player_id uuid not null,
        round_id varchar(255) not null,
        game_id varchar(255) not null,
        kind varchar(16) not null,
        amount_minor bigint not null,
        currency char(3) not null,
        reference_external_transaction_id varchar(255),
        reference_transaction_id uuid references wager_transactions (id),
        status varchar(32) not null,
        failure_code varchar(64),
        observed_balance_minor bigint,
        retry_attempts integer not null default 0,
        next_retry_at timestamptz,
        retry_expires_at timestamptz,
        processed_at timestamptz,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wager_transactions_provider_idempotency_unique
          unique (provider_id, idempotency_key),
        constraint wager_transactions_provider_external_unique
          unique (provider_id, external_transaction_id)
      );
    `);
  }

  override down(): void {
    this.addSql('drop table if exists wager_transactions cascade;');
    this.addSql('drop table if exists wallets cascade;');
  }
}
