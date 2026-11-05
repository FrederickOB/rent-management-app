import { Controller, Inject, UseGuards } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@rent/contracts';
import { EntitlementsService } from '@rent/server/companies';
import {
  BroadcastsService,
  InboxService,
  MessagingConsentService,
  MessagingSettingsService,
  TemplatesService,
  TenantMessagingService,
} from '@rent/server/messaging';
import { LinksKeyGuard } from '../links/links-key.guard';
import { Public } from '../http/guards';
import { Ctx, type RequestContext } from '../http/request-context';
import { serialize } from '../http/serialize';

/** The unified inbox (CM-05, CM-06; plan 4.6). */
@Controller()
export class InboxController {
  constructor(@Inject(InboxService) private readonly inbox: InboxService) {}

  @Implement(contract.inbox)
  inboxRouter(@Ctx() ctx: RequestContext) {
    return {
      conversations: implement(contract.inbox.conversations).handler(async ({ input }) =>
        serialize(await this.inbox.conversations(ctx.actor, input)),
      ),
      counts: implement(contract.inbox.counts).handler(async () => this.inbox.counts(ctx.actor)),
      conversation: implement(contract.inbox.conversation).handler(async ({ input }) =>
        serialize(await this.inbox.conversation(ctx.actor, input.conversationId)),
      ),
      messages: implement(contract.inbox.messages).handler(async ({ input }) => {
        const { conversationId, ...filter } = input;
        return serialize(await this.inbox.messages(ctx.actor, conversationId, filter));
      }),
      reply: implement(contract.inbox.reply).handler(async ({ input }) => {
        const { conversationId, ...reply } = input;
        return serialize(await this.inbox.reply(ctx.actor, conversationId, reply));
      }),
      assignees: implement(contract.inbox.assignees).handler(async ({ input }) =>
        this.inbox.assignees(ctx.actor, input.conversationId),
      ),
      assign: implement(contract.inbox.assign).handler(async ({ input }) =>
        serialize(await this.inbox.assign(ctx.actor, input.conversationId, input.personId)),
      ),
      setTags: implement(contract.inbox.setTags).handler(async ({ input }) =>
        serialize(await this.inbox.setTags(ctx.actor, input.conversationId, input.tags)),
      ),
      resolve: implement(contract.inbox.resolve).handler(async ({ input }) =>
        serialize(await this.inbox.resolve(ctx.actor, input.conversationId)),
      ),
      reopen: implement(contract.inbox.reopen).handler(async ({ input }) =>
        serialize(await this.inbox.reopen(ctx.actor, input.conversationId)),
      ),
      linkTriage: implement(contract.inbox.linkTriage).handler(async ({ input }) =>
        serialize(
          await this.inbox.linkTriage(
            ctx.actor,
            input.conversationId,
            input.tenantId,
            input.contactId ?? null,
          ),
        ),
      ),
      attachmentDownload: implement(contract.inbox.attachmentDownload).handler(async ({ input }) =>
        serialize(
          await this.inbox.attachmentDownload(ctx.actor, input.conversationId, input.attachmentId),
        ),
      ),
      tenantConversation: implement(contract.inbox.tenantConversation).handler(async ({ input }) =>
        serialize(await this.inbox.tenantConversation(ctx.actor, input.tenantId)),
      ),
      startConversation: implement(contract.inbox.startConversation).handler(async ({ input }) =>
        serialize(await this.inbox.startConversation(ctx.actor, input.tenantId)),
      ),
      unitConversations: implement(contract.inbox.unitConversations).handler(async ({ input }) =>
        serialize(await this.inbox.unitConversations(ctx.actor, input.unitId)),
      ),
    };
  }
}

/** Consent on every channel (CM-09; plan 4.8). */
@Controller()
export class MessagingConsentController {
  constructor(@Inject(MessagingConsentService) private readonly consent: MessagingConsentService) {}

