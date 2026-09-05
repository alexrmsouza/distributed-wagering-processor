# Architecture

## Delivery status

The repository provides a runnable distributed wagering service with local
infrastructure, exact shared primitives, explicit transaction boundaries,
persistence mappings, and a database-enforced financial schema. It implements
wallet opening and inspection; BET, WIN, LOSS, REFUND, and ROLLBACK processing;
durable pending-reference recovery; SQS command consumption; native redrive;
coordinated shutdown; and transactional Outbox publication. Multi-process
recovery, durable downstream duplicate handling, reconciliation diagnostics,
structured redacted logs, bounded Prometheus metrics, and public liveness and
dependency-readiness endpoints are executable and covered by automated tests.

## Runtime baseline

- Bun is the runtime, package manager, build tool, and test runner.
- NestJS hosts one backend service.
- MikroORM connects the service to PostgreSQL and owns the versioned migration
  entry point.
- LocalStack provides local AWS SQS queues.
- Docker Compose runs the application, PostgreSQL, and LocalStack without cloud
  credentials or external infrastructure.

The application reads validated configuration before creating the NestJS
process. Invalid or incomplete environment configuration fails fast without
logging credentials. Shutdown hooks coordinate the HTTP server, queue consumer,
pending-reference worker, and Outbox publisher without replacing the bootstrap.

## Local Docker workflow

Portable automation first uses a directly reachable Docker daemon. On Windows,
when direct access is unavailable, it invokes Docker Engine and Docker Compose
through the explicitly configured `Ubuntu` WSL 2 distribution from the current
repository mount. It never starts Docker Desktop, installs Docker, or switches
Docker contexts or daemons.

## Exact values and deterministic identity

Public money is accepted only as a non-negative decimal string with exactly two
fractional digits and an uppercase three-letter currency. The immutable domain
value converts it to signed-safe `bigint` minor units for arithmetic and
persistence. Neither domain operations nor database rows use binary
floating-point money.

Business payload identity uses SHA-256 over recursively canonicalized JSON.
Object keys use locale-independent UTF-16 ordering, array order remains
significant, and ambiguous inputs such as non-finite numbers, sparse arrays,
accessors, cycles, class instances, and non-JSON values are rejected instead of
being silently normalized.

## Transaction and persistence boundary

Application code depends on a generic `TransactionRunner` and repository ports.
The MikroORM adapter opens a request context and one database transaction, then
uses a context factory to supply repositories bound to that transactional
`EntityManager`. Repositories are never acquired globally inside financial use
cases, and network calls do not belong inside the transaction.

Persistence uses explicit MikroORM `EntitySchema` mappings for every persisted
table. These row types are separate from domain entities; Inbox and Outbox use
explicit mappers with static domain rehydration. This keeps NestJS and MikroORM
out of domain code while still making column names and bigint conversion
reviewable.

The wallet-opening flow constructs wallet, transaction, accounting, and Outbox
adapters from the same transaction-scoped `EntityManager`. A funded opening
inserts the wallet, internal `OPENING` transaction, operational ledger entry,
player and funding accounts, balanced journal, two postings, and `WalletOpened`
Outbox envelope before one commit. The `before_financial_commit` failpoint
exercises the real use case and proves that every write rolls back together. No
broker or other network call occurs inside this boundary.

A zero-balance wallet is a deliberate separate path required by the public
contract: it creates the wallet and its `WalletOpened` Outbox envelope, but does
not invent a zero-value transaction, ledger entry, or accounting journal that
would violate the positive-movement invariants.

Wager processing uses the same boundary for the idempotency decision, wallet
lock, transaction outcome, wallet mutation, operational ledger, balanced
accounting, wallet audit-chain head, and Outbox envelopes. The real wagering use
case is covered by the same pre-commit failpoint, proving that its claim and
every financial or messaging write roll back together.

## Wagering lock and idempotency strategy

