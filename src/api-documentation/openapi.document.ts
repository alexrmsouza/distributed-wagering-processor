import { z, type ZodType } from 'zod';

import { canonicalJson } from '../shared/domain/canonical-json.js';
import { cloneAndFreezeCanonicalJson } from '../shared/domain/immutable-json.js';
import {
  createWalletRequestSchema,
  errorResponseSchema,
  ledgerPageResponseSchema,
  livenessResponseSchema,
  publicMoneySchema,
  readinessResponseSchema,
  reconciliationResponseSchema,
  signedMoneySchema,
  wagerOutcomeResponseSchema,
  wagerRequestSchema,
  wagerTransactionResponseSchema,
  walletResponseSchema,
} from './http-contract.schemas.js';

type JsonObject = Readonly<Record<string, unknown>>;

const UUID_EXAMPLE = '11111111-1111-4111-8111-111111111111';
const PLAYER_ID_EXAMPLE = '22222222-2222-4222-8222-222222222222';
const TRANSACTION_ID_EXAMPLE = '33333333-3333-4333-8333-333333333333';
const ENTRY_ID_EXAMPLE = '44444444-4444-4444-8444-444444444444';
const HASH_EXAMPLE = 'a'.repeat(64);

function schemaOf(schema: ZodType): JsonObject {
  return Object.fromEntries(
    Object.entries(z.toJSONSchema(schema)).filter(([key]) => key !== '$schema'),
  );
}

function reference(name: string): JsonObject {
  return { $ref: `#/components/schemas/${name}` };
}

function jsonContent(schemaName: string, example?: unknown): JsonObject {
  return {
    content: {
      'application/json': {
        schema: reference(schemaName),
        ...(example === undefined ? {} : { example }),
      },
    },
  };
}

function response(description: string, schemaName?: string, example?: unknown): JsonObject {
  return {
    description,
    ...(schemaName === undefined ? {} : jsonContent(schemaName, example)),
  };
}

function pathParameter(name: string, description: string): JsonObject {
  return {
    name,
    in: 'path',
    required: true,
    description,
    schema: name.toLowerCase().includes('id') ? { type: 'string' } : { type: 'string' },
  };
}

const MONEY_EXAMPLE = Object.freeze({ amount: '100.00', currency: 'BRL' });
const WALLET_EXAMPLE = Object.freeze({
  id: UUID_EXAMPLE,
  playerId: PLAYER_ID_EXAMPLE,
  balance: MONEY_EXAMPLE,
  version: 1,
});
const WAGER_OUTCOME_EXAMPLE = Object.freeze({
  transactionId: TRANSACTION_ID_EXAMPLE,
  status: 'PROCESSED',
  balance: Object.freeze({ amount: '80.00', currency: 'BRL' }),
  idempotentReplay: false,
});
const ERROR_EXAMPLE = Object.freeze({
  failureCode: 'INVALID_PAYLOAD',
  message: 'Request payload is invalid',
});