  @Implement(contract.messagingConsent)
  consentRouter(@Ctx() ctx: RequestContext) {
    return {
      get: implement(contract.messagingConsent.get).handler(async ({ input }) =>
        serialize(await this.consent.get(ctx.actor, input.tenantId)),
      ),
      record: implement(contract.messagingConsent.record).handler(async ({ input }) => {
        const { tenantId, ...change } = input;
        return serialize(await this.consent.record(ctx.actor, tenantId, change));
      }),
    };
  }
}

/** Broadcasts and tenant groups (CM-08; plan 4.7). */
@Controller()
export class BroadcastsController {
  constructor(@Inject(BroadcastsService) private readonly broadcasts: BroadcastsService) {}

  @Implement(contract.broadcasts)
  broadcastsRouter(@Ctx() ctx: RequestContext) {
    return {
      preview: implement(contract.broadcasts.preview).handler(async ({ input }) =>
        this.broadcasts.preview(ctx.actor, input),
      ),
      create: implement(contract.broadcasts.create).handler(async ({ input }) =>
        serialize(await this.broadcasts.create(ctx.actor, input)),
      ),
      list: implement(contract.broadcasts.list).handler(async ({ input }) =>
        serialize(await this.broadcasts.list(ctx.actor, input)),
      ),
      get: implement(contract.broadcasts.get).handler(async ({ input }) =>
        serialize(await this.broadcasts.get(ctx.actor, input.broadcastId)),
      ),
    };
  }

  @Implement(contract.tenantGroups)
  tenantGroupsRouter(@Ctx() ctx: RequestContext) {
    return {
      list: implement(contract.tenantGroups.list).handler(async ({ input }) =>
        serialize(await this.broadcasts.groups(ctx.actor, input)),
      ),
      get: implement(contract.tenantGroups.get).handler(async ({ input }) =>
        serialize(await this.broadcasts.group(ctx.actor, input.groupId)),
      ),
      create: implement(contract.tenantGroups.create).handler(async ({ input }) =>
        serialize(await this.broadcasts.createGroup(ctx.actor, input)),
      ),
      update: implement(contract.tenantGroups.update).handler(async ({ input }) => {
        const { groupId, ...patch } = input;
        return serialize(await this.broadcasts.updateGroup(ctx.actor, groupId, patch));
      }),
      archive: implement(contract.tenantGroups.archive).handler(async ({ input }) =>
        serialize(await this.broadcasts.archiveGroup(ctx.actor, input.groupId)),
      ),
      members: implement(contract.tenantGroups.members).handler(async ({ input }) =>
        serialize(await this.broadcasts.members(ctx.actor, input.groupId)),
      ),
      addMembers: implement(contract.tenantGroups.addMembers).handler(async ({ input }) =>
        serialize(await this.broadcasts.addMembers(ctx.actor, input.groupId, input.tenantIds)),
      ),
      removeMembers: implement(contract.tenantGroups.removeMembers).handler(async ({ input }) =>
        serialize(await this.broadcasts.removeMembers(ctx.actor, input.groupId, input.tenantIds)),
      ),
    };
  }
}

/** Templates (CM-07), messaging settings, and the platform admin's numbers and plans. */
@Controller()
export class MessagingSettingsController {
  constructor(
    @Inject(TemplatesService) private readonly templates: TemplatesService,
    @Inject(MessagingSettingsService) private readonly settings: MessagingSettingsService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
  ) {}

  @Implement(contract.templates)
  templatesRouter(@Ctx() ctx: RequestContext) {
    return {
      list: implement(contract.templates.list).handler(async () =>
        serialize(await this.templates.list(ctx.actor)),
      ),
    };
  }

  @Implement(contract.messagingSettings)
  settingsRouter(@Ctx() ctx: RequestContext) {
    return {
      get: implement(contract.messagingSettings.get).handler(async () =>
        this.settings.get(ctx.actor),
      ),
      update: implement(contract.messagingSettings.update).handler(async ({ input }) =>
        this.settings.update(ctx.actor, input),
      ),
    };
  }

