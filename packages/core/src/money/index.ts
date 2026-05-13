/**
 * Money is stored as integer minor units (cents) + ISO 4217 currency code.
 * Avoids floating-point pitfalls. All arithmetic stays in BigInt where needed.
 */
export interface Money {
  amount: number; // cents (or smallest unit for the currency)
  currency: string; // ISO 4217, e.g. 'BRL', 'USD'
}

export function money(amount: number, currency = 'BRL'): Money {
  if (!Number.isInteger(amount)) {
    throw new Error('Money.amount must be an integer (minor units).');
  }
  return { amount, currency };
}

export function add(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new Error(`Cannot add ${a.currency} and ${b.currency}.`);
  }
  return { amount: a.amount + b.amount, currency: a.currency };
}

export function subtract(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new Error(`Cannot subtract ${b.currency} from ${a.currency}.`);
  }
  return { amount: a.amount - b.amount, currency: a.currency };
}

export function format(value: Money, locale = 'pt-BR'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: value.currency,
  }).format(value.amount / 100);
}
