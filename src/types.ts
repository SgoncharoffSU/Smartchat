export type DialogState =
  | 'S0_START'
  | 'S2_COMPANY_CONTEXT'
  | 'S2B_COMPANY_CLARIFY'
  | 'S3_TASK_IDENTIFIED'
  | 'S3B_TASK_OTHER'
  | 'S5_SITE_CONTEXT'
  | 'S5B_SITE_URL'
  | 'S6_NAME_CAPTURED'
  | 'S7_EMAIL_CAPTURED'
  | 'S8_PHONE_CAPTURED'
  | 'S9_PD_CONSENT'
  | 'S10_SUMMARY_CONFIRMED'
  | 'S10B_FIX_SELECT'
  | 'S10C_FIX_VALUE'
  | 'S11_HANDOFF_CHOICE'
  | 'S13_COMPLETED'
  | 'S14_ABORTED';

export type WebsiteStatus = 'active' | 'in_development' | 'none' | 'unknown';
export type QualificationTier = 'A' | 'B' | 'C';

export interface Button {
  label: string;
  value: string;
}

export interface Slots {
  name: string | null;
  email: string | null;
  phone: string | null;
  phoneDeclined: boolean;
  companyName: string | null;
  companyActivity: string | null;
  primaryTask: string | null;
  websiteUrl: string | null;
  websiteStatus: WebsiteStatus;
  pdConsent: boolean | null;
  managerHandoffConsent: boolean | null;
  marketingConsent: boolean | null;
}

export interface TranscriptEntry {
  role: 'bot' | 'user';
  text: string;
  at: string;
}

export interface SessionState {
  sessionId: string;
  state: DialogState;
  slots: Slots;
  transcript: TranscriptEntry[];
  objections: string[];
  unansweredQuestions: string[];
  awaitingFixField: keyof Slots | null;
  preHandoffRequested: boolean;
  createdAt: string;
  updatedAt: string;
  completed: boolean;
}

export interface TurnResult {
  reply: string;
  buttons: Button[];
  sessionEnded: boolean;
}

export interface IncomingMessage {
  text: string;
  buttonValue?: string;
}
