import { Controller, Inject, UseGuards } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@rent/contracts';
import { SigningPageService, type ClientInfo } from '@rent/server/esign';
import { Public } from '../http/guards';
import { serialize } from '../http/serialize';
import { LinksKeyGuard } from './links-key.guard';

/** The browser's address and device as apps/links reported them; evidence, never logged. */
const clientOf = (client: { ip: string; userAgent: string }): ClientInfo => ({
  ip: client.ip.trim().slice(0, 64) || 'unknown',
  userAgent: client.userAgent.trim().slice(0, 500) || 'unknown',
});

/**
 * The links API (TL-07; M3 plan 4.15): open a link, download its document, send a code, sign
 * and decline. No session: the token authorises the page and the links key authorises the
 * caller. Every call is rate-limited in SigningPageService. Request bodies are never logged.
 */
@Public()
@UseGuards(LinksKeyGuard)
@Controller()
export class LinksController {
  constructor(@Inject(SigningPageService) private readonly page: SigningPageService) {}

  @Implement(contract.links)
  linksRouter() {
    return {
      open: implement(contract.links.open).handler(async ({ input }) =>
        serialize(await this.page.open(input.token, clientOf(input.client))),
      ),
      document: implement(contract.links.document).handler(async ({ input }) => ({
        url: await this.page.documentUrl(input.token, clientOf(input.client)),
      })),
      sendCode: implement(contract.links.sendCode).handler(async ({ input }) =>
        serialize(await this.page.sendCode(input.token, clientOf(input.client))),
      ),
      sign: implement(contract.links.sign).handler(async ({ input }) =>
        serialize(
          await this.page.sign(input.token, clientOf(input.client), {
            code: input.code,
            method: input.method,
            typedName: input.typedName ?? null,
            drawing: input.drawing ?? null,
            consentVersion: input.consentVersion,
            consentAccepted: input.consentAccepted,
          }),
        ),
      ),
      decline: implement(contract.links.decline).handler(async ({ input }) =>
        serialize(await this.page.decline(input.token, clientOf(input.client), input.reason)),
      ),
    };
  }
}
