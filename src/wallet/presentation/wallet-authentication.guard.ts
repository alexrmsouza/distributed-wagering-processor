import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';

import { AUTHENTICATION_GUARD } from '../../shared/infrastructure/no-op-auth.guard.js';

@Injectable()
export class WalletAuthenticationGuard implements CanActivate {
  public constructor(
    @Inject(AUTHENTICATION_GUARD) private readonly authenticationGuard: CanActivate,
  ) {}

  public canActivate(context: ExecutionContext) {
    return this.authenticationGuard.canActivate(context);
  }
}
