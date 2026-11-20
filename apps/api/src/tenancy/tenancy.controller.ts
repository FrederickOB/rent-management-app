import { Controller, Inject } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@rent/contracts';
import { TenantNoticesService } from '@rent/server/notices';
import { PLACEHOLDERS } from '@rent/domain/tenancy';
import { forbidden, notFound } from '@rent/server/core';
import { MoveInReportService } from '@rent/server/moveout';
import {
  IdChecksService,
  LeaseDocumentsService,
  LeaseLifecycleService,
  LeaseSigningService,
  LeasesService,
  LeaseTemplatesService,
  TenantAppService,
  TenantsService,
} from '@rent/server/tenancy';
import { toApproval } from '../governance/governance.controller';
import { Ctx, type RequestContext } from '../http/request-context';
import { serialize } from '../http/serialize';

const ok = { ok: true as const };

/** Tenants, lease templates and leases (M3 plan 4.15), with issuing for e-signature (TL-07). */
@Controller()
export class TenancyController {
  constructor(
    @Inject(TenantsService) private readonly tenants: TenantsService,
    @Inject(IdChecksService) private readonly idChecks: IdChecksService,
    @Inject(LeaseTemplatesService) private readonly templates: LeaseTemplatesService,
    @Inject(LeasesService) private readonly leases: LeasesService,
    @Inject(LeaseLifecycleService) private readonly lifecycle: LeaseLifecycleService,
    @Inject(LeaseDocumentsService) private readonly documents: LeaseDocumentsService,
    @Inject(LeaseSigningService) private readonly signing: LeaseSigningService,
  ) {}

  @Implement(contract.tenants)
  tenantsRouter(@Ctx() ctx: RequestContext) {
    return {
      list: implement(contract.tenants.list).handler(async ({ input }) =>
        serialize(await this.tenants.list(ctx.actor, input)),
      ),
      // M11 decision 6: the same service and filters as `list`, by POST, so a searched phone
      // number or name never sits in a URL.
      search: implement(contract.tenants.search).handler(async ({ input }) =>
        serialize(await this.tenants.list(ctx.actor, input)),
      ),
      get: implement(contract.tenants.get).handler(async ({ input }) =>
        serialize(await this.tenants.get(ctx.actor, input.tenantId)),
      ),
      timeline: implement(contract.tenants.timeline).handler(async ({ input }) =>
        serialize(await this.tenants.timeline(ctx.actor, input.tenantId)),
      ),
      create: implement(contract.tenants.create).handler(async ({ input }) =>
        serialize(await this.tenants.create(ctx.actor, input)),
      ),
      update: implement(contract.tenants.update).handler(async ({ input }) => {
        const { tenantId, ...patch } = input;
        return serialize(await this.tenants.update(ctx.actor, tenantId, patch));
      }),
      archive: implement(contract.tenants.archive).handler(async ({ input }) => {
        await this.tenants.archive(ctx.actor, input.tenantId);
        return ok;
      }),
      duplicates: implement(contract.tenants.duplicates).handler(({ input }) =>
        this.tenants.findDuplicates(ctx.actor, input),
      ),
      addContact: implement(contract.tenants.addContact).handler(async ({ input }) => {
        const { tenantId, ...contact } = input;
        return serialize(await this.tenants.addContact(ctx.actor, tenantId, contact));
      }),
      updateContact: implement(contract.tenants.updateContact).handler(async ({ input }) => {
        const { tenantId, contactId, ...patch } = input;
        return serialize(await this.tenants.updateContact(ctx.actor, tenantId, contactId, patch));
      }),
      archiveContact: implement(contract.tenants.archiveContact).handler(async ({ input }) => {
        await this.tenants.archiveContact(ctx.actor, input.tenantId, input.contactId);
        return ok;
      }),
      recordConsent: implement(contract.tenants.recordConsent).handler(({ input }) => {
        const { tenantId, ...consent } = input;
        return this.tenants.recordConsent(ctx.actor, tenantId, consent);
      }),
      startIdCheck: implement(contract.tenants.startIdCheck).handler(async ({ input }) =>
        serialize(await this.idChecks.start(ctx.actor, input.tenantId)),
      ),
      refreshIdCheck: implement(contract.tenants.refreshIdCheck).handler(async ({ input }) =>
        serialize(await this.idChecks.refresh(ctx.actor, input.tenantId)),
      ),
      revealIdNumber: implement(contract.tenants.revealIdNumber).handler(({ input }) =>
        this.tenants.revealIdNumber(ctx.actor, input.tenantId, input.reason),
      ),
      revealTin: implement(contract.tenants.revealTin).handler(({ input }) =>
        this.tenants.revealTin(ctx.actor, input.tenantId, input.reason),
      ),
    };
  }

