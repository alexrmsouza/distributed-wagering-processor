import { describe, expect, test } from 'bun:test';
import type { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import * as httpContracts from '../../../src/api-documentation/http-contract.schemas.js';
import { ApiDocumentationController } from '../../../src/api-documentation/api-documentation.controller.js';
import { HealthController } from '../../../src/health/presentation/health.controller.js';
import { MetricsController } from '../../../src/observability/presentation/metrics.controller.js';
import { WageringController } from '../../../src/wagering/presentation/wagering.controller.js';
import { WalletController } from '../../../src/wallet/presentation/wallet.controller.js';

const {
  createWalletRequestSchema,
  errorResponseSchema,
  ledgerPageResponseSchema,
  livenessResponseSchema,
  publicMoneySchema,
  readinessResponseSchema,
  reconciliationResponseSchema,
  wagerOutcomeResponseSchema,
  wagerRequestSchema,
  wagerTransactionResponseSchema,
  walletResponseSchema,
} = httpContracts;

interface OpenApiModule {
  readonly OPENAPI_DOCUMENT: {
    readonly openapi: string;
    readonly paths: Readonly<Record<string, unknown>>;
  };
  readonly OPENAPI_HTML: string;
  readonly OPENAPI_EXAMPLES: Readonly<Record<string, unknown>>;
  serializeOpenApiDocument(): string;
}

const MODULE_PATH = '../../../src/api-documentation/openapi.document.js';

async function loadOpenApiModule(): Promise<OpenApiModule | undefined> {
  try {
    return (await import(MODULE_PATH)) as OpenApiModule;
  } catch {
    return undefined;
  }
}

function controllerPaths(controller: abstract new (...arguments_: never[]) => unknown): string[] {
  const basePath = (Reflect.getMetadata(PATH_METADATA, controller) as string | undefined) ?? '';
  return Object.getOwnPropertyNames(controller.prototype).flatMap((methodName) => {
    if (methodName === 'constructor') {
      return [];
    }
    const handler = (controller.prototype as Record<string, unknown>)[methodName];
    if (typeof handler !== 'function') {
      return [];
    }
    const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
    const methodPath = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
    if (method === undefined || methodPath === undefined) {
      return [];
    }
    const path = `/${[basePath, methodPath].filter((part) => part.length > 0).join('/')}`
      .replaceAll(/\/+/g, '/')
      .replaceAll(/:([A-Za-z][A-Za-z0-9]*)/g, '{$1}');
    return [path.replace(/\/$/, '') || '/'];
  });
}

describe('deterministic OpenAPI document', () => {
  test('describes every public application route with stable OpenAPI 3.1 output', async () => {
    const module = await loadOpenApiModule();

    expect(module).toBeDefined();
    expect(module?.OPENAPI_DOCUMENT.openapi).toBe('3.1.0');
    expect(Object.keys(module?.OPENAPI_DOCUMENT.paths ?? {}).sort()).toEqual([
      '/docs',
      '/docs/openapi.json',
      '/health/live',
      '/health/ready',
      '/metrics',
      '/providers/{providerId}/wagering/transactions/{externalTransactionId}',
      '/wagering/transactions',
      '/wagering/transactions/{transactionId}',
      '/wallets',
      '/wallets/{walletId}',
      '/wallets/{walletId}/ledger',
      '/wallets/{walletId}/reconciliation',
    ]);

    const first = module?.serializeOpenApiDocument();
    const second = module?.serializeOpenApiDocument();
    expect(first).toBe(second);
    expect(first).not.toContain('generatedAt');
    expect(first?.endsWith('\n')).toBe(true);
  });

  test('keeps local documentation self-contained', async () => {
    const module = await loadOpenApiModule();

    expect(module).toBeDefined();
    expect(module?.OPENAPI_HTML).toContain('/docs/openapi.json');
    expect(module?.OPENAPI_HTML).not.toMatch(/https?:\/\//i);
  });

  test('matches the executable Nest controller paths', async () => {
    const module = await loadOpenApiModule();
    const executablePaths = [
      ApiDocumentationController,
      HealthController,
      MetricsController,
      WageringController,
      WalletController,
    ].flatMap(controllerPaths);

    expect([...new Set(executablePaths)].sort()).toEqual(
      Object.keys(module?.OPENAPI_DOCUMENT.paths ?? {}).sort(),
    );
  });

  test('validates every documented JSON example with the executable HTTP contract', async () => {
    const module = await loadOpenApiModule();
    const examples = module?.OPENAPI_EXAMPLES ?? {};

    createWalletRequestSchema.parse(examples.createWalletRequest);
    walletResponseSchema.parse(examples.walletResponse);
    ledgerPageResponseSchema.parse(examples.ledgerPageResponse);
    reconciliationResponseSchema.parse(examples.reconciliationResponse);
    wagerRequestSchema.parse(examples.wagerRequest);
    wagerOutcomeResponseSchema.parse(examples.wagerOutcomeResponse);
    wagerTransactionResponseSchema.parse(examples.wagerTransactionResponse);
    livenessResponseSchema.parse(examples.livenessResponse);
    readinessResponseSchema.parse(examples.readinessResponse);
    errorResponseSchema.parse(examples.errorResponse);
  });

  test('distinguishes non-negative Money from signed reconciliation differences', () => {
    expect(() => publicMoneySchema.parse({ amount: '-0.01', currency: 'BRL' })).toThrow();
    expect(httpContracts.signedMoneySchema.parse({ amount: '-0.01', currency: 'BRL' })).toEqual({
      amount: '-0.01',
      currency: 'BRL',
    });
  });

  test('keeps the versioned artifact synchronized with the executable document', async () => {
    const module = await loadOpenApiModule();
    const artifact = Bun.file('docs/openapi.json');

    expect(module).toBeDefined();
    expect(await artifact.exists()).toBe(true);
    expect((await artifact.text()).replaceAll('\r\n', '\n')).toBe(
      (module?.serializeOpenApiDocument() ?? '').replaceAll('\r\n', '\n'),
    );
  });
});
