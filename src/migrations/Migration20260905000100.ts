import { Migration } from '@mikro-orm/migrations';

export class Migration20260905000100 extends Migration {
  override up(): void {
    this.addSql(`
      create table wallet_reconciliation_checkpoints (
        wallet_id uuid primary key references wallets (id) on delete cascade,
        currency char(3) not null,
        ledger_sequence bigint not null,
        ledger_entry_hash char(64),
        calculated_balance_minor bigint not null,
        checked_at timestamptz not null,
        constraint wallet_reconciliation_checkpoints_currency_check
          check (currency ~ '^[A-Z]{3}$'),
        constraint wallet_reconciliation_checkpoints_sequence_check
          check (ledger_sequence >= 0),
        constraint wallet_reconciliation_checkpoints_hash_check check (
          (ledger_sequence = 0 and ledger_entry_hash is null and calculated_balance_minor = 0)
          or (ledger_sequence > 0 and ledger_entry_hash ~ '^[0-9a-f]{64}$')
        )
      );
    `);
  }

  override down(): void {
    this.addSql('drop table if exists wallet_reconciliation_checkpoints;');
  }
}
