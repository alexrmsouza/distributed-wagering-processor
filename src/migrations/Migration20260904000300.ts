import { Migration } from '@mikro-orm/migrations';

export class Migration20260904000300 extends Migration {
  override up(): void {
    this.addSql(`
      alter table wallets
        add constraint wallets_currency_check check (currency ~ '^[A-Z]{3}$'),
        add constraint wallets_balance_nonnegative_check check (balance_minor >= 0),
        add constraint wallets_version_check check (version >= 1),
        add constraint wallets_ledger_sequence_check check (ledger_sequence >= 0),
        add constraint wallets_hash_head_check check (
          (ledger_sequence = 0 and last_ledger_hash is null)
          or (ledger_sequence > 0 and last_ledger_hash ~ '^[0-9a-f]{64}$')
        );
    `);

    this.addSql(`
      alter table wager_transactions
        add constraint wager_transactions_payload_hash_check
          check (payload_hash ~ '^[0-9a-f]{64}$'),
        add constraint wager_transactions_kind_check
          check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        add constraint wager_transactions_amount_check check (amount_minor > 0),
        add constraint wager_transactions_currency_check check (currency ~ '^[A-Z]{3}$'),
        add constraint wager_transactions_status_check
          check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        add constraint wager_transactions_failure_code_check check (
          failure_code is null or failure_code in (
            'INVALID_PAYLOAD', 'WALLET_NOT_FOUND', 'CURRENCY_MISMATCH',
            'INSUFFICIENT_FUNDS', 'REVERSAL_WOULD_OVERDRAW', 'REFERENCE_NOT_FOUND',
            'INVALID_REFERENCE', 'REFERENCE_ALREADY_REVERSED', 'IDEMPOTENCY_CONFLICT'
          )
        ),
        add constraint wager_transactions_reference_check check (
          (kind in ('REFUND', 'ROLLBACK') and reference_external_transaction_id is not null)
          or (kind not in ('REFUND', 'ROLLBACK') and reference_external_transaction_id is null
              and reference_transaction_id is null)
        ),
        add constraint wager_transactions_pending_retry_check check (
          (status = 'PENDING_REFERENCE' and next_retry_at is not null
            and retry_expires_at is not null and retry_expires_at > created_at)
          or (status <> 'PENDING_REFERENCE' and next_retry_at is null and retry_expires_at is null)
        ),
        add constraint wager_transactions_retry_attempts_check check (retry_attempts >= 0),
        add constraint wager_transactions_observed_balance_check
          check (observed_balance_minor is null or observed_balance_minor >= 0);
    `);

    this.addSql(`
      alter table wallet_ledger_entries
        add constraint wallet_ledger_entries_sequence_check check (entry_sequence >= 1),
        add constraint wallet_ledger_entries_direction_check check (direction in ('DEBIT', 'CREDIT')),
        add constraint wallet_ledger_entries_amount_check check (amount_minor > 0),
        add constraint wallet_ledger_entries_currency_check check (currency ~ '^[A-Z]{3}$'),
        add constraint wallet_ledger_entries_balances_check
          check (balance_before_minor >= 0 and balance_after_minor >= 0),
        add constraint wallet_ledger_entries_arithmetic_check check (
          (direction = 'DEBIT' and balance_after_minor = balance_before_minor - amount_minor)
          or (direction = 'CREDIT' and balance_after_minor = balance_before_minor + amount_minor)
        ),
        add constraint wallet_ledger_entries_hash_check check (
          entry_hash ~ '^[0-9a-f]{64}$'
          and (previous_entry_hash is null or previous_entry_hash ~ '^[0-9a-f]{64}$')
        ),
        add constraint wallet_ledger_entries_first_hash_check check (
          (entry_sequence = 1 and previous_entry_hash is null)
          or (entry_sequence > 1 and previous_entry_hash is not null)
        );
    `);

    this.addSql(`
      alter table accounts
        add constraint accounts_kind_check
          check (kind in ('PLAYER_BALANCE', 'PROVIDER_CLEARING', 'INTERNAL_FUNDING')),
        add constraint accounts_currency_check check (currency ~ '^[A-Z]{3}$');

      alter table accounting_postings
        add constraint accounting_postings_direction_check check (direction in ('DEBIT', 'CREDIT')),
        add constraint accounting_postings_amount_check check (amount_minor > 0),
        add constraint accounting_postings_currency_check check (currency ~ '^[A-Z]{3}$');

      alter table inbox_messages
        add constraint inbox_messages_payload_hash_check check (payload_hash ~ '^[0-9a-f]{64}$'),
        add constraint inbox_messages_processing_order_check
          check (processed_at is null or processed_at >= received_at);

      alter table outbox_messages
        add constraint outbox_messages_version_check check (version >= 1),
        add constraint outbox_messages_attempts_check check (attempts >= 0),
        add constraint outbox_messages_payload_check check (jsonb_typeof(payload) = 'object'),
        add constraint outbox_messages_lease_check check (
          (lease_token is null and lease_expires_at is null)
          or (lease_token is not null and lease_expires_at is not null)
        );
    `);

    this.addSql(`
      create unique index wager_transactions_reversal_unique_idx
        on wager_transactions (provider_id, kind, reference_transaction_id)
        where kind in ('REFUND', 'ROLLBACK') and reference_transaction_id is not null;

      create index wager_transactions_pending_reference_due_idx
        on wager_transactions (next_retry_at, id)
        where status = 'PENDING_REFERENCE';

      create index wallet_ledger_entries_cursor_idx
        on wallet_ledger_entries (wallet_id, created_at, id);

      create index outbox_messages_publishable_idx
        on outbox_messages (next_attempt_at, lease_expires_at, occurred_at, id)
        where published_at is null;

      create index outbox_messages_aggregate_order_idx
        on outbox_messages (aggregate_id, occurred_at, id)
        where published_at is null;
    `);

    this.addSql(`
      create function reject_immutable_financial_row()
      returns trigger
      language plpgsql
      as $$
      begin
        raise exception '% is immutable', tg_table_name using errcode = '55000';
      end;
      $$;

      create trigger wallet_ledger_entries_immutable
        before update or delete on wallet_ledger_entries
        for each row execute function reject_immutable_financial_row();

      create trigger accounting_journals_immutable
        before update or delete on accounting_journals
        for each row execute function reject_immutable_financial_row();

      create trigger accounting_postings_immutable
        before update or delete on accounting_postings
        for each row execute function reject_immutable_financial_row();

      create trigger accounts_immutable
        before update or delete on accounts
        for each row execute function reject_immutable_financial_row();
    `);

    this.addSql(`
      create function enforce_wager_transaction_lifecycle()
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
          or old.reference_transaction_id is distinct from new.reference_transaction_id
          or old.created_at is distinct from new.created_at then
          raise exception 'Wager transaction business identity is immutable' using errcode = '55000';
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
        for each row execute function enforce_wager_transaction_lifecycle();
    `);

    this.addSql(`
      create function enforce_inbox_message_immutability()
      returns trigger
      language plpgsql
      as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'inbox_messages is immutable' using errcode = '55000';
        end if;

        if old.consumer_name is distinct from new.consumer_name
          or old.message_id is distinct from new.message_id
          or old.payload_hash is distinct from new.payload_hash
          or old.received_at is distinct from new.received_at then
          raise exception 'Inbox message identity and payload are immutable' using errcode = '55000';
        end if;

        return new;
      end;
      $$;

      create trigger inbox_messages_immutable
        before update or delete on inbox_messages
        for each row execute function enforce_inbox_message_immutability();
    `);

    this.addSql(`
      create function enforce_outbox_message_immutability()
      returns trigger
      language plpgsql
      as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'outbox_messages is immutable' using errcode = '55000';
        end if;

        if old.id is distinct from new.id
          or old.event_id is distinct from new.event_id
          or old.aggregate_id is distinct from new.aggregate_id
          or old.event_type is distinct from new.event_type
          or old.version is distinct from new.version
          or old.payload is distinct from new.payload
          or old.correlation_id is distinct from new.correlation_id
          or old.causation_id is distinct from new.causation_id
          or old.occurred_at is distinct from new.occurred_at then
          raise exception 'Outbox event identity and payload are immutable' using errcode = '55000';
        end if;

        return new;
      end;
      $$;

      create trigger outbox_messages_immutable
        before update or delete on outbox_messages
        for each row execute function enforce_outbox_message_immutability();
    `);

    this.addSql(`
      create function enforce_balanced_accounting_journal()
      returns trigger
      language plpgsql
      as $$
      declare
        target_journal_id uuid;
        trigger_row jsonb;
        posting_count integer;
        debit_total numeric;
        credit_total numeric;
        currency_count integer;
      begin
        trigger_row := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
        target_journal_id := coalesce(
          trigger_row ->> 'journal_id',
          trigger_row ->> 'id'
        )::uuid;

        if not exists (select 1 from accounting_journals where id = target_journal_id) then
          return null;
        end if;

        select count(*),
               coalesce(sum(amount_minor) filter (where direction = 'DEBIT'), 0),
               coalesce(sum(amount_minor) filter (where direction = 'CREDIT'), 0),
               count(distinct currency)
          into posting_count, debit_total, credit_total, currency_count
          from accounting_postings
         where journal_id = target_journal_id;

        if posting_count <> 2 or debit_total <> credit_total or currency_count <> 1 then
          raise exception 'Accounting journal % must contain exactly two balanced same-currency postings',
            target_journal_id using errcode = '23514';
        end if;

        return null;
      end;
      $$;

      create constraint trigger accounting_journals_balanced
        after insert on accounting_journals
        deferrable initially deferred
        for each row execute function enforce_balanced_accounting_journal();

      create constraint trigger accounting_postings_balanced
        after insert or update or delete on accounting_postings
        deferrable initially deferred
        for each row execute function enforce_balanced_accounting_journal();
    `);

    this.addSql(`
      create function enforce_wallet_ledger_head()
      returns trigger
      language plpgsql
      as $$
      declare
        trigger_row jsonb;
        target_wallet_id uuid;
        wallet_balance bigint;
        wallet_currency char(3);
        wallet_sequence bigint;
        wallet_hash char(64);
        ledger_count bigint;
        latest_balance bigint;
        latest_currency char(3);
        latest_sequence bigint;
        latest_hash char(64);
      begin
        trigger_row := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
        target_wallet_id := coalesce(
          trigger_row ->> 'wallet_id',
          trigger_row ->> 'id'
        )::uuid;

        select balance_minor, currency, ledger_sequence, last_ledger_hash
          into wallet_balance, wallet_currency, wallet_sequence, wallet_hash
          from wallets
         where id = target_wallet_id;

        if not found then
          return null;
        end if;

        select count(*), max(entry_sequence)
          into ledger_count, latest_sequence
          from wallet_ledger_entries
         where wallet_id = target_wallet_id;

        if wallet_sequence = 0 then
          if wallet_balance <> 0 or wallet_hash is not null or ledger_count <> 0 then
            raise exception 'Wallet % has an invalid empty ledger head', target_wallet_id
              using errcode = '23514';
          end if;
          return null;
        end if;

        select balance_after_minor, currency, entry_hash
          into latest_balance, latest_currency, latest_hash
          from wallet_ledger_entries
         where wallet_id = target_wallet_id and entry_sequence = wallet_sequence;

        if not found
          or ledger_count <> wallet_sequence
          or latest_sequence <> wallet_sequence
          or latest_balance <> wallet_balance
          or latest_currency <> wallet_currency
          or latest_hash <> wallet_hash
          or exists (
            select 1
              from wallet_ledger_entries first_entry
             where first_entry.wallet_id = target_wallet_id
               and first_entry.entry_sequence = 1
               and first_entry.balance_before_minor <> 0
          )
          or exists (
            select 1
              from wallet_ledger_entries current_entry
              left join wallet_ledger_entries previous_entry
                on previous_entry.wallet_id = current_entry.wallet_id
               and previous_entry.entry_sequence = current_entry.entry_sequence - 1
             where current_entry.wallet_id = target_wallet_id
               and current_entry.entry_sequence > 1
               and (
                 previous_entry.id is null
                 or current_entry.previous_entry_hash <> previous_entry.entry_hash
                 or current_entry.balance_before_minor <> previous_entry.balance_after_minor
                 or current_entry.currency <> previous_entry.currency
               )
          ) then
          raise exception 'Wallet % does not match its ledger head', target_wallet_id
            using errcode = '23514';
        end if;

        return null;
      end;
      $$;

      create constraint trigger wallets_ledger_head_consistent
        after insert or update on wallets
        deferrable initially deferred
        for each row execute function enforce_wallet_ledger_head();

      create constraint trigger wallet_ledger_entries_head_consistent
        after insert or update or delete on wallet_ledger_entries
        deferrable initially deferred
        for each row execute function enforce_wallet_ledger_head();
    `);

    this.addSql(`
      create function enforce_financial_transaction_consistency()
      returns trigger
      language plpgsql
      as $$
      declare
        trigger_row jsonb;
        target_transaction_id uuid;
        transaction_row wager_transactions%rowtype;
        ledger_row wallet_ledger_entries%rowtype;
        journal_row accounting_journals%rowtype;
        ledger_count integer;
        journal_count integer;
        valid_posting_count integer;
        player_posting_count integer;
        counterparty_posting_count integer;
        expected_counterparty_kind varchar(32);
        expected_counterparty_owner varchar(255);
        movement_required boolean;
      begin
        trigger_row := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;

        if tg_table_name = 'wager_transactions' then
          target_transaction_id := (trigger_row ->> 'id')::uuid;
        elsif tg_table_name in ('wallet_ledger_entries', 'accounting_journals') then
          target_transaction_id := (trigger_row ->> 'transaction_id')::uuid;
        elsif tg_table_name = 'accounting_postings' then
          select transaction_id
            into target_transaction_id
            from accounting_journals
           where id = (trigger_row ->> 'journal_id')::uuid;
        end if;

        if target_transaction_id is null then
          return null;
        end if;

        select *
          into transaction_row
          from wager_transactions
         where id = target_transaction_id;

        if not found then
          return null;
        end if;

        movement_required := transaction_row.status = 'PROCESSED'
          and transaction_row.kind <> 'LOSS';

        select count(*)
          into ledger_count
          from wallet_ledger_entries
         where transaction_id = target_transaction_id;

        select count(*)
          into journal_count
          from accounting_journals
         where transaction_id = target_transaction_id;

        if not movement_required then
          if ledger_count <> 0 or journal_count <> 0 then
            raise exception 'Transaction % must not have financial movement', target_transaction_id
              using errcode = '23514';
          end if;
          return null;
        end if;

        if ledger_count <> 1 or journal_count <> 1 then
          raise exception 'Transaction % must have exactly one ledger entry and one journal',
            target_transaction_id using errcode = '23514';
        end if;

        select *
          into ledger_row
          from wallet_ledger_entries
         where transaction_id = target_transaction_id;

        select *
          into journal_row
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

        if transaction_row.kind in ('OPENING', 'WIN', 'REFUND', 'ROLLBACK')
          and ledger_row.direction <> 'CREDIT' then
          raise exception 'Transaction % has an invalid ledger direction', target_transaction_id
            using errcode = '23514';
        end if;

        if transaction_row.kind = 'BET' and ledger_row.direction <> 'DEBIT' then
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
    `);
  }