PostgreSQL wallet rows are the only financial serialization point. A valid BET
or WIN performs an unlocked replay lookup, locks its target wallet with `SELECT
... FOR UPDATE`, inserts the durable idempotency claim, and only then applies a
financial effect. This ordering is intentional: inserting a row with a wallet
foreign key before acquiring the wallet lock would let two contenders hold
`KEY SHARE` locks and deadlock while both upgrade to `FOR UPDATE`. Once the
wallet is locked, the claim is still durable before any balance, ledger,
accounting, audit-head, or Outbox mutation.

LOSS and requests whose player or currency already makes mutation impossible do
not acquire an explicit wallet lock. Exact committed replays are returned by the
initial lookup without a wallet lock. A race after that lookup is resolved by
the database uniqueness constraints: the winner inserts the claim, while the
loser reads the now-committed terminal row and returns its original transaction
identifier, outcome, and observed balance. A matching provider, external
transaction identity, idempotency key, and canonical business-payload hash is an
exact replay. Reusing either unique identity with a different canonical payload
is an `IDEMPOTENCY_CONFLICT` and has no financial or Outbox effect.

Lock scope is one wallet row and there is no application-global mutex, advisory
lock, or queue-dependent correctness assumption. Real multi-process tests prove
that fifty identical deliveries create one effect, two concurrent BRL 80.00
BETs against BRL 100.00 serialize into one processed debit and one
`INSUFFICIENT_FUNDS` rejection, and unrelated wallets progress while another
wallet is locked. Lock wait duration is recorded in seconds with only the
low-cardinality outcomes `acquired`, `not_found`, and `failed`; wallet and
provider identifiers are never metric labels.

## Database-enforced financial invariants

Five ordered raw-SQL migrations are transactional, reversible, and own the
complete foundational schema. PostgreSQL enforces:

- one wallet per player and currency, non-negative balances, and valid versions;
- unique provider idempotency and external transaction identities;
- exact transaction kinds, states, currencies, payload hashes, references, and
  retry metadata;
- one immutable operational movement per transaction and sequence, with valid
  direction, amount, before/after arithmetic, and hash shape;
- a deferred wallet-head check that proves the wallet balance, currency,
  sequence, hash head, zero-based first movement, chain links, and balance
  continuity match its ledger at commit;
- one immutable accounting journal per financial transaction, exactly two
  immutable same-currency postings, equal debit and credit totals, and deferred
  reconciliation with the transaction, wallet, ledger movement, account owners,
  currency, direction, and amount at commit;
- immutable terminal Wager Transactions and guarded pre-terminal state
  transitions;
- durable Inbox uniqueness and immutable delivery identity while processing
  linkage and completion remain lifecycle fields;
- immutable Outbox event identity and payload while retry, lease, and publication
  remain lifecycle fields, backed by aggregate-order and lease-aware due-work
  indexes.

Direct SQL integration tests run these guarantees against the real PostgreSQL
container. Migration tests apply all revisions, reverse them to zero, and apply
them again in an isolated database. The fourth migration adds the explicit
observed-balance currency pair so a currency-mismatch rejection can preserve the
wallet's original observed Money without misrepresenting it as the submitted
transaction currency.

## Wallet history and reconciliation

Wallet and accounting domain objects are immutable and expose static creation
and rehydration factories without NestJS or MikroORM dependencies. Balance
transitions return a new wallet version; attaching an opening ledger head does
not increment the creation version. Ledger hashes use SHA-256 over canonical JSON
schema version 1, representing bigint values as decimal strings and timestamps
as ISO-8601. Each hash commits to wallet, transaction, sequence, direction,
amount, currency, before/after balances, timestamp, and the preceding hash.

Ledger pagination is keyset-based on `(created_at, id)`. The cursor is a validated
versioned Base64URL token, and pages fetch one extra row to determine whether a
next cursor exists. Inserts ordered before an issued boundary cannot shift or
duplicate subsequent pages.

