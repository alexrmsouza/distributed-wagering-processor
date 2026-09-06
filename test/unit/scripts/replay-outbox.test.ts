import { describe, expect, test } from 'bun:test';

import { parseOutboxReplayArguments } from '../../../scripts/replay-outbox.js';

describe('Outbox replay command', () => {
  test('accepts one explicit blocked message and normalized operator identity', () => {
    expect(
      parseOutboxReplayArguments([
        '--outbox-id=7db909aa-31e4-4f34-b9cb-bd789848871c',
        '--operator=ops.on-call',
      ]),
    ).toEqual({
      outboxId: '7db909aa-31e4-4f34-b9cb-bd789848871c',
      operatorId: 'ops.on-call',
    });
  });

  test('rejects ambiguous, malformed, or unsafe arguments', () => {
    expect(() => parseOutboxReplayArguments([])).toThrow();
    expect(() =>
      parseOutboxReplayArguments([
        '--outbox-id=7db909aa-31e4-4f34-b9cb-bd789848871c',
        '--operator=contains spaces',
      ]),
    ).toThrow();
    expect(() =>
      parseOutboxReplayArguments([
        '--outbox-id=7db909aa-31e4-4f34-b9cb-bd789848871c',
        '--outbox-id=7db909aa-31e4-4f34-b9cb-bd789848871c',
        '--operator=ops',
      ]),
    ).toThrow();
  });
});
