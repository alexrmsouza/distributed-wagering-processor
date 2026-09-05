import { DomainError } from './domain-error.js';

class InvalidEntityIdError extends DomainError<'INVALID_PAYLOAD'> {
  public constructor() {
    super('INVALID_PAYLOAD', 'Entity identifier must be a non-empty normalized string');
  }
}

export abstract class Entity<Id extends string = string> {
  protected constructor(private readonly entityId: Id) {
    if (typeof entityId !== 'string' || entityId.length === 0 || entityId.trim() !== entityId) {
      throw new InvalidEntityIdError();
    }
  }

  public get id(): Id {
    return this.entityId;
  }

  public hasSameIdentityAs(other: Entity<Id>): boolean {
    return this.constructor === other.constructor && this.entityId === other.entityId;
  }
}