Reconciliation locks only the target wallet, then reads operational and
accounting history through adapters bound to that same transaction. It compares
the materialized balance with a reconstruction from zero, verifies every
canonical audit link and the wallet hash head, checks each journal balance, and
compares the player-account net balance with the operational reconstruction.
Signed differences are serialized as exact two-decimal strings. Divergence is
reported and never repaired.

`POST /wallets`, wallet retrieval, ledger retrieval, and reconciliation use the
explicit authentication guard extension point. Public Money is always serialized
as `{ amount: string, currency: string }`; malformed inputs and cursors are 400,
unknown wallets are 404, and duplicate player/currency wallets are 409.

## Reversal and pending-reference processing

REFUND and ROLLBACK use the provider's external transaction identifier as their
public reference. An internal transaction UUID is resolved only after the source
exists and is never required by the HTTP contract. The executable transition
table is:

| Current state                        | Condition                                 | Next state                             | Financial effect                               |
| ------------------------------------ | ----------------------------------------- | -------------------------------------- | ---------------------------------------------- |
| `PENDING`                            | compatible processed reference exists     | `PROCESSED`                            | exact inverse movement                         |
| `PENDING`                            | no reference exists                       | `PENDING_REFERENCE`                    | none                                           |
| `PENDING`                            | invalid or already-reversed reference     | `REJECTED`                             | none                                           |
| `PENDING_REFERENCE`                  | compatible reference later exists         | `PROCESSED`                            | exact inverse movement                         |
| `PENDING_REFERENCE`                  | reference remains absent before TTL       | `PENDING_REFERENCE`                    | none; retry metadata advances                  |
| `PENDING_REFERENCE`                  | 24-hour TTL reached                       | `REJECTED` / `REFERENCE_NOT_FOUND`     | none                                           |
| `PENDING` or `PENDING_REFERENCE`     | inverse debit would make balance negative | `REJECTED` / `REVERSAL_WOULD_OVERDRAW` | none                                           |
| `PROCESSED`, `REJECTED`, or `FAILED` | any later attempt                         | unchanged                              | none; exact identity replays the stored result |

A REFUND references only a processed BET and creates one CREDIT for exactly the
BET amount. A ROLLBACK references a processed BET, WIN, or REFUND: BET is
inverted by CREDIT, while WIN and REFUND are inverted by DEBIT. Partial
reversals are unsupported. Provider, wallet, player, currency, amount, round,
game, source kind, source state, and external reference must all match. A
PostgreSQL partial unique index on provider, reversal kind, and resolved source
transaction prevents two reversals of the same kind even when concurrent
requests use different idempotency identities.

Potentially valid balance-changing reversals preserve the established lock
order: committed replay lookup, target wallet `FOR UPDATE`, referenced Wager
Transaction `FOR UPDATE`, reversal row lock or insert, duplicate-reversal check,
validation, and financial writes. A missing reference is persisted without a
wallet lock because it cannot change financial state. Invalid references that
cannot mutate a wallet are rejected without taking a wallet lock. There is no
global mutex, process-local correctness lock, or broker-ordering dependency.

Successful reversals atomically persist the resolved internal reference,
terminal transaction outcome and original observed balance, wallet balance and
version, audit-chain head, one operational ledger entry, one balanced journal,
two postings, `WagerTransactionProcessed`, and `WalletBalanceChanged`. A
business rejection atomically persists only the terminal outcome and one
`WagerTransactionRejected`; no wallet, ledger, accounting, audit-head, or
balance-change event is written. PostgreSQL deferred triggers independently
verify the reversal direction and financial graph at commit.

The initial missing-reference transaction atomically stores its canonical
payload identity, immutable business context, original correlation context,
retry schedule, and one `WagerTransactionPendingReference` Outbox event. Exact
pending replays neither restart the TTL nor reset attempts or emit another
pending event. The fixed expiration is 24 hours after initial acceptance.
Attempt zero is due after 30 seconds; each unresolved attempt increments the
persisted counter and schedules `30 seconds * 2^attempt`, capped at one hour.
The next wake-up is clamped to the expiration instant, and `now >= expiration`
is terminal.

