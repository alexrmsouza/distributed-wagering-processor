export abstract class DomainError<Code extends string = string> extends Error {
  public readonly code: Code;

  protected constructor(code: Code, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}
