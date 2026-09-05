import { Injectable, type CanActivate } from '@nestjs/common';

export const AUTHENTICATION_GUARD = Symbol.for('AUTHENTICATION_GUARD');

@Injectable()
export class NoOpAuthGuard implements CanActivate {
  public canActivate(): true {
    return true;
  }
}
