import type { AgentProfile, UserRole } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        role: UserRole;
        sessionId: string;
      };
      agent?: AgentProfile;
      /** Raw request bytes, kept for provider webhook signature checks. */
      rawBody?: Buffer;
    }
  }
}

export {};
