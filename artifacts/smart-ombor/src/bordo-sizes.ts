export const BORDO_SIZES = ['20-23', '20-25', '22-27', '24-29', '30-35', '36-40', '40-44', '41-43'] as const;

export type BordoSize = (typeof BORDO_SIZES)[number];

export function isBordoSize(value: string): value is BordoSize {
  return (BORDO_SIZES as readonly string[]).includes(value);
}
