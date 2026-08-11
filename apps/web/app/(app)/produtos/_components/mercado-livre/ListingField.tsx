'use client';

import type { ReactNode } from 'react';
import { Stack, Text } from '@mantine/core';

/**
 * One read-only label/value pair in the listing editor.
 *
 * ⚠️ Deliberately NOT a labelled form control. The e2e spec asserts
 * `card.getByLabel('Tipo de anúncio')` has **count 0** on a published listing —
 * that is how it proves the first-publish Select is gone. A `<label>`
 * association or an `aria-label` here would resurrect that locator and fail the
 * spec while looking harmless in review.
 *
 * U5 replaces these with real inputs; until then the value is text.
 */
export function ListingField({
  label,
  children,
  span,
}: {
  label: string;
  children: ReactNode;
  /** Let a long value (descrição) take the full grid width. */
  span?: boolean;
}) {
  return (
    <Stack gap={2} style={span ? { gridColumn: '1 / -1' } : undefined}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      {typeof children === 'string' || typeof children === 'number' ? (
        <Text size="sm">{children}</Text>
      ) : (
        children
      )}
    </Stack>
  );
}

/** The dash used for an absent value, so empty rows still line up. */
export const EMPTY_VALUE = '—';

export function textOr(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return EMPTY_VALUE;
  const s = String(value).trim();
  return s.length > 0 ? s : EMPTY_VALUE;
}
