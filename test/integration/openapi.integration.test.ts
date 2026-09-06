import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { ApiDocumentationModule } from '../../src/api-documentation/api-documentation.module.js';
import { OPENAPI_DOCUMENT } from '../../src/api-documentation/openapi.document.js';

@Module({ imports: [ApiDocumentationModule] })
class OpenApiTestModule {
  public readonly role = 'openapi-test';
}

let application: INestApplication | undefined;
let baseUrl: string;
const OPENAPI_TEST_TIMEOUT_MS = 10_000;

beforeAll(async () => {
  application = await NestFactory.create(OpenApiTestModule, { logger: false });
  await application.listen(0, '127.0.0.1');
  baseUrl = await application.getUrl();
}, OPENAPI_TEST_TIMEOUT_MS);

afterAll(async () => {
  await application?.close();
}, OPENAPI_TEST_TIMEOUT_MS);

describe('local API documentation', () => {
  test('serves the executable OpenAPI document as JSON', async () => {
    const response = await fetch(`${baseUrl}/docs/openapi.json`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual(OPENAPI_DOCUMENT);
  });

  test('serves a self-contained local reference with restrictive browser policy', async () => {
    const response = await fetch(`${baseUrl}/docs`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(html).toContain('/docs/openapi.json');
    expect(html).not.toMatch(/https?:\/\//i);
  });
});
