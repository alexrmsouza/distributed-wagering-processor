import { Migration } from '@mikro-orm/migrations';

export class Migration20260904000500 extends Migration {
  override up(): void {
    this.addSql(`
      alter table wager_transactions
        add column pending_correlation_id varchar(255),
        add column pending_causation_id varchar(255),
        add column pending_lease_token uuid,
        add column pending_lease_expires_at timestamptz,
        add constraint wager_transactions_pending_context_check check (
          status <> 'PENDING_REFERENCE' or pending_correlation_id is not null
        ),
        add constraint wager_transactions_pending_lease_check check (
          (pending_lease_token is null and pending_lease_expires_at is null)
          or (
            status = 'PENDING_REFERENCE'
            and pending_lease_token is not null
            and pending_lease_expires_at is not null
          )
        ),
        add constraint wager_transactions_pending_schedule_order_check check (
          status <> 'PENDING_REFERENCE' or next_retry_at <= retry_expires_at
        );
    `);

    this.addSql(`
      drop trigger if exists wager_transactions_lifecycle on wager_transactions;

      create function enforce_wager_transaction_lifecycle_v2()
      returns trigger
      language plpgsql
      as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wager_transactions is immutable' using errcode = '55000';
        end if;

        if old.provider_id is distinct from new.provider_id
          or old.external_transaction_id is distinct from new.external_transaction_id
          or old.idempotency_key is distinct from new.idempotency_key
          or old.payload_hash is distinct from new.payload_hash
          or old.wallet_id is distinct from new.wallet_id
          or old.player_id is distinct from new.player_id
          or old.round_id is distinct from new.round_id
          or old.game_id is distinct from new.game_id
          or old.kind is distinct from new.kind
          or old.amount_minor is distinct from new.amount_minor
          or old.currency is distinct from new.currency
          or old.reference_external_transaction_id is distinct from new.reference_external_transaction_id
          or old.created_at is distinct from new.created_at then
          raise exception 'Wager transaction business identity is immutable' using errcode = '55000';
        end if;

        if old.reference_transaction_id is distinct from new.reference_transaction_id
          and not (
            old.kind in ('REFUND', 'ROLLBACK')
            and old.status in ('PENDING', 'PENDING_REFERENCE')
            and new.status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED')
            and old.reference_transaction_id is null
            and new.reference_transaction_id is not null
          ) then
          raise exception 'Wager transaction resolved reference is immutable' using errcode = '55000';
        end if;

        if old.pending_correlation_id is distinct from new.pending_correlation_id
          and not (
            old.status = 'PENDING'
            and new.status = 'PENDING_REFERENCE'
            and old.pending_correlation_id is null
            and new.pending_correlation_id is not null
          ) then
          raise exception 'Pending reference correlation is immutable' using errcode = '55000';
        end if;

        if old.pending_causation_id is distinct from new.pending_causation_id
          and not (
            old.status = 'PENDING'
            and new.status = 'PENDING_REFERENCE'
            and old.pending_causation_id is null
          ) then
          raise exception 'Pending reference causation is immutable' using errcode = '55000';
        end if;

        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'Terminal Wager transaction % is immutable', old.id using errcode = '55000';
        end if;

        if old.status = 'PENDING'
          and new.status not in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'Invalid Wager transaction status transition' using errcode = '23514';
        end if;

        if old.status = 'PENDING_REFERENCE'
          and new.status not in ('PENDING_REFERENCE', 'PROCESSED', 'REJECTED') then
          raise exception 'Invalid Wager transaction status transition' using errcode = '23514';
        end if;

        return new;
      end;
      $$;

      create trigger wager_transactions_lifecycle
        before update or delete on wager_transactions
        for each row execute function enforce_wager_transaction_lifecycle_v2();
    `);

    this.addSql(`
      drop trigger if exists wager_transactions_financial_consistency on wager_transactions;
      drop trigger if exists wallet_ledger_entries_financial_consistency on wallet_ledger_entries;
      drop trigger if exists accounting_journals_financial_consistency on accounting_journals;
      drop trigger if exists accounting_postings_financial_consistency on accounting_postings;

      create function enforce_financial_transaction_consistency_v2()
      returns trigger
      language plpgsql
      as $$
      declare
        trigger_row jsonb;
        target_transaction_id uuid;
        transaction_row wager_transactions%rowtype;
        reference_row wager_transactions%rowtype;
        ledger_row wallet_ledger_entries%rowtype;
        journal_row accounting_journals%rowtype;
        ledger_count integer;
        journal_count integer;
        valid_posting_count integer;
        player_posting_count integer;
        counterparty_posting_count integer;
        expected_counterparty_kind varchar(32);
        expected_counterparty_owner varchar(255);
        expected_direction varchar(8);
        movement_required boolean;
      begin
        trigger_row := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;

        if tg_table_name = 'wager_transactions' then
          target_transaction_id := (trigger_row ->> 'id')::uuid;
        elsif tg_table_name in ('wallet_ledger_entries', 'accounting_journals') then
          target_transaction_id := (trigger_row ->> 'transaction_id')::uuid;
        elsif tg_table_name = 'accounting_postings' then
          select transaction_id into target_transaction_id
            from accounting_journals
           where id = (trigger_row ->> 'journal_id')::uuid;
        end if;

        if target_transaction_id is null then
          return null;
        end if;

        select * into transaction_row
          from wager_transactions
         where id = target_transaction_id;
        if not found then
          return null;
        end if;

        movement_required := transaction_row.status = 'PROCESSED'
          and transaction_row.kind <> 'LOSS';

        select count(*) into ledger_count
          from wallet_ledger_entries
         where transaction_id = target_transaction_id;
        select count(*) into journal_count
          from accounting_journals
         where transaction_id = target_transaction_id;

        if not movement_required then
          if ledger_count <> 0 or journal_count <> 0 then
            raise exception 'Transaction % must not have financial movement', target_transaction_id
              using errcode = '23514';
          end if;
          return null;
        end if;

        if transaction_row.kind in ('REFUND', 'ROLLBACK') then
          if transaction_row.reference_transaction_id is null then
            raise exception 'Processed reversal % must resolve its reference', target_transaction_id
              using errcode = '23514';
          end if;
          select * into reference_row
            from wager_transactions
           where id = transaction_row.reference_transaction_id;
          if not found or reference_row.status <> 'PROCESSED' then
            raise exception 'Processed reversal % has an invalid reference', target_transaction_id
              using errcode = '23514';
          end if;
          if reference_row.id = transaction_row.id
            or transaction_row.reference_external_transaction_id is distinct from reference_row.external_transaction_id
            or transaction_row.provider_id is distinct from reference_row.provider_id
            or transaction_row.wallet_id is distinct from reference_row.wallet_id
            or transaction_row.player_id is distinct from reference_row.player_id
            or transaction_row.currency is distinct from reference_row.currency
            or transaction_row.amount_minor is distinct from reference_row.amount_minor
            or transaction_row.round_id is distinct from reference_row.round_id
            or transaction_row.game_id is distinct from reference_row.game_id
            or (transaction_row.kind = 'REFUND' and reference_row.kind <> 'BET')
            or (
              transaction_row.kind = 'ROLLBACK'
              and reference_row.kind not in ('BET', 'WIN', 'REFUND')
            ) then
            raise exception 'Processed reversal % has incompatible reference context',
              target_transaction_id using errcode = '23514';
          end if;
        end if;

        if ledger_count <> 1 or journal_count <> 1 then
          raise exception 'Transaction % must have exactly one ledger entry and one journal',
            target_transaction_id using errcode = '23514';
        end if;

        select * into ledger_row
          from wallet_ledger_entries
         where transaction_id = target_transaction_id;
        select * into journal_row
          from accounting_journals
         where transaction_id = target_transaction_id;

        if ledger_row.wallet_id <> transaction_row.wallet_id
          or ledger_row.amount_minor <> transaction_row.amount_minor
          or ledger_row.currency <> transaction_row.currency
          or ledger_row.balance_after_minor <> transaction_row.observed_balance_minor
          or journal_row.wallet_id <> transaction_row.wallet_id then
          raise exception 'Transaction % financial records do not match its movement',
            target_transaction_id using errcode = '23514';
        end if;

        expected_direction := case
          when transaction_row.kind in ('OPENING', 'WIN', 'REFUND') then 'CREDIT'
          when transaction_row.kind = 'BET' then 'DEBIT'
          when transaction_row.kind = 'ROLLBACK' and reference_row.kind = 'BET' then 'CREDIT'
          when transaction_row.kind = 'ROLLBACK' and reference_row.kind in ('WIN', 'REFUND') then 'DEBIT'
          else null
        end;

        if expected_direction is null or ledger_row.direction <> expected_direction then
          raise exception 'Transaction % has an invalid ledger direction', target_transaction_id
            using errcode = '23514';
        end if;

        expected_counterparty_kind := case
          when transaction_row.kind = 'OPENING' then 'INTERNAL_FUNDING'
          else 'PROVIDER_CLEARING'
        end;
        expected_counterparty_owner := case
          when transaction_row.kind = 'OPENING' then 'internal'
          else transaction_row.provider_id
        end;

        select
          count(*) filter (
            where posting.amount_minor = transaction_row.amount_minor
              and posting.currency = transaction_row.currency
              and account.currency = transaction_row.currency
          ),
          count(*) filter (
            where account.kind = 'PLAYER_BALANCE'
              and account.owner_id = transaction_row.wallet_id::text
              and posting.direction = ledger_row.direction
          ),
          count(*) filter (
            where account.kind = expected_counterparty_kind
              and account.owner_id = expected_counterparty_owner
              and posting.direction <> ledger_row.direction
          )
          into valid_posting_count, player_posting_count, counterparty_posting_count
          from accounting_postings posting
          join accounts account on account.id = posting.account_id
         where posting.journal_id = journal_row.id;

        if valid_posting_count <> 2
          or player_posting_count <> 1
          or counterparty_posting_count <> 1 then
          raise exception 'Transaction % accounting postings do not match its movement',
            target_transaction_id using errcode = '23514';
        end if;

        return null;
      end;
      $$;

      create constraint trigger wager_transactions_financial_consistency
        after insert or update or delete on wager_transactions
        deferrable initially deferred
        for each row execute function enforce_financial_transaction_consistency_v2();
      create constraint trigger wallet_ledger_entries_financial_consistency
        after insert or update or delete on wallet_ledger_entries
        deferrable initially deferred
        for each row execute function enforce_financial_transaction_consistency_v2();
      create constraint trigger accounting_journals_financial_consistency
        after insert or update or delete on accounting_journals
        deferrable initially deferred
        for each row execute function enforce_financial_transaction_consistency_v2();
      create constraint trigger accounting_postings_financial_consistency
        after insert or update or delete on accounting_postings
        deferrable initially deferred
        for each row execute function enforce_financial_transaction_consistency_v2();
    `);
  }

