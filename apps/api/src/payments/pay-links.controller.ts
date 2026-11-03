import { Controller, Inject, UseGuards } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@rent/contracts';
import { PayPageService, ReceiptsService } from '@rent/server/payments';
import { Public } from '../http/guards';
import { serialize } from '../http/serialize';
import { LinksKeyGuard } from '../links/links-key.guard';

/** The browser's address and device as apps/links reported them; never logged. */
const clientOf = (client: { ip: string; userAgent: string }) => ({
  ip: client.ip.trim().slice(0, 64) || 'unknown',
  userAgent: client.userAgent.trim().slice(0, 500) || 'unknown',
});

/**
 * The pay page's and the receipt page's API (BC-04, BC-06; M4b plan 4.3 and 4.6), called only by
 * apps/links with the links key. No session: the token authorises the page. Every call is
 * rate-limited in the services. Request bodies are never logged.
 */
@Public()
@UseGuards(LinksKeyGuard)
@Controller()
export class PayLinksController {
  constructor(
    @Inject(PayPageService) private readonly page: PayPageService,
    @Inject(ReceiptsService) private readonly receipts: ReceiptsService,
  ) {}

  @Implement(contract.payLinks)
  payLinksRouter() {
    return {
      open: implement(contract.payLinks.open).handler(async ({ input }) =>
        serialize(await this.page.open(input.token, clientOf(input.client))),
      ),
      start: implement(contract.payLinks.start).handler(async ({ input }) =>
        serialize(
          await this.page.start(input.token, clientOf(input.client), {
            amountMinor: input.amountMinor,
            method: input.method,
            momo: input.momo ?? null,
            submissionId: input.submissionId,
          }),
        ),
      ),
      status: implement(contract.payLinks.status).handler(async ({ input }) =>
        serialize(await this.page.status(input.token, clientOf(input.client), input.intentId)),
      ),
      returned: implement(contract.payLinks.returned).handler(async ({ input }) =>
        serialize(await this.page.returned(input.reference, clientOf(input.client))),
      ),
      invoiceDocument: implement(contract.payLinks.invoiceDocument).handler(async ({ input }) => ({
        url: await this.page.invoiceDocument(input.token, clientOf(input.client)),
      })),
    };
  }

  @Implement(contract.receiptLinks)
  receiptLinksRouter() {
    return {
      open: implement(contract.receiptLinks.open).handler(async ({ input }) =>
        serialize(await this.receipts.open(input.token, clientOf(input.client))),
      ),
      document: implement(contract.receiptLinks.document).handler(async ({ input }) => ({
        url: await this.receipts.documentUrl(input.token, clientOf(input.client)),
      })),
    };
  }
}
