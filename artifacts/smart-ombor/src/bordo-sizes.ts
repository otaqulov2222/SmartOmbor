export const BORDO_SIZES = ['20-23', '20-25', '22-27', '24-29', '30-35', '36-40', '40-44', '41-43'] as const;

export type BordoSize = (typeof BORDO_SIZES)[number];

export function isBordoSize(value: string): value is BordoSize {
  return (BORDO_SIZES as readonly string[]).includes(value);
}

export function tashkentDay(value?: string | Date | null) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  }
  const dt = value instanceof Date ? value : value ? new Date(value) : new Date();
  if (Number.isNaN(+dt)) {
    const raw = String(value ?? '');
    return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : '';
  }
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(dt);
}
