import { createHash } from 'node:crypto';

import { canonicalJson } from './canonical-json.js';

export function hashPayload(businessPayload: unknown): string {
  return createHash('sha256').update(canonicalJson(businessPayload), 'utf8').digest('hex');
}