  @Implement(contract.leaseTemplates)
  leaseTemplatesRouter(@Ctx() ctx: RequestContext) {
    return {
      list: implement(contract.leaseTemplates.list).handler(async ({ input }) =>
        serialize(await this.templates.list(ctx.actor, input)),
      ),
      get: implement(contract.leaseTemplates.get).handler(async ({ input }) =>
        serialize(await this.templates.get(ctx.actor, input.templateId)),
      ),
      placeholders: implement(contract.leaseTemplates.placeholders).handler(() =>
        Object.entries(PLACEHOLDERS).map(([name, description]) => ({ name, description })),
      ),
      create: implement(contract.leaseTemplates.create).handler(async ({ input }) =>
        serialize(await this.templates.create(ctx.actor, input)),
      ),
      publish: implement(contract.leaseTemplates.publish).handler(async ({ input }) => {
        const { templateId, ...version } = input;
        return serialize(await this.templates.publish(ctx.actor, templateId, version));
      }),
      review: implement(contract.leaseTemplates.review).handler(async ({ input }) =>
        serialize(await this.templates.review(ctx.actor, input.versionId, { note: input.note })),
      ),
    };
  }

  @Implement(contract.leases)
  leasesRouter(@Ctx() ctx: RequestContext) {
    const lease = async (id: string) => {
      const view = await this.leases.get(ctx.actor, id);
      // lease.manage implies lease.view_terms in the policy matrix (plan 4.14).
      if (view.access !== 'full') throw forbidden();
      return serialize(view);
    };
    return {
      list: implement(contract.leases.list).handler(async ({ input }) =>
        this.leases.list(ctx.actor, {
          ...input,
          status: input.status ? [input.status] : undefined,
        }),
      ),
      search: implement(contract.leases.search).handler(async ({ input }) =>
        this.leases.list(ctx.actor, {
          ...input,
          status: input.status ? [input.status] : undefined,
        }),
      ),
      expiring: implement(contract.leases.expiring).handler(({ input }) =>
        this.leases.expiring(ctx.actor, input.days),
      ),
      get: implement(contract.leases.get).handler(async ({ input }) =>
        serialize(await this.leases.get(ctx.actor, input.leaseId)),
      ),
      schedule: implement(contract.leases.schedule).handler(({ input }) =>
        this.leases.schedule(ctx.actor, input.leaseId),
      ),
      preview: implement(contract.leases.preview).handler(async ({ input }) => {
        const { html, warnings } = await this.documents.preview(ctx.actor, input.leaseId);
        return { html, warnings };
      }),
      create: implement(contract.leases.create).handler(async ({ input }) =>
        serialize(await this.leases.createDraft(ctx.actor, input)),
      ),
      update: implement(contract.leases.update).handler(async ({ input }) => {
        const { leaseId, ...patch } = input;
        return serialize(await this.leases.updateDraft(ctx.actor, leaseId, patch));
      }),
      cancel: implement(contract.leases.cancel).handler(async ({ input }) =>
        serialize(await this.leases.cancelDraft(ctx.actor, input.leaseId, input.reason)),
      ),
      createUpload: implement(contract.leases.createUpload).handler(async ({ input }) =>
        serialize(await this.leases.createUpload(ctx.actor, input)),
      ),
      recordPaper: implement(contract.leases.recordPaper).handler(async ({ input }) =>
        serialize(await this.leases.recordPaper(ctx.actor, input)),
      ),
      renewal: implement(contract.leases.renewal).handler(async ({ input }) =>
        serialize(await this.leases.offerRenewal(ctx.actor, input.leaseId)),
      ),
      ending: implement(contract.leases.ending).handler(async ({ input }) => {
        await this.lifecycle.recordEnding(ctx.actor, input.leaseId, input);
        return lease(input.leaseId);
      }),
      moveOut: implement(contract.leases.moveOut).handler(async ({ input }) => {
        await this.lifecycle.recordMoveOut(ctx.actor, input.leaseId, input);
        return lease(input.leaseId);
      }),
      rentControl: implement(contract.leases.rentControl).handler(async ({ input }) =>
        serialize(await this.leases.recordRentControl(ctx.actor, input.leaseId, input)),
      ),
      stamping: implement(contract.leases.stamping).handler(async ({ input }) =>
        serialize(await this.leases.recordStamping(ctx.actor, input.leaseId, input)),
      ),
      formalLease: implement(contract.leases.formalLease).handler(async ({ input }) => {
        const { leaseId, ...formal } = input;
        return serialize(await this.leases.recordFormalLease(ctx.actor, leaseId, formal));
      }),
      download: implement(contract.leases.download).handler(async ({ input }) => ({
        url: await this.leases.fileUrl(ctx.actor, input.leaseId, input.which),
      })),
      cancelSigned: implement(contract.leases.cancelSigned).handler(async ({ input }) =>
        toApproval(await this.leases.requestCancelSigned(ctx.actor, input.leaseId, input.reason)),
      ),
      issue: implement(contract.leases.issue).handler(async ({ input }) => {
        await this.signing.issue(ctx.actor, input.leaseId);
        return lease(input.leaseId);
      }),
      recall: implement(contract.leases.recall).handler(async ({ input }) => {
        await this.signing.recall(ctx.actor, input.leaseId, input.reason);
        return lease(input.leaseId);
      }),
      signing: implement(contract.leases.signing).handler(async ({ input }) => {
        const progress = await this.signing.progress(ctx.actor, input.leaseId);
        return progress ? serialize(progress) : null;
      }),
      signingDocument: implement(contract.leases.signingDocument).handler(async ({ input }) => ({
        url: await this.signing.documentUrl(ctx.actor, input.leaseId, input.which),
      })),
    };
  }
}

