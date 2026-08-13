const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

export function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

/** Принимает российские и международные форматы (раздел 12 инструкции). */
export function isValidPhone(value: string): boolean {
  const digits = digitsOnly(value);
  return digits.length >= 10 && digits.length <= 15;
}

export function normalizePhone(value: string): string {
  const digits = digitsOnly(value);
  if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) {
    return '+7' + digits.slice(1);
  }
  if (digits.length === 10) {
    return '+7' + digits;
  }
  return '+' + digits;
}

export function looksLikeUrl(value: string): boolean {
  return /^(https?:\/\/)?[a-zA-Zа-яА-Я0-9-]+\.[a-zA-Zа-яА-Я]{2,}/.test(value.trim());
}

export function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}