  override down(): void {
    this.addSql(`
      drop trigger if exists accounting_postings_financial_consistency on accounting_postings;
      drop trigger if exists accounting_journals_financial_consistency on accounting_journals;
      drop trigger if exists wallet_ledger_entries_financial_consistency on wallet_ledger_entries;
      drop trigger if exists wager_transactions_financial_consistency on wager_transactions;
      drop function if exists enforce_financial_transaction_consistency_v2();

      create constraint trigger wager_transactions_financial_consistency
        after insert or update or delete on wager_transactions
        deferrable initially deferred
        for each row execute function enforce_financial_transaction_consistency();
      create constraint trigger wallet_ledger_entries_financial_consistency
        after insert or update or delete on wallet_ledger_entries
        deferrable initially deferred
        for each row execute function enforce_financial_transaction_consistency();
      create constraint trigger accounting_journals_financial_consistency
        after insert or update or delete on accounting_journals
        deferrable initially deferred
        for each row execute function enforce_financial_transaction_consistency();
      create constraint trigger accounting_postings_financial_consistency
        after insert or update or delete on accounting_postings
        deferrable initially deferred
        for each row execute function enforce_financial_transaction_consistency();

      drop trigger if exists wager_transactions_lifecycle on wager_transactions;
      drop function if exists enforce_wager_transaction_lifecycle_v2();
      create trigger wager_transactions_lifecycle
        before update or delete on wager_transactions
        for each row execute function enforce_wager_transaction_lifecycle();

      alter table wager_transactions
        drop constraint wager_transactions_pending_schedule_order_check,
        drop constraint wager_transactions_pending_lease_check,
        drop constraint wager_transactions_pending_context_check,
        drop column pending_lease_expires_at,
        drop column pending_lease_token,
        drop column pending_causation_id,
        drop column pending_correlation_id;
    `);
  }
}