Each worker pass claims a bounded batch in a short transaction with `FOR UPDATE
SKIP LOCKED`, writes a UUID lease token and expiration, then commits before doing
further work. Final processing verifies and locks the active lease. Missing
references reschedule and clear the lease atomically; terminal outcomes clear it
with the same commit. An expired lease is reclaimable by another worker. Real
PostgreSQL tests cover competing worker processes claiming distinct due rows,
lease recovery, exact TTL expiration, and duplicate-event prevention. A separate
two-service-process test proves exactly-once financial completion when both
instances race to resume the same newly resolvable pending reversal.
The Nest lifecycle starts a one-second polling loop and stops it during shutdown;
that timer only wakes the worker, while persisted due times and leases remain the
sole correctness authority.

## SQS command consumption and Inbox boundary

The command queue carries a strict, versioned `WagerTransactionRequested`
envelope. The adapter rejects unknown properties, malformed identifiers,
non-canonical or impossible UTC timestamps, invalid operation/reference combinations, and
invalid Money before opening a database transaction. Valid envelopes are frozen,
hashed as complete canonical JSON, and mapped to the same
`ProcessWagerTransactionCommand` used by HTTP. The immutable envelope
`messageId` is both correlation and causation identity; it is not part of the
business idempotency fingerprint.

For each valid delivery, one `MikroOrmTransactionRunner` invocation claims
`(consumerName, messageId)`, compares its immutable envelope hash, calls
`ProcessWagerTransactionUseCase.executeInContext`, persists all financial and
Outbox records, links the resulting transaction when one exists, completes the
Inbox row, and commits. The in-context entry point contains the same business
implementation used by HTTP without opening a nested transaction. A completed
exact duplicate reads the persisted transaction and original observed balance;
it performs no financial or Outbox write. A divergent envelope with the same
Inbox identity is an explicit idempotency conflict and cannot reach business
processing. Rejections without a persistable transaction, such as an unknown
wallet, derive a stable result UUID from the canonical business-payload hash so
an exact Inbox redelivery preserves its original result identity. A committed
business-idempotency conflict remains unlinked from the conflicting transaction
and is deterministically reclassified on exact redelivery. Business idempotency
remains independent, so distinct messages and HTTP requests carrying the same
business command converge on one outcome.

`ReceiveMessage`, `DeleteMessage`, and `ChangeMessageVisibility` always execute
outside PostgreSQL transactions. A terminal processed, rejected,
pending-reference, `FAILED`, conflict, or safe replay outcome is deleted only
after commit. An error classified as transient remains unacknowledged and gets
an exponential per-receipt visibility timeout of 30 seconds doubled to a
one-hour cap. Malformed or permanently invalid transport deliveries get zero
visibility and are never deleted by the application; the source queue's native
redrive policy moves them to the FIFO DLQ after its configured receive limit.
The consumer never manually publishes to the DLQ.

Each active receipt moves through `received`, `processing`, `committed`, and
`acknowledged`, or through `retryable` and `released`. Shutdown first aborts the
long poll and refuses new receipts. Already committed work may finish deletion
within the bounded grace period; uncommitted work is not deleted and has its
visibility released for another process. Poll completion and best-effort
visibility release share one abortable shutdown deadline, so unavailable SQS I/O
cannot extend shutdown indefinitely. A delivery that finishes after its receipt
was released cannot reopen the local lifecycle state. Receipt state is lifecycle
coordination only, never a correctness or deduplication store. PostgreSQL Inbox
and business constraints remain authoritative.

