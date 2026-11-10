import { Controller, Inject } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@rent/contracts';
import { DocumentScansService } from '@rent/server/tenancy';
import { Ctx, type RequestContext } from '../http/request-context';
import { serialize } from '../http/serialize';

/**
 * An upload's malware scan status (M11 decision 6), for the person who uploaded it or anyone who
 * may see the document; the check is in the service. A tenant session works too (the tenant app
 * shows its own photos as "being checked").
 */
@Controller()
export class DocumentsController {
  constructor(@Inject(DocumentScansService) private readonly scans: DocumentScansService) {}

  @Implement(contract.documents)
  documentsRouter(@Ctx() ctx: RequestContext) {
    return {
      scanStatus: implement(contract.documents.scanStatus).handler(async ({ input }) =>
        serialize(await this.scans.status(ctx.actor, input.documentId)),
      ),
    };
  }
}
