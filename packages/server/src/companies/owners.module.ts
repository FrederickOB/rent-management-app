import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PolicyModule } from '../policy/policy.module';
import { OwnersService } from './owners.service';

/** Owners on their own, so the register (and the worker) need not load identity. */
@Module({
  imports: [AuditModule, PolicyModule],
  providers: [OwnersService],
  exports: [OwnersService],
})
export class OwnersModule {}
