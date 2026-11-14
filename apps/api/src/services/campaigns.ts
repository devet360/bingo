import type { Campaign, CampaignAudience, CampaignKind, UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { Errors } from '../lib/errors';

export interface CampaignInput {
  kind: CampaignKind;
  audience: CampaignAudience;
  locale: string;
  title: string;
  body: string;
  imageUrl?: string | null;
  linkUrl?: string | null;
  linkLabel?: string | null;
  enabled: boolean;
  priority: number;
  dismissHours: number;
  startsAt?: Date | null;
  endsAt?: Date | null;
}

export function serializeCampaign(campaign: Campaign) {
  return {
    id: campaign.id,
    kind: campaign.kind,
    audience: campaign.audience,
    locale: campaign.locale,
    title: campaign.title,
    body: campaign.body,
    imageUrl: campaign.imageUrl,
    linkUrl: campaign.linkUrl,
    linkLabel: campaign.linkLabel,
    enabled: campaign.enabled,
    priority: campaign.priority,
    dismissHours: campaign.dismissHours,
    startsAt: campaign.startsAt,
    endsAt: campaign.endsAt,
    createdById: campaign.createdById,
    createdAt: campaign.createdAt,
  };
}

function audiencesFor(role: UserRole): CampaignAudience[] {
  if (role === 'AGENT') return ['ALL', 'PLAYERS', 'AGENTS'];
  if (role === 'PLAYER') return ['ALL', 'PLAYERS'];
  return ['ALL'];
}

/** Campaigns a signed-in player should see right now, newest priority first. */
export async function listActiveCampaigns(role: UserRole, locale: string): Promise<Campaign[]> {
  const now = new Date();
  return prisma.campaign.findMany({
    where: {
      enabled: true,
      audience: { in: audiencesFor(role) },
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
      ],
      // Show the caller's language first, then English, then anything untagged.
      locale: { in: [locale, 'en'] },
    },
    orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
    take: 20,
  });
}

export async function listAllCampaigns(): Promise<Campaign[]> {
  return prisma.campaign.findMany({ orderBy: [{ createdAt: 'desc' }] });
}

export async function createCampaign(
  input: CampaignInput & { createdById: string },
): Promise<Campaign> {
  assertWindow(input.startsAt, input.endsAt);
  return prisma.campaign.create({
    data: {
      kind: input.kind,
      audience: input.audience,
      locale: input.locale,
      title: input.title,
      body: input.body,
      imageUrl: input.imageUrl ?? null,
      linkUrl: input.linkUrl ?? null,
      linkLabel: input.linkLabel ?? null,
      enabled: input.enabled,
      priority: input.priority,
      dismissHours: input.dismissHours,
      startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null,
      createdById: input.createdById,
    },
  });
}

export async function updateCampaign(
  id: string,
  input: Partial<CampaignInput>,
): Promise<Campaign> {
  const current = await prisma.campaign.findUnique({ where: { id } });
  if (!current) throw Errors.notFound('Campaign');
  assertWindow(
    input.startsAt === undefined ? current.startsAt : input.startsAt,
    input.endsAt === undefined ? current.endsAt : input.endsAt,
  );
  return prisma.campaign.update({
    where: { id },
    data: {
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.audience ? { audience: input.audience } : {}),
      ...(input.locale !== undefined ? { locale: input.locale } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.imageUrl !== undefined ? { imageUrl: input.imageUrl } : {}),
      ...(input.linkUrl !== undefined ? { linkUrl: input.linkUrl } : {}),
      ...(input.linkLabel !== undefined ? { linkLabel: input.linkLabel } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.dismissHours !== undefined ? { dismissHours: input.dismissHours } : {}),
      ...(input.startsAt !== undefined ? { startsAt: input.startsAt } : {}),
      ...(input.endsAt !== undefined ? { endsAt: input.endsAt } : {}),
    },
  });
}

export async function deleteCampaign(id: string): Promise<void> {
  const removed = await prisma.campaign.deleteMany({ where: { id } });
  if (removed.count === 0) throw Errors.notFound('Campaign');
}

function assertWindow(startsAt: Date | null | undefined, endsAt: Date | null | undefined): void {
  if (startsAt && endsAt && startsAt >= endsAt) {
    throw Errors.badRequest('endsAt must be after startsAt', 'INVALID_CAMPAIGN_WINDOW');
  }
}