The guarded `after_financial_commit_before_sqs_ack` failpoint runs after the
transaction runner returns and before `DeleteMessage`. A real-process test exits
at that boundary, starts three competing consumers, and proves redelivery leaves
one Wager Transaction, one applicable ledger entry, one balanced accounting
journal, one logical Outbox event set, and one completed Inbox identity. Shutdown
tests also pause before and after commit. POSIX hosts deliver `SIGTERM` directly;
the Windows Bun harness dispatches the same shutdown handler through IPC because
Windows does not provide POSIX signal delivery semantics to child processes.

## Transactional Outbox publication

Financial commands persist the complete immutable integration-event envelope in
the Outbox before their Unit of Work commits. The publisher uses that JSONB value
as the authoritative message body; it never rebuilds an event from later wallet,
transaction, ledger, or accounting state. Concrete version-1 events are
`WalletOpened`, `WagerTransactionProcessed`, `WagerTransactionRejected`,
`WagerTransactionPendingReference`, and `WalletBalanceChanged`. Their envelope
identity, aggregate, correlation, optional causation, timestamp, type, version,
and Money string objects are immutable.

Each publisher pass opens a short claim transaction. It selects a bounded batch
of due unpublished rows whose lease is absent or expired, locks them with `FOR
UPDATE SKIP LOCKED`, assigns one UUID lease token and expiration, and commits.
The eligibility query also rejects any candidate with an earlier unpublished
row for the same `aggregateId`, ordered by `(occurredAt, id)`. Consequently, a
leased or retry-delayed head blocks later wallet events, while unrelated wallets
remain available to competing publisher processes.

SQS `SendMessage` runs after the claim transaction has closed. The FIFO
`MessageGroupId` is the wallet `aggregateId`; `MessageDeduplicationId` is the
immutable `eventId`; the body is the exact persisted envelope. After broker
acceptance, a new short transaction sets `publishedAt` and clears the lease only
when the row still owns the expected lease token. A stale publisher cannot mark
or reschedule a lease that another process reclaimed.

A failed send increments persisted attempts, schedules a deterministic
exponential retry starting at one second and capped at one minute, and clears
the lease conditionally by token. The database is the retry and ownership source
of truth; polling timers only wake a worker. Shutdown stops new claims, wakes the
poll loop, and gives active work a bounded grace period. Already published work
may complete its conditional mark; unmarked claims remain recoverable after
lease expiration.

The guarded `after_outbox_claim_before_publish` failpoint terminates after the
claim commit and before network I/O. The guarded
`after_sqs_publish_before_outbox_mark_published` failpoint terminates after SQS
acceptance and before the publication mark. The first boundary proves no event
loss after lease recovery. The second intentionally permits an at-least-once
resend; the system does not claim exactly-once broker delivery.

Downstream duplicate safety is proven independently of the FIFO deduplication
window. The test consumer hashes the complete canonical envelope, atomically
claims `(consumerName, eventId)` in the durable Inbox, applies its effect, and
completes the Inbox row in one PostgreSQL transaction. An exact repeated event
returns `DUPLICATE`; reuse of the same `eventId` with divergent content returns
`IDEMPOTENCY_CONFLICT`; a failed handler rolls back both claim and effect.
Real-process tests run three competing publishers, recover expired leases,
preserve wallet event order, allow independent-wallet progress, and terminate
publishers at both failpoint boundaries.

## Operational observability and readiness

Operational diagnostics use newline-delimited JSON with the stable fields
`level`, `time`, `event`, and `correlationId`. Known identifiers such as
`messageId`, `transactionId`, `walletId`, `providerId`, `eventId`,
`causationId`, and `outboxMessageId` are included only after they are known and
needed. Event names come from a fixed allowlist. The command timeline is
`received`, `idempotency_decision`, optional `wallet_lock`,
`outbox_persisted`, `transaction_committed`, and, for SQS, `acknowledged`.
Asynchronous publication has its own causally correlated `outbox_claimed` and
`published` stages; diagnostics do not invent a global order between queue
acknowledgment and later Outbox publication.

