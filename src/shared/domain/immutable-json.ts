import { canonicalJson } from './canonical-json.js';

type CanonicalJsonObject = Readonly<Record<string, unknown>>;

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return;
  }

  for (const nestedValue of Object.values(value)) {
    deepFreeze(nestedValue);
  }

  Object.freeze(value);
}

export function cloneAndFreezeCanonicalJson<TValue extends CanonicalJsonObject>(
  value: TValue,
): TValue {
  canonicalJson(value);

  const clone = structuredClone(value);
  deepFreeze(clone);

  return clone;
}
