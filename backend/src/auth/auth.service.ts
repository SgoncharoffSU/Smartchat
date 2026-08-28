import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import * as jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-change-me';
const JWT_EXPIRES_IN = '30d';
const COOKIE_NAME = 'smartchat_cabinet_session';

export interface CabinetSessionPayload {
  companyId: string;
  userId: string;
  // 'owner' (default, omitted from most callers) or 'support' — a support
  // account's own companyId is just where its User row happens to live
  // (in practice "Умный Чат" itself); this is the flag SupportGuard checks
  // to grant read access to every OTHER company's support tickets.
  role?: string;
  // Tenant-side CRM permission — 'owner' (default) | 'manager' | 'employee'.
  // Unrelated to `role` above (that's the vendor-side support flag). See
  // User.companyRole and DealsService for what each level actually gates.
  companyRole?: string;
  // Set only on a session minted via CompaniesAdminController's "impersonate"
  // — a support agent looking at a real client's cabinet to help configure
  // their bot. userId above is still the SUPPORT agent's own real id, never
  // a client's — so every action taken during impersonation is provably
  // theirs, not silently attributed to the client. See signImpersonationSession.
  impersonating?: boolean;
}

const IMPERSONATION_EXPIRES_IN = '4h';

@Injectable()
export class AuthService {
  readonly cookieName = COOKIE_NAME;

  hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, 10);
  }

  verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  signSession(payload: CabinetSessionPayload): string {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  }

  // Much shorter-lived than a normal login (4h vs 30d) — this is a support
  // agent temporarily borrowing access to a client's cabinet, not their own
  // account; a stale impersonation cookie left signed-in on a shared machine
  // is a meaningfully worse leak than a stale normal session would be.
  signImpersonationSession(payload: CabinetSessionPayload): string {
    return jwt.sign({ ...payload, impersonating: true }, JWT_SECRET, { expiresIn: IMPERSONATION_EXPIRES_IN });
  }

  verifySession(token: string): CabinetSessionPayload | null {
    try {
      return jwt.verify(token, JWT_SECRET) as CabinetSessionPayload;
    } catch {
      return null;
    }
  }
}