Redaction is recursive at the logger boundary. Nested money and balance values,
request and response bodies, raw payloads, headers, authorization values,
cookies, receipt handles, connection strings, passwords, tokens, secrets,
credentials, and raw errors become the stable `[REDACTED]` marker. Credentialed
URLs, authorization-shaped strings, and exact two-decimal monetary strings are
also redacted regardless of their nesting. The output never stores a reversible
representation of a protected value. The same redaction applies to context
identifiers, and caller attributes cannot override reserved schema or identity
fields. Logger and metric calls are best-effort:
their failures cannot change a financial result, Inbox completion, Outbox
state, broker acknowledgment, publication outcome, or wallet-lock behavior.

One process-wide Prometheus registry is reused safely across repeated module and
test initialization. The public `/metrics` endpoint returns its text exposition.
The registered measurements are:

- `wager_transactions_total{status,kind,transport}`;
- `wager_duplicates_total{source}`;
- `wager_retries_total{component}`;
- `wager_dlq_messages_total{reason}`;
- `wallet_lock_wait_seconds{outcome}` and `wallet_lock_conflicts_total`;
- `wager_processing_duration_seconds{transport}`;
- `outbox_lag_seconds` and `outbox_publications_total{outcome}`;
- `inbox_processing_total{outcome}`;
- `wallet_reconciliation_divergences_total`;
- `failpoint_activations_total{name}`.

Every label is checked against a finite enumeration. Wallet, player, provider,
message, transaction, event, correlation, and causation identifiers; money;
URLs; exception messages; and other user-controlled values are never labels.
Histogram buckets are fixed, and no correlation identifier is registered with
Prometheus.

`GET /health/live` is public and reports only process and HTTP responsiveness;
dependency failure cannot make it unhealthy. `GET /health/ready` is also public
and runs the PostgreSQL and SQS probes independently and concurrently with the
configured bounded timeout, which defaults to 2 seconds. PostgreSQL executes
only `SELECT 1`. SQS executes only `GetQueueAttributes` for each configured
command, dead-letter, and integration-event queue. The probe never sends,
receives, deletes, purges, creates, or changes queue data. The response exposes
only `up` or `down` for each dependency and returns HTTP 503 when either is down;
provider errors, endpoints, queue URLs, account data, credentials, stack traces,
and connection strings are omitted.

The reconciliation response exposes `storedBalance`, `calculatedBalance`,
`accountingBalance`, `difference`, `consistent`, `checkedEntries`,
`accountingBalanced`, and `auditChainValid`. Accounting validation requires one
wallet-owned player-balance posting in each two-posting same-currency balanced
journal and the expected journal count. Controlled divergence increments its
counter and emits a redacted diagnostic, but the operation never repairs,
compensates, deletes, or rewrites financial history.

The observable failpoint adapter records only a predefined failpoint name and
safe stage, plus a bounded counter, before preserving the original deterministic
failure. It cannot log captured financial or transport state. This adapter does
not weaken activation guards: every failpoint controller still refuses
construction in development, production, or any other non-test environment,
requires explicit test enablement, and exposes no HTTP or administrative arming
surface.

## Failure policy

Invalid payloads are transport failures and return HTTP 400 without creating a
business transaction. Reuse of an idempotency identity with divergent canonical
business content returns HTTP 409 and has no second financial effect. Stable
business rejections return HTTP 422 and preserve their persisted failure code;
accepted pending references return HTTP 202. Retryable PostgreSQL, lock, SQS, or
dependency failures return HTTP 503 or remain available for queue redelivery.

Terminal `FAILED` is reserved for a valid command that was durably accepted as a
Wager Transaction and later encountered a classified permanent infrastructure
failure. It is never used for malformed envelopes, ordinary business rejection,
idempotency conflict, pending reference, or transient infrastructure failure.
Malformed SQS envelopes create no financial or business rows and remain on the
source queue for native DLQ redrive.

## Authentication and deterministic failure proof