  @Implement(contract.platformMessaging)
  platformRouter(@Ctx() ctx: RequestContext) {
    return {
      whatsappNumbers: implement(contract.platformMessaging.whatsappNumbers).handler(async () =>
        serialize(await this.settings.numbers(ctx.actor)),
      ),
      registerWhatsappNumber: implement(contract.platformMessaging.registerWhatsappNumber).handler(
        async ({ input }) => serialize(await this.settings.registerNumber(ctx.actor, input)),
      ),
      retireWhatsappNumber: implement(contract.platformMessaging.retireWhatsappNumber).handler(
        async ({ input }) => serialize(await this.settings.retireNumber(ctx.actor, input.numberId)),
      ),
      companyPlans: implement(contract.platformMessaging.companyPlans).handler(async () =>
        this.entitlements.companyPlans(ctx.actor),
      ),
      setCompanyPlan: implement(contract.platformMessaging.setCompanyPlan).handler(
        async ({ input }) =>
          this.entitlements.setCompanyPlan(ctx.actor, input.companyId, input.plan),
      ),
    };
  }
}

/** The tenant app's conversations and push (plan 4.10). */
@Controller()
export class TenantMessagingController {
  constructor(
    @Inject(TenantMessagingService) private readonly messages: TenantMessagingService,
    @Inject(MessagingConsentService) private readonly consent: MessagingConsentService,
  ) {}

  @Implement(contract.tenantMessaging)
  tenantMessagingRouter(@Ctx() ctx: RequestContext) {
    return {
      conversations: implement(contract.tenantMessaging.conversations).handler(async () =>
        serialize(await this.messages.conversations(ctx.actor)),
      ),
      messages: implement(contract.tenantMessaging.messages).handler(async ({ input }) => {
        const { companyId, ...filter } = input;
        return serialize(await this.messages.messages(ctx.actor, companyId, filter));
      }),
      send: implement(contract.tenantMessaging.send).handler(async ({ input }) => {
        const { companyId, ...message } = input;
        return serialize(await this.messages.send(ctx.actor, companyId, message));
      }),
      attachmentDownload: implement(contract.tenantMessaging.attachmentDownload).handler(
        async ({ input }) =>
          serialize(
            await this.messages.attachmentDownload(
              ctx.actor,
              input.companyId,
              input.messageId,
              input.attachmentId,
            ),
          ),
      ),
      createPhotoUpload: implement(contract.tenantMessaging.createPhotoUpload).handler(
        async ({ input }) => {
          const { companyId, ...upload } = input;
          return serialize(await this.messages.createPhotoUpload(ctx.actor, companyId, upload));
        },
      ),
      registerPushDevice: implement(contract.tenantMessaging.registerPushDevice).handler(
        async ({ input }) =>
          this.messages.registerPushDevice(ctx.actor, ctx.session?.sessionId ?? null, input),
      ),
      unregisterPushDevice: implement(contract.tenantMessaging.unregisterPushDevice).handler(
        async ({ input }) => this.messages.unregisterPushDevice(ctx.actor, input.token),
      ),
      pushConsent: implement(contract.tenantMessaging.pushConsent).handler(async () =>
        this.consent.pushConsent(ctx.actor),
      ),
      setPushConsent: implement(contract.tenantMessaging.setPushConsent).handler(
        async ({ input }) => this.consent.setPushConsent(ctx.actor, input),
      ),
    };
  }
}

/**
 * The email unsubscribe page (CM-09; decision 7), called by apps/links with the links key. No
 * session: the token names the address. Rate-limited per token in the service.
 */
@Public()
@UseGuards(LinksKeyGuard)
@Controller()
export class UnsubscribeLinksController {
  constructor(@Inject(MessagingConsentService) private readonly consent: MessagingConsentService) {}

  @Implement(contract.unsubscribeLinks)
  unsubscribeRouter() {
    return {
      open: implement(contract.unsubscribeLinks.open).handler(async ({ input }) =>
        this.consent.unsubscribe(input.token, false, input.client),
      ),
      confirm: implement(contract.unsubscribeLinks.confirm).handler(async ({ input }) =>
        this.consent.unsubscribe(input.token, true, input.client),
      ),
    };
  }
}
