import { Migration } from '@mikro-orm/migrations';

export class Migration20260904000400 extends Migration {
  override up(): void {
    this.addSql(`
      alter table wager_transactions
        add column observed_balance_currency char(3);

      update wager_transactions
         set observed_balance_currency = currency
       where observed_balance_minor is not null;

      alter table wager_transactions
        add constraint wager_transactions_observed_balance_currency_check check (
          (observed_balance_minor is null and observed_balance_currency is null)
          or (
            observed_balance_minor is not null
            and observed_balance_currency ~ '^[A-Z]{3}$'
          )
        );
    `);
  }

  override down(): void {
    this.addSql(`
      alter table wager_transactions
        drop constraint if exists wager_transactions_observed_balance_currency_check,
        drop column if exists observed_balance_currency;
    `);
  }
}
