import { describe, expect, test } from 'bun:test';

import { CanonicalJsonError, canonicalJson } from '../../../../src/shared/domain/canonical-json.js';
import { hashPayload } from '../../../../src/shared/domain/payload-hash.js';

describe('canonicalJson', () => {
  test('sorts object keys recursively while preserving array order', () => {
    const payload = {
      z: { zebra: true, alpha: false },
      items: [
        { second: 2, first: 1 },
        { beta: 'b', alpha: 'a' },
      ],
      alpha: null,
    };

    expect(canonicalJson(payload)).toBe(
      '{"alpha":null,"items":[{"first":1,"second":2},{"alpha":"a","beta":"b"}],"z":{"alpha":false,"zebra":true}}',
    );
  });

  test('uses JSON escaping for strings and object keys', () => {
    expect(canonicalJson({ 'quoted"key': 'line\nvalue' })).toBe('{"quoted\\"key":"line\\nvalue"}');
  });

  test('sorts keys by locale-independent UTF-16 code units', () => {
    expect(canonicalJson({ a: 1, Z: 2 })).toBe('{"Z":2,"a":1}');
  });

  test.each([
    ['undefined', undefined],
    ['bigint', 1n],
    ['symbol', Symbol('unsupported')],
    ['function', () => undefined],
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
    ['negative zero', -0],
    ['date', new Date('2026-09-04T00:00:00.000Z')],
  ])('rejects unsupported %s values explicitly', (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(CanonicalJsonError);
  });

  test('rejects sparse arrays instead of treating holes as null', () => {
    const sparse: unknown[] = [];
    sparse.length = 3;
    sparse[0] = 1;
    sparse[2] = 3;

    expect(() => canonicalJson(sparse)).toThrow('Sparse arrays are not canonical JSON');
  });

  test('rejects extra array properties instead of silently dropping them', () => {
    const payload = [1];
    Object.defineProperty(payload, 'metadata', { enumerable: true, value: 'hidden' });

    expect(() => canonicalJson(payload)).toThrow('Extra array properties are not canonical JSON');
  });

  test('rejects accessor array elements instead of invoking them', () => {
    const payload = [1];
    Object.defineProperty(payload, '0', { enumerable: true, get: () => 1 });

    expect(() => canonicalJson(payload)).toThrow('Accessor properties are not canonical JSON');
  });

  test('rejects symbol keys instead of silently dropping them', () => {
    const symbolKey = Symbol('metadata');
    const payload = { business: true, [symbolKey]: 'hidden' };

    expect(() => canonicalJson(payload)).toThrow('Symbol keys are not canonical JSON');
  });

  test('rejects accessor properties instead of invoking them', () => {
    const payload = Object.defineProperty({}, 'business', {
      enumerable: true,
      get: () => true,
    });

    expect(() => canonicalJson(payload)).toThrow('Accessor properties are not canonical JSON');
  });

  test('rejects circular references explicitly', () => {
    const payload: Record<string, unknown> = {};
    payload.self = payload;

    expect(() => canonicalJson(payload)).toThrow('Circular references are not canonical JSON');
  });
});

describe('hashPayload', () => {
  test('returns the known lowercase SHA-256 digest of canonical JSON', () => {
    expect(hashPayload({ b: 2, a: 1 })).toBe(
      '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777',
    );
  });

  test('produces the same hash for recursively reordered object keys', () => {
    const first = { operation: 'BET', money: { currency: 'BRL', amount: '25.00' } };
    const second = { money: { amount: '25.00', currency: 'BRL' }, operation: 'BET' };

    expect(hashPayload(first)).toBe(hashPayload(second));
  });

  test('preserves array order when deriving a hash', () => {
    expect(hashPayload({ values: [1, 2] })).not.toBe(hashPayload({ values: [2, 1] }));
  });

  test('hashes only the caller-supplied business payload', () => {
    const firstRequest = {
      businessPayload: { providerId: 'provider-a', transactionId: 'transaction-1' },
      transportMetadata: { receiptHandle: 'first-receipt' },
    };
    const retriedRequest = {
      businessPayload: { transactionId: 'transaction-1', providerId: 'provider-a' },
      transportMetadata: { receiptHandle: 'second-receipt' },
    };

    expect(hashPayload(firstRequest.businessPayload)).toBe(
      hashPayload(retriedRequest.businessPayload),
    );
  });
});