  override down(): void {
    this.addSql(
      'drop trigger if exists accounting_postings_financial_consistency on accounting_postings;',
    );
    this.addSql(
      'drop trigger if exists accounting_journals_financial_consistency on accounting_journals;',
    );
    this.addSql(
      'drop trigger if exists wallet_ledger_entries_financial_consistency on wallet_ledger_entries;',
    );
    this.addSql(
      'drop trigger if exists wager_transactions_financial_consistency on wager_transactions;',
    );
    this.addSql('drop function if exists enforce_financial_transaction_consistency();');
    this.addSql(
      'drop trigger if exists wallet_ledger_entries_head_consistent on wallet_ledger_entries;',
    );
    this.addSql('drop trigger if exists wallets_ledger_head_consistent on wallets;');
    this.addSql('drop function if exists enforce_wallet_ledger_head();');
    this.addSql('drop trigger if exists accounting_postings_balanced on accounting_postings;');
    this.addSql('drop trigger if exists accounting_journals_balanced on accounting_journals;');
    this.addSql('drop function if exists enforce_balanced_accounting_journal();');
    this.addSql('drop trigger if exists outbox_messages_immutable on outbox_messages;');
    this.addSql('drop function if exists enforce_outbox_message_immutability();');
    this.addSql('drop trigger if exists inbox_messages_immutable on inbox_messages;');
    this.addSql('drop function if exists enforce_inbox_message_immutability();');
    this.addSql('drop trigger if exists wager_transactions_lifecycle on wager_transactions;');
    this.addSql('drop function if exists enforce_wager_transaction_lifecycle();');
    this.addSql('drop trigger if exists accounts_immutable on accounts;');
    this.addSql('drop trigger if exists accounting_postings_immutable on accounting_postings;');
    this.addSql('drop trigger if exists accounting_journals_immutable on accounting_journals;');
    this.addSql('drop trigger if exists wallet_ledger_entries_immutable on wallet_ledger_entries;');
    this.addSql('drop function if exists reject_immutable_financial_row();');

    this.addSql('drop index if exists outbox_messages_aggregate_order_idx;');
    this.addSql('drop index if exists outbox_messages_publishable_idx;');
    this.addSql('drop index if exists wallet_ledger_entries_cursor_idx;');
    this.addSql('drop index if exists wager_transactions_pending_reference_due_idx;');
    this.addSql('drop index if exists wager_transactions_reversal_unique_idx;');

    this.addSql(
      'alter table outbox_messages drop constraint if exists outbox_messages_lease_check;',
    );
    this.addSql(
      'alter table outbox_messages drop constraint if exists outbox_messages_payload_check;',
    );
    this.addSql(
      'alter table outbox_messages drop constraint if exists outbox_messages_attempts_check;',
    );
    this.addSql(
      'alter table outbox_messages drop constraint if exists outbox_messages_version_check;',
    );
    this.addSql(
      'alter table inbox_messages drop constraint if exists inbox_messages_processing_order_check;',
    );
    this.addSql(
      'alter table inbox_messages drop constraint if exists inbox_messages_payload_hash_check;',
    );
    this.addSql(
      'alter table accounting_postings drop constraint if exists accounting_postings_currency_check;',
    );
    this.addSql(
      'alter table accounting_postings drop constraint if exists accounting_postings_amount_check;',
    );
    this.addSql(
      'alter table accounting_postings drop constraint if exists accounting_postings_direction_check;',
    );
    this.addSql('alter table accounts drop constraint if exists accounts_currency_check;');
    this.addSql('alter table accounts drop constraint if exists accounts_kind_check;');
    this.addSql(
      'alter table wallet_ledger_entries drop constraint if exists wallet_ledger_entries_first_hash_check;',
    );
    this.addSql(
      'alter table wallet_ledger_entries drop constraint if exists wallet_ledger_entries_hash_check;',
    );
    this.addSql(
      'alter table wallet_ledger_entries drop constraint if exists wallet_ledger_entries_arithmetic_check;',
    );
    this.addSql(
      'alter table wallet_ledger_entries drop constraint if exists wallet_ledger_entries_balances_check;',
    );
    this.addSql(
      'alter table wallet_ledger_entries drop constraint if exists wallet_ledger_entries_currency_check;',
    );
    this.addSql(
      'alter table wallet_ledger_entries drop constraint if exists wallet_ledger_entries_amount_check;',
    );
    this.addSql(
      'alter table wallet_ledger_entries drop constraint if exists wallet_ledger_entries_direction_check;',
    );
    this.addSql(
      'alter table wallet_ledger_entries drop constraint if exists wallet_ledger_entries_sequence_check;',
    );
    this.addSql(
      'alter table wager_transactions drop constraint if exists wager_transactions_observed_balance_check;',
    );
    this.addSql(
      'alter table wager_transactions drop constraint if exists wager_transactions_retry_attempts_check;',
    );
    this.addSql(
      'alter table wager_transactions drop constraint if exists wager_transactions_pending_retry_check;',
    );
    this.addSql(
      'alter table wager_transactions drop constraint if exists wager_transactions_reference_check;',
    );
    this.addSql(
      'alter table wager_transactions drop constraint if exists wager_transactions_failure_code_check;',
    );
    this.addSql(
      'alter table wager_transactions drop constraint if exists wager_transactions_status_check;',
    );
    this.addSql(
      'alter table wager_transactions drop constraint if exists wager_transactions_currency_check;',
    );
    this.addSql(
      'alter table wager_transactions drop constraint if exists wager_transactions_amount_check;',
    );
    this.addSql(
      'alter table wager_transactions drop constraint if exists wager_transactions_kind_check;',
    );
    this.addSql(
      'alter table wager_transactions drop constraint if exists wager_transactions_payload_hash_check;',
    );
    this.addSql('alter table wallets drop constraint if exists wallets_hash_head_check;');
    this.addSql('alter table wallets drop constraint if exists wallets_ledger_sequence_check;');
    this.addSql('alter table wallets drop constraint if exists wallets_version_check;');
    this.addSql('alter table wallets drop constraint if exists wallets_balance_nonnegative_check;');
    this.addSql('alter table wallets drop constraint if exists wallets_currency_check;');
  }
}
