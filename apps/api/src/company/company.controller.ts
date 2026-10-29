import { Controller, Inject } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@rent/contracts';
import {
  CompaniesService,
  MembershipsService,
  staffActor,
  type CompanyProfileView,
  type CompanyMember,
} from '@rent/server/companies';
import { DocumentsService, LOGO_UPLOAD } from '@rent/server/documents';
import { PolicyService } from '@rent/server/policy';
import { Ctx, type RequestContext } from '../http/request-context';

const toMembership = (m: CompanyMember) => ({
  ...m,
  scope: {
    owners: m.scope.owners ? [...m.scope.owners] : undefined,
    properties: m.scope.properties ? [...m.scope.properties] : undefined,
  },
  createdAt: m.createdAt.toISOString(),
});
const toProfile = (p: CompanyProfileView) => p;

@Controller()
export class CompanyController {
  constructor(
    @Inject(CompaniesService) private readonly companies: CompaniesService,
    @Inject(MembershipsService) private readonly memberships: MembershipsService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(PolicyService) private readonly policy: PolicyService,
  ) {}

  @Implement(contract.company)
  company(@Ctx() ctx: RequestContext) {
    return {
      get: implement(contract.company.get).handler(async () =>
        toProfile(await this.companies.profile(ctx.actor)),
      ),
      updateBranding: implement(contract.company.updateBranding).handler(async ({ input }) =>
        toProfile(await this.companies.updateBranding(ctx.actor, input)),
      ),
      updateSettings: implement(contract.company.updateSettings).handler(async ({ input }) =>
        toProfile(await this.companies.updateSettings(ctx.actor, input)),
      ),
      createLogoUpload: implement(contract.company.createLogoUpload).handler(async ({ input }) => {
        const staff = staffActor(ctx.actor);
        this.policy.assert(staff, 'company.update');
        const upload = await this.documents.createUpload(
          { companyId: staff.companyId, personId: staff.personId },
          LOGO_UPLOAD,
          input.contentType,
          input.sizeBytes,
        );
        return { ...upload, expiresAt: upload.expiresAt.toISOString() };
      }),
      confirmLogoUpload: implement(contract.company.confirmLogoUpload).handler(
        async ({ input }) => {
          const staff = staffActor(ctx.actor);
          this.policy.assert(staff, 'company.update');
          const documentId = await this.documents.acceptLogo(
            { companyId: staff.companyId, personId: staff.personId },
            input.uploadId,
          );
          return toProfile(await this.companies.setLogo(staff, documentId));
        },
      ),
    };
  }

  @Implement(contract.memberships)
  membershipsRouter(@Ctx() ctx: RequestContext) {
    return {
      list: implement(contract.memberships.list).handler(async () =>
        (await this.memberships.list(ctx.actor)).map(toMembership),
      ),
      invite: implement(contract.memberships.invite).handler(async ({ input }) =>
        toMembership(await this.memberships.invite(ctx.actor, input)),
      ),
      update: implement(contract.memberships.update).handler(async ({ input }) => {
        const { membershipId, ...patch } = input;
        return toMembership(await this.memberships.update(ctx.actor, membershipId, patch));
      }),
      revoke: implement(contract.memberships.revoke).handler(async ({ input }) =>
        toMembership(await this.memberships.revoke(ctx.actor, input.membershipId)),
      ),
    };
  }
}
