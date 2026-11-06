import { Controller, Inject } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@rent/contracts';
import { IdempotencyStore } from '@rent/server/core';
import { OwnerStatementsService } from '@rent/server/reporting';
import { idempotent } from '../http/idempotency';
import { Ctx, type RequestContext } from '../http/request-context';
import { serialize } from '../http/serialize';

/**
 * Owner statements (M9: AC-04; decisions 5 to 7 and 15): list, read, draft, issue and the PDF.
 * Every check is in the service, through PolicyService; Growth only. Issuing is idempotent by
 * state (a second issue is 409 STATEMENT_ISSUED) and accepts an optional Idempotency-Key, so a
 * retry after a lost answer gets the issued statement back.
 */
@Controller()
export class OwnerStatementsController {
  constructor(
    @Inject(OwnerStatementsService) private readonly statements: OwnerStatementsService,
    @Inject(IdempotencyStore) private readonly idempotency: IdempotencyStore,
  ) {}

  @Implement(contract.ownerStatements)
  ownerStatementsRouter(@Ctx() ctx: RequestContext) {
    const st = this.statements;
    const a = ctx.actor;
    return {
      list: implement(contract.ownerStatements.list).handler(async ({ input }) =>
        serialize(await st.list(a, input)),
      ),
      get: implement(contract.ownerStatements.get).handler(async ({ input }) =>
        serialize(await st.get(a, input.statementId)),
      ),
      draft: implement(contract.ownerStatements.draft).handler(async ({ input }) =>
        serialize(await st.draft(a, input)),
      ),
      issue: implement(contract.ownerStatements.issue).handler(({ input }) =>
        idempotent(
          this.idempotency,
          ctx,
          'reporting.owner_statement_issue',
          input,
          async (claim) => {
            await st.issue(a, input.statementId, { claim });
            return { statementId: input.statementId };
          },
          async ({ statementId }) => serialize(await st.get(a, statementId)),
          { required: false },
        ),
      ),
      document: implement(contract.ownerStatements.document).handler(async ({ input }) =>
        serialize(await st.document(a, input.statementId)),
      ),
    };
  }
}
