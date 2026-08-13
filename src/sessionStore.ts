import crypto from 'node:crypto';
import { SessionState } from './types';

const sessions = new Map<string, SessionState>();

function emptySlots(): SessionState['slots'] {
  return {
    name: null,
    email: null,
    phone: null,
    phoneDeclined: false,
    companyName: null,
    companyActivity: null,
    primaryTask: null,
    websiteUrl: null,
    websiteStatus: 'unknown',
    pdConsent: null,
    managerHandoffConsent: null,
    marketingConsent: null,
  };
}

export function createSession(): SessionState {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const session: SessionState = {
    sessionId: id,
    state: 'S0_START',
    slots: emptySlots(),
    transcript: [],
    objections: [],
    unansweredQuestions: [],
    awaitingFixField: null,
    preHandoffRequested: false,
    createdAt: now,
    updatedAt: now,
    completed: false,
  };
  sessions.set(id, session);
  return session;
}

export function getSession(id: string): SessionState | undefined {
  return sessions.get(id);
}

export function getOrCreateSession(id?: string): SessionState {
  if (id) {
    const existing = sessions.get(id);
    if (existing) return existing;
  }
  return createSession();
}

export function touchSession(session: SessionState): void {
  session.updatedAt = new Date().toISOString();
}
