import { Module } from '@nestjs/common';
import { PolicyModule } from '../policy/policy.module';
import { TasksService } from './tasks.service';

/** Staff tasks (CF-06; M7 plan 4.1, layer 2). Notices create them; M8 and the field app will too. */
@Module({
  imports: [PolicyModule],
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}
