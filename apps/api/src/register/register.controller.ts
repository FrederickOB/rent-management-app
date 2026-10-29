import { Controller, Inject } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@rent/contracts';
import { XLSX_CONTENT_TYPE } from '@rent/domain/portfolio';
import { OwnersService, type OwnerView } from '@rent/server/companies';
import {
  MetersService,
  PropertyFilesService,
  RegisterImportService,
  RegisterReadService,
  RegisterService,
  type PropertyDetail,
  type PropertyFileView,
  type RegisterImportView,
  type UnitDetail,
} from '@rent/server/portfolio';
import { Ctx, type RequestContext } from '../http/request-context';

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const ok = { ok: true as const };

const toOwner = (o: OwnerView) => ({ ...o, createdAt: o.createdAt.toISOString() });
const toProperty = (p: PropertyDetail) => ({ ...p, createdAt: p.createdAt.toISOString() });
const toUnit = (u: UnitDetail) => ({
  ...u,
  history: u.history.map((h) => ({ ...h, occurredAt: h.occurredAt.toISOString() })),
});
const toFile = (f: PropertyFileView) => ({ ...f, createdAt: f.createdAt.toISOString() });
const toImport = (i: RegisterImportView) => ({
  ...i,
  createdAt: i.createdAt.toISOString(),
  validatedAt: iso(i.validatedAt),
  committedAt: iso(i.committedAt),
});
const toUpload = <T extends { expiresAt: Date }>(u: T) => ({
  ...u,
  expiresAt: u.expiresAt.toISOString(),
});

/** The property register (M2): owners, properties, units, meters, photos and papers, import. */
@Controller()
export class RegisterController {
  constructor(
    @Inject(OwnersService) private readonly owners: OwnersService,
    @Inject(RegisterService) private readonly register: RegisterService,
    @Inject(RegisterReadService) private readonly read: RegisterReadService,
    @Inject(MetersService) private readonly meters: MetersService,
    @Inject(PropertyFilesService) private readonly files: PropertyFilesService,
    @Inject(RegisterImportService) private readonly imports: RegisterImportService,
  ) {}

  @Implement(contract.owners)
  ownersRouter(@Ctx() ctx: RequestContext) {
    return {
      list: implement(contract.owners.list).handler(async ({ input }) =>
        (await this.owners.list(ctx.actor, input)).map(toOwner),
      ),
      get: implement(contract.owners.get).handler(async ({ input }) =>
        toOwner(await this.owners.get(ctx.actor, input.ownerId)),
      ),
      create: implement(contract.owners.create).handler(async ({ input }) =>
        toOwner(await this.owners.create(ctx.actor, input)),
      ),
      update: implement(contract.owners.update).handler(async ({ input }) => {
        const { ownerId, ...patch } = input;
        return toOwner(await this.owners.update(ctx.actor, ownerId, patch));
      }),
      archive: implement(contract.owners.archive).handler(async ({ input }) => {
        await this.register.archiveOwner(ctx.actor, input.ownerId);
        return ok;
      }),
    };
  }

