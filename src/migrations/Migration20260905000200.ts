import { Migration } from '@mikro-orm/migrations';

export class Migration20260905000200 extends Migration {
  override up(): void {
    this.addSql(`
      alter table outbox_messages
        add column blocked_at timestamptz,
        add column last_block_reason varchar(64),
        add column replay_count integer not null default 0,
        add column last_replayed_at timestamptz,
        add constraint outbox_messages_block_reason_check check (
          last_block_reason is null
          or last_block_reason in ('PERMANENT_PUBLISH_FAILURE', 'RETRY_EXHAUSTED')
        ),
        add constraint outbox_messages_blocked_state_check check (
          blocked_at is null
          or (
            published_at is null
            and lease_token is null
            and lease_expires_at is null
            and last_block_reason is not null
          )
        ),
        add constraint outbox_messages_replay_count_check check (replay_count >= 0),
        add constraint outbox_messages_replay_metadata_check check (
          (replay_count = 0 and last_replayed_at is null)
          or (replay_count > 0 and last_replayed_at is not null)
        );
    `);

    this.addSql(`
      create table outbox_replay_audit (
        id uuid primary key,
        outbox_id uuid not null references outbox_messages (id),
        operator_id varchar(128) not null,
        blocked_reason varchar(64) not null,
        previous_attempts integer not null,
        replayed_at timestamptz not null,
        constraint outbox_replay_audit_operator_check
          check (operator_id ~ '^[A-Za-z0-9._@:-]{1,128}$'),
        constraint outbox_replay_audit_reason_check
          check (blocked_reason in ('PERMANENT_PUBLISH_FAILURE', 'RETRY_EXHAUSTED')),
        constraint outbox_replay_audit_attempts_check check (previous_attempts >= 1)
      );

      create index outbox_replay_audit_outbox_idx
        on outbox_replay_audit (outbox_id, replayed_at, id);

      create trigger outbox_replay_audit_immutable
        before update or delete on outbox_replay_audit
        for each row execute function reject_immutable_financial_row();
    `);

    this.addSql(`
      drop index if exists outbox_messages_publishable_idx;
      create index outbox_messages_publishable_idx
        on outbox_messages (next_attempt_at, lease_expires_at, occurred_at, id)
        where published_at is null and blocked_at is null;

      create index outbox_messages_blocked_idx
        on outbox_messages (blocked_at, id)
        where published_at is null and blocked_at is not null;
    `);
  }

  override down(): void {
    this.addSql(`
      drop index if exists outbox_messages_blocked_idx;
      drop index if exists outbox_messages_publishable_idx;
      create index outbox_messages_publishable_idx
        on outbox_messages (next_attempt_at, lease_expires_at, occurred_at, id)
        where published_at is null;
    `);
    this.addSql(`
      drop trigger if exists outbox_replay_audit_immutable on outbox_replay_audit;
      drop table if exists outbox_replay_audit;
    `);
    this.addSql(`
      alter table outbox_messages
        drop constraint if exists outbox_messages_replay_metadata_check,
        drop constraint if exists outbox_messages_replay_count_check,
        drop constraint if exists outbox_messages_blocked_state_check,
        drop constraint if exists outbox_messages_block_reason_check,
        drop column if exists last_replayed_at,
        drop column if exists replay_count,
        drop column if exists last_block_reason,
        drop column if exists blocked_at;
    `);
  }
}
