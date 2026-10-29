import { Controller, Get, Inject } from '@nestjs/common';
import { OpenAPIGenerator } from '@orpc/openapi';
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4';
import { contract } from '@rent/contracts';
import { CONFIG, type AppConfig } from '@rent/server/core';
import { Public } from '../http/guards';

/** The API description generated from the shared contracts (ADR-014). Auth and webhooks are not in it. */
@Controller()
export class OpenApiController {
  private document: Promise<unknown> | null = null;

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  @Public()
  @Get('openapi.json')
  openapi() {
    this.document ??= new OpenAPIGenerator({
      schemaConverters: [new ZodToJsonSchemaConverter()],
    }).generate(contract, {
      info: { title: `${this.config.APP_NAME} API`, version: '0.1.0' },
      servers: [{ url: this.config.API_BASE_URL }],
    });
    return this.document;
  }
}
