import { describe, expect, test } from 'bun:test';

import {
  AUTHENTICATION_GUARD,
  NoOpAuthGuard,
} from '../../../../src/shared/infrastructure/no-op-auth.guard.js';

describe('NoOpAuthGuard', () => {
  test('allows requests without reading or storing credentials', () => {
    const guard = new NoOpAuthGuard();

    expect(guard.canActivate()).toBe(true);
  });

  test('exposes a stable dependency-injection replacement token', () => {
    expect(Symbol.keyFor(AUTHENTICATION_GUARD)).toBe('AUTHENTICATION_GUARD');
  });
});