export const OPENAPI_EXAMPLES = cloneAndFreezeCanonicalJson({
  createWalletRequest: {
    playerId: PLAYER_ID_EXAMPLE,
    initialBalance: MONEY_EXAMPLE,
  },
  walletResponse: WALLET_EXAMPLE,
  ledgerPageResponse: {
    items: [
      {
        id: ENTRY_ID_EXAMPLE,
        walletId: UUID_EXAMPLE,
        transactionId: TRANSACTION_ID_EXAMPLE,
        entrySequence: 1,
        direction: 'CREDIT',
        amount: MONEY_EXAMPLE,
        balanceBefore: { amount: '0.00', currency: 'BRL' },
        balanceAfter: MONEY_EXAMPLE,
        previousEntryHash: null,
        entryHash: HASH_EXAMPLE,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    nextCursor: null,
  },
  reconciliationResponse: {
    walletId: UUID_EXAMPLE,
    storedBalance: MONEY_EXAMPLE,
    calculatedBalance: MONEY_EXAMPLE,
    accountingBalance: MONEY_EXAMPLE,
    difference: { amount: '0.00', currency: 'BRL' },
    consistent: true,
    checkedEntries: 1,
    accountingBalanced: true,
    auditChainValid: true,
  },
  wagerRequest: {
    providerId: 'provider-a',
    externalTransactionId: 'external-transaction-1',
    playerId: PLAYER_ID_EXAMPLE,
    walletId: UUID_EXAMPLE,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount: '20.00', currency: 'BRL' },
  },
  wagerOutcomeResponse: WAGER_OUTCOME_EXAMPLE,
  wagerTransactionResponse: {
    transactionId: TRANSACTION_ID_EXAMPLE,
    providerId: 'provider-a',
    externalTransactionId: 'external-transaction-1',
    idempotencyKey: 'idempotency-key-1',
    walletId: UUID_EXAMPLE,
    playerId: PLAYER_ID_EXAMPLE,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount: '20.00', currency: 'BRL' },
    referenceExternalTransactionId: null,
    referenceTransactionId: null,
    status: 'PROCESSED',
    failureCode: null,
    observedBalance: { amount: '80.00', currency: 'BRL' },
    processedAt: '2026-01-01T00:00:01.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  livenessResponse: { status: 'ok' },
  readinessResponse: {
    status: 'ready',
    checks: { database: { status: 'up' }, sqs: { status: 'up' } },
  },
  errorResponse: ERROR_EXAMPLE,
});

const errorResponses = Object.freeze({
  '400': response('Invalid request', 'ErrorResponse', ERROR_EXAMPLE),
  '503': response('Dependency temporarily unavailable', 'ErrorResponse'),
});

export const OPENAPI_DOCUMENT = cloneAndFreezeCanonicalJson({
  openapi: '3.1.0',
  info: {
    title: 'Distributed Wagering Processor API',
    version: '1.0.0',
    description: 'HTTP contract for wallet, wagering, reconciliation, and operational endpoints.',
  },
  tags: [
    { name: 'Wallets' },
    { name: 'Wagering' },
    { name: 'Operations' },
    { name: 'Documentation' },
  ],
  paths: {
    '/wallets': {
      post: {
        operationId: 'createWallet',
        tags: ['Wallets'],
        summary: 'Create a wallet and its opening financial records',
        parameters: [
          {
            name: 'x-correlation-id',
            in: 'header',
            required: false,
            schema: { type: 'string', maxLength: 255 },
          },
        ],
        requestBody: {
          required: true,
          ...jsonContent('CreateWalletRequest', OPENAPI_EXAMPLES.createWalletRequest),
        },
        responses: {
          '201': response('Wallet created', 'WalletResponse', OPENAPI_EXAMPLES.walletResponse),
          ...errorResponses,
          '409': response('Wallet already exists', 'ErrorResponse'),
        },
      },
    },
    '/wallets/{walletId}': {
      get: {
        operationId: 'getWallet',
        tags: ['Wallets'],
        summary: 'Get a wallet',
        parameters: [pathParameter('walletId', 'Wallet UUID')],
        responses: {
          '200': response('Wallet found', 'WalletResponse', OPENAPI_EXAMPLES.walletResponse),
          ...errorResponses,
          '404': response('Wallet not found', 'ErrorResponse'),
        },
      },
    },
    '/wallets/{walletId}/ledger': {
      get: {
        operationId: 'listWalletLedger',
        tags: ['Wallets'],
        summary: 'List immutable ledger entries using a stable opaque cursor',
        parameters: [
          pathParameter('walletId', 'Wallet UUID'),
          { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
          {
            name: 'limit',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          },
        ],
        responses: {
          '200': response('Ledger page', 'LedgerPageResponse', OPENAPI_EXAMPLES.ledgerPageResponse),
          ...errorResponses,
          '404': response('Wallet not found', 'ErrorResponse'),
        },
      },
    },
    '/wallets/{walletId}/reconciliation': {
      post: {
        operationId: 'reconcileWallet',
        tags: ['Wallets'],
        summary: 'Run a read-only full financial reconciliation',
        parameters: [pathParameter('walletId', 'Wallet UUID')],
        responses: {
          '200': response(
            'Reconciliation report',
            'ReconciliationResponse',
            OPENAPI_EXAMPLES.reconciliationResponse,
          ),
          ...errorResponses,
          '404': response('Wallet not found', 'ErrorResponse'),
        },
      },
    },
    '/wagering/transactions': {
      post: {
        operationId: 'processWagerTransaction',
        tags: ['Wagering'],
        summary: 'Process an idempotent wagering transaction',
        parameters: [
          {
            name: 'idempotency-key',
            in: 'header',
            required: true,
            schema: { type: 'string', minLength: 1, maxLength: 255 },
          },
          {
            name: 'x-correlation-id',
            in: 'header',
            required: false,
            schema: { type: 'string', minLength: 1, maxLength: 255 },
          },
        ],
        requestBody: {
          required: true,
          ...jsonContent('WagerRequest', OPENAPI_EXAMPLES.wagerRequest),
        },
        responses: {
          '201': response(
            'Transaction processed',
            'WagerOutcomeResponse',
            OPENAPI_EXAMPLES.wagerOutcomeResponse,
          ),
          '202': response('Pending reference accepted', 'WagerOutcomeResponse'),
          ...errorResponses,
          '409': response('Idempotency conflict', 'ErrorResponse'),
          '422': response('Business transaction rejected', 'WagerOutcomeResponse'),
        },
      },
    },
    '/wagering/transactions/{transactionId}': {
      get: {
        operationId: 'getWagerTransaction',
        tags: ['Wagering'],
        summary: 'Get a wagering transaction by internal identity',
        parameters: [pathParameter('transactionId', 'Transaction UUID')],
        responses: {
          '200': response(
            'Transaction found',
            'WagerTransactionResponse',
            OPENAPI_EXAMPLES.wagerTransactionResponse,
          ),
          ...errorResponses,
          '404': response('Transaction not found', 'ErrorResponse'),
        },
      },
    },
    '/providers/{providerId}/wagering/transactions/{externalTransactionId}': {
      get: {
        operationId: 'getProviderWagerTransaction',
        tags: ['Wagering'],
        summary: 'Get a wagering transaction by provider identity',
        parameters: [
          pathParameter('providerId', 'Provider identity'),
          pathParameter('externalTransactionId', 'External transaction identity'),
        ],
        responses: {
          '200': response(
            'Transaction found',
            'WagerTransactionResponse',
            OPENAPI_EXAMPLES.wagerTransactionResponse,
          ),
          ...errorResponses,
          '404': response('Transaction not found', 'ErrorResponse'),
        },
      },
    },
    '/health/live': {
      get: {
        operationId: 'getLiveness',
        tags: ['Operations'],
        summary: 'Check process liveness',
        responses: {
          '200': response('Process is live', 'LivenessResponse', OPENAPI_EXAMPLES.livenessResponse),
        },
      },
    },
    '/health/ready': {
      get: {
        operationId: 'getReadiness',
        tags: ['Operations'],
        summary: 'Check PostgreSQL and SQS readiness independently',
        responses: {
          '200': response(
            'Dependencies are ready',
            'ReadinessResponse',
            OPENAPI_EXAMPLES.readinessResponse,
          ),
          '503': response('At least one dependency is unavailable', 'ReadinessResponse'),
        },
      },
    },
    '/metrics': {
      get: {
        operationId: 'getPrometheusMetrics',
        tags: ['Operations'],
        summary: 'Get Prometheus text exposition',
        responses: {
          '200': {
            description: 'Prometheus metrics',
            content: {
              'text/plain': { schema: { type: 'string' } },
            },
          },
        },
      },
    },
    '/docs': {
      get: {
        operationId: 'getApiDocumentation',
        tags: ['Documentation'],
        summary: 'Get self-contained local API documentation',
        responses: {
          '200': {
            description: 'Local HTML documentation',
            content: { 'text/html': { schema: { type: 'string' } } },
          },
        },
      },
    },
    '/docs/openapi.json': {
      get: {
        operationId: 'getOpenApiDocument',
        tags: ['Documentation'],
        summary: 'Get the deterministic OpenAPI document',
        responses: {
          '200': {
            description: 'OpenAPI 3.1 document',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      PublicMoney: schemaOf(publicMoneySchema),
      SignedMoney: schemaOf(signedMoneySchema),
      CreateWalletRequest: schemaOf(createWalletRequestSchema),
      WalletResponse: schemaOf(walletResponseSchema),
      LedgerPageResponse: schemaOf(ledgerPageResponseSchema),
      ReconciliationResponse: schemaOf(reconciliationResponseSchema),
      WagerRequest: schemaOf(wagerRequestSchema),
      WagerOutcomeResponse: schemaOf(wagerOutcomeResponseSchema),
      WagerTransactionResponse: schemaOf(wagerTransactionResponseSchema),
      ErrorResponse: schemaOf(errorResponseSchema),
      LivenessResponse: schemaOf(livenessResponseSchema),
      ReadinessResponse: schemaOf(readinessResponseSchema),
    },
  },
});

export function serializeOpenApiDocument(): string {
  return `${JSON.stringify(JSON.parse(canonicalJson(OPENAPI_DOCUMENT)), null, 2)}\n`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderRouteRows(): string {
  const paths = OPENAPI_DOCUMENT.paths as Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
  return Object.entries(paths)
    .flatMap(([path, operations]) =>
      Object.entries(operations).map(([method, rawOperation]) => {
        const operation = rawOperation as { readonly summary?: string };
        return `<tr><td><code>${escapeHtml(method.toUpperCase())}</code></td><td><code>${escapeHtml(path)}</code></td><td>${escapeHtml(operation.summary ?? '')}</td></tr>`;
      }),
    )
    .join('');
}

export const OPENAPI_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Distributed Wagering Processor API</title>
  <style>body{font-family:system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#172033}a{color:#1457c8}table{width:100%;border-collapse:collapse;margin-top:1.5rem}th,td{padding:.75rem;text-align:left;border-bottom:1px solid #d8deea}code{background:#eef2f8;padding:.15rem .35rem;border-radius:.25rem}</style>
</head>
<body>
  <h1>Distributed Wagering Processor API</h1>
  <p>OpenAPI 3.1 contract: <a href="/docs/openapi.json">download the deterministic JSON document</a>.</p>
  <table><thead><tr><th>Method</th><th>Path</th><th>Summary</th></tr></thead><tbody>${renderRouteRows()}</tbody></table>
</body>
</html>`;
