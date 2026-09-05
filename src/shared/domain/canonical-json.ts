export class CanonicalJsonError extends TypeError {
  public constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

function serializePrimitive(value: string | number | boolean | null): string {
  return JSON.stringify(value);
}

function serializeArray(value: unknown[], ancestors: WeakSet<object>): string {
  if (ancestors.has(value)) {
    throw new CanonicalJsonError('Circular references are not canonical JSON');
  }

  const elements: (readonly [number, unknown])[] = [];

  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') {
      continue;
    }

    const index = typeof key === 'string' ? Number(key) : Number.NaN;

    if (!Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
      throw new CanonicalJsonError('Extra array properties are not canonical JSON');
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    if (descriptor === undefined) {
      throw new CanonicalJsonError('Array property descriptor is unavailable');
    }

    if ('get' in descriptor || 'set' in descriptor) {
      throw new CanonicalJsonError('Accessor properties are not canonical JSON');
    }

    if (!descriptor.enumerable) {
      throw new CanonicalJsonError('Non-enumerable properties are not canonical JSON');
    }

    elements.push([index, descriptor.value]);
  }

  if (elements.length !== value.length) {
    throw new CanonicalJsonError('Sparse arrays are not canonical JSON');
  }

  elements.sort(([left], [right]) => left - right);
  ancestors.add(value);

  try {
    return `[${elements.map(([, element]) => serialize(element, ancestors)).join(',')}]`;
  } finally {
    ancestors.delete(value);
  }
}

function serializeObject(value: object, ancestors: WeakSet<object>): string {
  const prototype: unknown = Object.getPrototypeOf(value);

  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalJsonError('Only plain objects are canonical JSON');
  }

  if (ancestors.has(value)) {
    throw new CanonicalJsonError('Circular references are not canonical JSON');
  }

  const ownKeys = Reflect.ownKeys(value);

  if (ownKeys.some((key) => typeof key === 'symbol')) {
    throw new CanonicalJsonError('Symbol keys are not canonical JSON');
  }

  const stringKeys = ownKeys.filter((key): key is string => typeof key === 'string');

  ancestors.add(value);

  try {
    const properties = stringKeys
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);

        if (descriptor === undefined) {
          throw new CanonicalJsonError('Object property descriptor is unavailable');
        }

        if ('get' in descriptor || 'set' in descriptor) {
          throw new CanonicalJsonError('Accessor properties are not canonical JSON');
        }

        if (!descriptor.enumerable) {
          throw new CanonicalJsonError('Non-enumerable properties are not canonical JSON');
        }

        return [key, descriptor.value] as const;
      })
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

    return `{${properties
      .map(
        ([key, propertyValue]) =>
          `${serializePrimitive(key)}:${serialize(propertyValue, ancestors)}`,
      )
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function serialize(value: unknown, ancestors: WeakSet<object>): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return serializePrimitive(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CanonicalJsonError('Non-finite numbers are not canonical JSON');
    }

    if (Object.is(value, -0)) {
      throw new CanonicalJsonError('Negative zero is not canonical JSON');
    }

    return serializePrimitive(value);
  }

  if (Array.isArray(value)) {
    return serializeArray(value, ancestors);
  }

  if (typeof value === 'object') {
    return serializeObject(value, ancestors);
  }

  throw new CanonicalJsonError(`Unsupported canonical JSON value: ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return serialize(value, new WeakSet());
}