/** Signing requests (TL-07): the hand-over link for a signer with no consented channel (decision 2). */
@Controller()
export class SigningRequestsController {
  constructor(@Inject(LeaseSigningService) private readonly signing: LeaseSigningService) {}

  @Implement(contract.signingRequests)
  signingRequestsRouter(@Ctx() ctx: RequestContext) {
    return {
      handoverLink: implement(contract.signingRequests.handoverLink).handler(async ({ input }) =>
        serialize(
          await this.signing.handoverLink(ctx.actor, input.signingRequestId, input.signerId),
        ),
      ),
    };
  }
}

/** The tenant app's endpoints (TL-01, TL-07): the signed-in tenant's own tenancies, documents and signing. */
@Controller()
export class TenantAppController {
  constructor(
    @Inject(TenantAppService) private readonly app: TenantAppService,
    @Inject(TenantNoticesService) private readonly notices: TenantNoticesService,
    @Inject(MoveInReportService) private readonly reports: MoveInReportService,
  ) {}

  @Implement(contract.tenantApp)
  tenantAppRouter(@Ctx() ctx: RequestContext) {
    return {
      tenancies: implement(contract.tenantApp.tenancies).handler(async () =>
        serialize(await this.app.tenancies(ctx.actor)),
      ),
      tenancy: implement(contract.tenantApp.tenancy).handler(async ({ input }) =>
        serialize(await this.app.tenancy(ctx.actor, input.leaseId)),
      ),
      // M8 (plan 4.11): the signed lease, the move-in report and the final statement.
      documents: implement(contract.tenantApp.documents).handler(async ({ input }) => {
        const found = await this.app.forEachTenancy(ctx.actor, (_companyId, tx) =>
          this.reports.tenantTenancyDocuments(tx, input.leaseId),
        );
        if (!found) throw notFound('Tenancy');
        return serialize(found);
      }),
      documentDownload: implement(contract.tenantApp.documentDownload).handler(
        async ({ input }) => ({
          url: await this.app.documentUrl(ctx.actor, input.documentId),
        }),
      ),
      // M7 (plan 4.5): leases to sign and notices to acknowledge, in one To sign list.
      signing: implement(contract.tenantApp.signing).handler(async () => {
        const cards = await this.app.signing(ctx.actor);
        const notices = cards.some((c) => c.subject === 'notice')
          ? await this.notices.signingNotices(ctx.actor)
          : new Map();
        return serialize(
          cards.map((c) => ({ ...c, notice: notices.get(c.signingRequestId) ?? null })),
        );
      }),
      notices: implement(contract.tenantApp.notices).handler(async () =>
        serialize(await this.notices.notices(ctx.actor)),
      ),
      noticeDocument: implement(contract.tenantApp.noticeDocument).handler(async ({ input }) => ({
        url: await this.notices.documentUrl(ctx.actor, input.noticeId),
      })),
      signingLink: implement(contract.tenantApp.signingLink).handler(async ({ input }) =>
        serialize(await this.app.signingLink(ctx.actor, input.signerId)),
      ),
    };
  }
}
