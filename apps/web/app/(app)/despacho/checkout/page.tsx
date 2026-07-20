'use client';

import { Stack, Title } from '@mantine/core';
import { PERM } from '@delfrance/auth';
import { RequirePerm } from '@/lib/auth';
import { CheckoutScreen } from './_components/CheckoutScreen';

/**
 * Despacho → Checkout. A warehouse operator loads a paid saída pedido, scans
 * every physical unit (kit-aware) to verify the shipment, and saves an audit
 * doc that advances the freight state machine + triggers NF-e / DANFE / label.
 *
 * Client-first (apps/web convention): all reads/writes go straight to the
 * Firebase JS SDK from `CheckoutScreen`. Deep-linkable via `?pedido=<id|numero>`.
 */
export default function CheckoutPage() {
  return (
    <RequirePerm bit={PERM.pedido.read} redirectTo="/inicio">
      <Stack gap="md">
        <Title order={2}>Checkout</Title>
        <CheckoutScreen />
      </Stack>
    </RequirePerm>
  );
}
