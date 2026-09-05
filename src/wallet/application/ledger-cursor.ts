import { Buffer } from 'node:buffer';

import { z } from 'zod';

import type { LedgerCursorPosition } from './ports/wallet.repository.js';
import { InvalidLedgerCursorError } from './wallet-errors.js';

const cursorSchema = z.object({
  version: z.literal(1),
  createdAt: z.iso.datetime({ offset: true }),
  id: z.uuid(),
});

export const LedgerCursor = {
  encode(position: LedgerCursorPosition): string {
    return Buffer.from(
      JSON.stringify({
        version: 1,
        createdAt: position.createdAt.toISOString(),
        id: position.id,
      }),
      'utf8',
    ).toString('base64url');
  },

  decode(cursor: string): LedgerCursorPosition {
    try {
      const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
      const parsed = cursorSchema.parse(JSON.parse(decoded) as unknown);

      return Object.freeze({
        createdAt: new Date(parsed.createdAt),
        id: parsed.id,
      });
    } catch {
      throw new InvalidLedgerCursorError();
    }
  },
};
