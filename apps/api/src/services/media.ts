import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { MediaAsset, UserRole } from '@prisma/client';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { Errors } from '../lib/errors';
import { isUniqueViolation } from '../lib/tx';

const MAX_LABEL = `${Math.round(env.MEDIA_MAX_BYTES / 1024)} KB`;

interface DetectedType {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  extension: 'png' | 'jpg' | 'webp';
}

/** Only raster screenshots are accepted; the bytes, not the filename, decide. */
function detectImage(buffer: Buffer): DetectedType | null {
  if (
    buffer.length > 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return { mimeType: 'image/png', extension: 'png' };
  }
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: 'jpg' };
  }
  if (
    buffer.length > 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { mimeType: 'image/webp', extension: 'webp' };
  }
  return null;
}

function decodeBase64(input: string): Buffer {
  const comma = input.startsWith('data:') ? input.indexOf(',') : -1;
  const payload = comma >= 0 ? input.slice(comma + 1) : input;
  try {
    return Buffer.from(payload, 'base64');
  } catch {
    throw Errors.badRequest('The image could not be decoded', 'INVALID_MEDIA');
  }
}

export interface StoreMediaInput {
  base64: string;
  uploadedById?: string;
  originalName?: string;
  purpose?: string;
}

export async function storeMedia(input: StoreMediaInput): Promise<MediaAsset> {
  const buffer = decodeBase64(input.base64);
  if (buffer.length === 0) throw Errors.badRequest('The image is empty', 'INVALID_MEDIA');
  if (buffer.length > env.MEDIA_MAX_BYTES) {
    throw Errors.badRequest(`Screenshots must be smaller than ${MAX_LABEL}`, 'MEDIA_TOO_LARGE');
  }
  const detected = detectImage(buffer);
  if (!detected) {
    throw Errors.badRequest('Only PNG, JPEG or WebP screenshots are accepted', 'UNSUPPORTED_MEDIA');
  }

  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const existing = await prisma.mediaAsset.findUnique({ where: { sha256 } });
  if (existing) {
    if (existing.purpose !== (input.purpose ?? 'proof')) {
      throw Errors.conflict('This image is already stored for a different purpose', 'MEDIA_PURPOSE_MISMATCH');
    }
    if (existing.uploadedById && existing.uploadedById !== input.uploadedById) {
      throw Errors.conflict('This file was already uploaded', 'MEDIA_DUPLICATE');
    }
    return existing;
  }

  const now = new Date();
  const folder = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const storageKey = `${folder}/${randomUUID()}.${detected.extension}`;
  const absolute = join(env.mediaDir, storageKey);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, buffer, { mode: 0o600 });

  try {
    return await prisma.mediaAsset.create({
      data: {
        sha256,
        storageKey,
        mimeType: detected.mimeType,
        byteSize: buffer.length,
        originalName: input.originalName,
        purpose: input.purpose ?? 'proof',
        uploadedById: input.uploadedById,
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const duplicate = await prisma.mediaAsset.findUnique({ where: { sha256 } });
      if (duplicate) return duplicate;
    }
    throw error;
  }
}

export function mediaAbsolutePath(asset: MediaAsset): string {
  return join(env.mediaDir, asset.storageKey);
}

export async function readMedia(asset: MediaAsset): Promise<Buffer> {
  return readFile(mediaAbsolutePath(asset));
}

/**
 * Access to payment evidence: the uploader, the player whose withdrawal it
 * proves, and staff. Everyone else gets a 404 so asset ids are not probeable.
 */
export async function assertMediaAccess(
  asset: MediaAsset,
  viewer: { userId: string; role: UserRole },
): Promise<void> {
  if (asset.uploadedById === viewer.userId) return;
  if (viewer.role === 'SUPER_ADMIN' || viewer.role === 'SUPPORT') return;
  const ownedProof = await prisma.withdrawalProof.findFirst({
    where: {
      mediaAssetId: asset.id,
      withdrawal: { playerId: viewer.userId },
    },
    select: { id: true },
  });
  if (!ownedProof) throw Errors.notFound('Media');
}
