import { Migration } from '@mikro-orm/migrations';

export class Migration20260904000200 extends Migration {
  override up(): void {
    this.addSql(`
      create table wallet_ledger_entries (
        id uuid primary key,
        wallet_id uuid not null references wallets (id),
        transaction_id uuid not null references wager_transactions (id),
        entry_sequence bigint not null,
        direction varchar(8) not null,
        amount_minor bigint not null,
        currency char(3) not null,
        balance_before_minor bigint not null,
        balance_after_minor bigint not null,
        previous_entry_hash char(64),
        entry_hash char(64) not null,
        created_at timestamptz not null,
        constraint wallet_ledger_entries_transaction_unique unique (transaction_id),
        constraint wallet_ledger_entries_sequence_unique unique (wallet_id, entry_sequence)
      );
    `);

    this.addSql(`
      create table accounts (
        id uuid primary key,
        kind varchar(32) not null,
        owner_id varchar(255) not null,
        currency char(3) not null,
        created_at timestamptz not null,
        constraint accounts_identity_unique unique (kind, owner_id, currency)
      );
    `);

    this.addSql(`
      create table accounting_journals (
        id uuid primary key,
        transaction_id uuid not null references wager_transactions (id),
        wallet_id uuid not null references wallets (id),
        created_at timestamptz not null,
        constraint accounting_journals_transaction_unique unique (transaction_id)
      );
    `);

    this.addSql(`
      create table accounting_postings (
        id uuid primary key,
        journal_id uuid not null references accounting_journals (id),
        account_id uuid not null references accounts (id),
        direction varchar(8) not null,
        amount_minor bigint not null,
        currency char(3) not null,
        created_at timestamptz not null
      );
    `);

    this.addSql(`
      create table inbox_messages (
        consumer_name varchar(128) not null,
        message_id varchar(255) not null,
        payload_hash char(64) not null,
        transaction_id uuid references wager_transactions (id),
        received_at timestamptz not null,
        processed_at timestamptz,
        primary key (consumer_name, message_id)
      );
    `);

    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        event_id uuid not null unique,
        aggregate_id uuid not null,
        event_type varchar(128) not null,
        version integer not null,
        payload jsonb not null,
        correlation_id varchar(255) not null,
        causation_id varchar(255),
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz not null,
        lease_token uuid,
        lease_expires_at timestamptz,
        published_at timestamptz
      );
    `);
  }

  override down(): void {
    this.addSql('drop table if exists outbox_messages cascade;');
    this.addSql('drop table if exists inbox_messages cascade;');
    this.addSql('drop table if exists accounting_postings cascade;');
    this.addSql('drop table if exists accounting_journals cascade;');
    this.addSql('drop table if exists accounts cascade;');
    this.addSql('drop table if exists wallet_ledger_entries cascade;');
  }
}