`AUTHENTICATION_GUARD` is the stable dependency-injection replacement point for
future authentication. Its current implementation is an explicit no-op and
does not read or store credentials. Liveness, readiness, and metrics endpoints
remain public through that extension point.

Failpoint controls are constructed only when both the runtime environment is
`test` and failpoints are explicitly enabled. Armed failpoints are one-shot.
The internal `before_financial_commit` point proves that wallet, transaction,
ledger, accounting, Inbox, and Outbox writes roll back together. The required
post-commit and Outbox publication points use the same typed port and are
exercised by real-process recovery tests.

## Evaluator-grade verification and load evidence

The verification harness launches three independent Bun service processes
against the same PostgreSQL and LocalStack dependencies. Ports and process
identities are derived from an isolated run identity, startup waits are bounded
by real readiness probes, stdout and stderr diagnostics are captured safely, and
every exit path shuts down all children within a fixed deadline. Correctness
never depends on process-local state or on representing multiple instances
inside one runtime.

The seeded load generator produces a deterministic mix of hot-wallet
contention, independent-wallet control traffic, exact duplicates, and an
out-of-order reversal across HTTP and SQS. At least fifty parallel identical
deliveries preserve the same canonical business command. The reversal and its
later reference share the same provider, wallet, player, round, game, currency,
and amount context. Unique run prefixes prevent parallel executions from
colliding in business identities, transport identities, databases, queues, or
ports.

The load gate validates persisted outcomes rather than treating HTTP responses
as proof. It checks final and non-negative balances, transaction and reversal
uniqueness, ledger arithmetic, hash-chain integrity, balanced accounting,
Inbox uniqueness, Outbox publication, durable downstream duplicate safety, and
reconciliation across every scenario wallet. The Outbox poll interval is
reduced only inside the isolated load environment so strict per-wallet ordering
can drain a heavily contended aggregate within the bounded test deadline; the
ordering and lease rules are unchanged.

Caller-side latency samples contain successful and classified terminal
operations, while transient or unexpected failures are reported separately.
The formatter calculates p50, p95, and p99 deterministically, preserves the
seed, duration, counts, concurrency, process count, environment, lock evidence,
Outbox lag, and reconciliation result, and emits stable JSON and Markdown.
Machine-dependent timestamps are explicitly runtime metadata. Generated output
is placed under `artifacts/` and is not versioned.

`verify:reconciliation` resolves the existing `ReconcileWalletUseCase` through
the established transaction boundary. It checks all wallets by default or an
explicit configured scope, performs no repair, and exits non-zero for any
stored-balance, operational-ledger, accounting, or audit-chain divergence.

`docs/requirement-evidence.json` maps each FR-001 through FR-032 and SC-001
through SC-008 exactly once to executable tests, commands, implementation, and
documentation. Its validator rejects missing or duplicate requirements,
missing paths, unknown package commands, stale references, and prose-only
evidence.

`verify:challenge` is the evaluator boundary. It first probes a directly
reachable Docker daemon. Only on Windows, and only when that probe fails, it
tries Docker Engine through the named `Ubuntu` WSL 2 distribution. It never
starts Docker Desktop, selects another context, installs Docker, purges queues,
or removes volumes. Every command has a bounded timeout and its real exit status
is propagated. Once a required gate fails, remaining gates are explicitly
`skipped`, and because mandatory skips are failures, the aggregate result cannot
be greenwashed.

The verification runner writes JSON and Markdown summaries under
`artifacts/verification/<runId>/`. Summaries classify `passed`, `failed`,
`skipped`, and `not_applicable`; the completed challenge accepts only mandatory
`passed` results. Output contains gate names, durations, exit codes, Docker mode,
and explicit runtime timestamps, but never subprocess payloads, credentials,
connection strings, receipt handles, money, or raw queue messages.

The automated quickstart proof uses the same Docker selection, harness,
application boundaries, infrastructure, reconciliation, and evidence validator
as the evaluator-facing commands. There is no alternate toy path that could
pass while the documented workflow is broken.
