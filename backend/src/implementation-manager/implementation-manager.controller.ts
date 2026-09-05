import { Controller, Get, UseGuards } from '@nestjs/common';
import { ImplementationManagerService } from './implementation-manager.service';
import { AuthGuard } from '../auth/auth.guard';

/** Cabinet-facing — "Статус внедрения"'s own manager card reads real name/photo from here instead of the old hardcoded demo. */
@Controller('api/cabinet/manager')
@UseGuards(AuthGuard)
export class ImplementationManagerController {
  constructor(private readonly manager: ImplementationManagerService) {}

  @Get()
  get() {
    return this.manager.getPublic();
  }
}