  @Implement(contract.register)
  registerRouter(@Ctx() ctx: RequestContext) {
    const property = async (id: string) => toProperty(await this.read.getProperty(ctx.actor, id));
    const unit = async (id: string) => toUnit(await this.read.getUnit(ctx.actor, id));
    return {
      options: implement(contract.register.options).handler(() => this.register.options(ctx.actor)),
      createPortfolio: implement(contract.register.createPortfolio).handler(async ({ input }) => ({
        id: await this.register.createPortfolio(ctx.actor, input.name),
      })),
      renamePortfolio: implement(contract.register.renamePortfolio).handler(async ({ input }) => {
        await this.register.renamePortfolio(ctx.actor, input.portfolioId, input.name);
        return ok;
      }),
      listProperties: implement(contract.register.listProperties).handler(({ input }) =>
        this.read.listProperties(ctx.actor, input),
      ),
      getProperty: implement(contract.register.getProperty).handler(({ input }) =>
        property(input.propertyId),
      ),
      createProperty: implement(contract.register.createProperty).handler(async ({ input }) =>
        property(await this.register.createProperty(ctx.actor, input)),
      ),
      updateProperty: implement(contract.register.updateProperty).handler(async ({ input }) => {
        const { propertyId, ...patch } = input;
        await this.register.updateProperty(ctx.actor, propertyId, patch);
        return property(propertyId);
      }),
      archiveProperty: implement(contract.register.archiveProperty).handler(async ({ input }) => {
        await this.register.archiveProperty(ctx.actor, input.propertyId);
        return ok;
      }),
      changeOwner: implement(contract.register.changeOwner).handler(async ({ input }) => {
        await this.register.changeOwner(ctx.actor, input.propertyId, input);
        return property(input.propertyId);
      }),
      addBlock: implement(contract.register.addBlock).handler(async ({ input }) => {
        const { propertyId, ...block } = input;
        await this.register.addBlock(ctx.actor, propertyId, block);
        return property(propertyId);
      }),
      renameBlock: implement(contract.register.renameBlock).handler(async ({ input }) => {
        await this.register.renameBlock(ctx.actor, input.blockId, input.name ?? null);
        return ok;
      }),
      addUnits: implement(contract.register.addUnits).handler(async ({ input }) => ({
        unitIds: await this.register.addUnits(ctx.actor, input.blockId, input.batches),
      })),
      listUnits: implement(contract.register.listUnits).handler(({ input }) =>
        this.read.listUnits(ctx.actor, input),
      ),
      getUnit: implement(contract.register.getUnit).handler(({ input }) => unit(input.unitId)),
      updateUnit: implement(contract.register.updateUnit).handler(async ({ input }) => {
        const { unitId, ...patch } = input;
        await this.register.updateUnit(ctx.actor, unitId, patch);
        return unit(unitId);
      }),
      setAvailability: implement(contract.register.setAvailability).handler(async ({ input }) => {
        await this.register.setAvailability(ctx.actor, input.unitId, input);
        return unit(input.unitId);
      }),
      setBand: implement(contract.register.setBand).handler(async ({ input }) => {
        await this.register.setBand(ctx.actor, input.unitId, input);
        return unit(input.unitId);
      }),
      archiveUnit: implement(contract.register.archiveUnit).handler(async ({ input }) => {
        await this.register.archiveUnit(ctx.actor, input.unitId);
        return ok;
      }),
      addMeter: implement(contract.register.addMeter).handler(async ({ input }) => {
        const { propertyId, ...meter } = input;
        return { id: await this.meters.add(ctx.actor, propertyId, meter) };
      }),
      updateMeter: implement(contract.register.updateMeter).handler(async ({ input }) => {
        const { meterId, ...patch } = input;
        await this.meters.update(ctx.actor, meterId, patch);
        return ok;
      }),
      setMeterUnits: implement(contract.register.setMeterUnits).handler(async ({ input }) => {
        await this.meters.setUnits(ctx.actor, input.meterId, input.unitIds);
        return ok;
      }),
      archiveMeter: implement(contract.register.archiveMeter).handler(async ({ input }) => {
        await this.meters.archive(ctx.actor, input.meterId);
        return ok;
      }),
      lookupAddress: implement(contract.register.lookupAddress).handler(({ input }) =>
        this.register.lookupAddress(ctx.actor, input.code),
      ),
    };
  }

  @Implement(contract.propertyFiles)
  propertyFilesRouter(@Ctx() ctx: RequestContext) {
    return {
      createUpload: implement(contract.propertyFiles.createUpload).handler(async ({ input }) => {
        const { propertyId, ...upload } = input;
        return toUpload(await this.files.createUpload(ctx.actor, propertyId, upload));
      }),
      confirmUpload: implement(contract.propertyFiles.confirmUpload).handler(async ({ input }) => {
        const { propertyId, ...upload } = input;
        return toFile(await this.files.confirmUpload(ctx.actor, propertyId, upload));
      }),
      list: implement(contract.propertyFiles.list).handler(async ({ input }) =>
        (await this.files.list(ctx.actor, input.propertyId)).map(toFile),
      ),
      download: implement(contract.propertyFiles.download).handler(async ({ input }) => ({
        url: await this.files.downloadUrl(ctx.actor, input.fileId, input.variant),
      })),
      archive: implement(contract.propertyFiles.archive).handler(async ({ input }) => {
        await this.files.archive(ctx.actor, input.fileId);
        return ok;
      }),
    };
  }

  @Implement(contract.registerImports)
  registerImportsRouter(@Ctx() ctx: RequestContext) {
    return {
      template: implement(contract.registerImports.template).handler(async () => {
        const bytes = await this.imports.template(ctx.actor);
        return new File([new Uint8Array(bytes)], 'register-import-template.xlsx', {
          type: XLSX_CONTENT_TYPE,
        });
      }),
      createUpload: implement(contract.registerImports.createUpload).handler(async ({ input }) => {
        const { importId, upload } = await this.imports.createUpload(ctx.actor, input);
        return { importId, upload: toUpload(upload) };
      }),
      validate: implement(contract.registerImports.validate).handler(async ({ input }) =>
        toImport(await this.imports.startValidation(ctx.actor, input.importId)),
      ),
      get: implement(contract.registerImports.get).handler(async ({ input }) =>
        toImport(await this.imports.get(ctx.actor, input.importId)),
      ),
      commit: implement(contract.registerImports.commit).handler(async ({ input }) =>
        toImport(await this.imports.startCommit(ctx.actor, input.importId)),
      ),
    };
  }
}
