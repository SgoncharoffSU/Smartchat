import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { QualificationTier, SessionState } from './types';

const DATA_DIR = path.join(__dirname, '..', 'data');
const LEADS_FILE = path.join(DATA_DIR, 'leads.jsonl');

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export type LeadRecord = ReturnType<typeof buildLeadRecord>;

/** Раздел 13: квалификация лида — только для маршрутизации, не показывается пользователю. */
export function computeQualificationTier(session: SessionState): QualificationTier {
  const { slots } = session;
  const hasContact = Boolean(slots.email || slots.phone);
  const hasConsent = slots.pdConsent === true;
  const hasTask = Boolean(slots.primaryTask);

  if (!hasConsent || !hasTask) return 'C';

  if (
    (slots.websiteStatus === 'active' || slots.websiteStatus === 'in_development') &&
    hasContact &&
    slots.managerHandoffConsent === true
  ) {
    return 'A';
  }

  if (hasContact) return 'B';
  return 'C';
}

/** Формирует запись CRM строго по структуре раздела 15. Неизвестные поля — null. */
export function buildLeadRecord(session: SessionState, managerBrief: string) {
  const { slots } = session;
  return {
    lead_id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    source: 'button_demo_access',
    product: 'Умный чат для сайта',
    name: slots.name,
    phone: slots.phone,
    email: slots.email,
    company_name: slots.companyName,
    company_activity: slots.companyActivity,
    website_url: slots.websiteUrl,
    website_status: slots.websiteStatus,
    primary_task: slots.primaryTask,
    current_problem: null,
    desired_result: null,
    current_solution: null,
    preferred_contact_channel: slots.phoneDeclined ? 'email' : 'phone',
    preferred_contact_time: null,
    pd_consent: slots.pdConsent === true,
    marketing_consent: slots.marketingConsent,
    manager_handoff_consent: slots.managerHandoffConsent === true,
    qualification_tier: computeQualificationTier(session),
    unanswered_questions: session.unansweredQuestions,
    objections: session.objections,
    demo_hypothesis: null as string | null,
    manager_brief: managerBrief,
    transcript_id: session.sessionId,
    transcript: session.transcript,
  };
}

/** Раздел 15/14 — лог лида только после согласия на обработку данных. */
export function appendLead(session: SessionState, managerBrief: string): LeadRecord | null {
  if (session.slots.pdConsent !== true) return null;
  ensureDataDir();
  const record = buildLeadRecord(session, managerBrief);
  fs.appendFileSync(LEADS_FILE, JSON.stringify(record) + '\n', 'utf-8');
  return record;
}

/** Раздел 9.15 / «Удалите мои данные» — фиксируем запрос, не подтверждаем удаление сами. */
export function appendDeletionRequest(session: SessionState): void {
  ensureDataDir();
  const record = {
    type: 'deletion_request',
    transcript_id: session.sessionId,
    requested_at: new Date().toISOString(),
  };
  fs.appendFileSync(LEADS_FILE, JSON.stringify(record) + '\n', 'utf-8');
}
