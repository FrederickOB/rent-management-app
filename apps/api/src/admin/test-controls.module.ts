import { Module } from '@nestjs/common';
import { PolicyModule } from '@rent/server/policy';
import { SubscriptionModule } from '@rent/server/subscription';
import { TestControlsController } from './test-controls.controller';

/**
 * The e2e test controls (M10). AppModule imports this module only when `testControlsEnabled`
 * (E2E_TEST_CONTROLS=on, and never in production), so without it the routes do not exist (404).
 */
@Module({
  imports: [PolicyModule, SubscriptionModule],
  controllers: [TestControlsController],
})
export class TestControlsModule {}
