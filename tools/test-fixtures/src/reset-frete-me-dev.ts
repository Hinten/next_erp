import { db } from './admin';

/**
 * Re-arm a seeded frete pedido for ANOTHER Comprar-etiqueta test.
 *
 * A successful buy stamps `freteInicial.printLabelId` + flips `estado` to
 * `aguardandoPostagem`, so the panel/row-action then offer "Retomar compra" /
 * Imprimir instead of a fresh buy. This resets the frete back to a
 * "quoted, not bought" state — clearing the label + tracking and re-selecting a
 * **Jadlog** quote (the drop-off carrier the agency auto-resolution unblocks;
 * Correios needs a real NF-e/DC-e and can't be bought from a dev pedido).
 *
 * It does NOT touch the integração, endereço, cliente or items — just the
 * frete's buy state — so you can loop: buy → reset → buy again.
 *
 * Usage (from the repo root):
 *   pnpm --filter @delfrance/test-fixtures reset:frete-me
 *   ME_RESET_PEDIDO_ID=dev-frete-me-02 pnpm ... reset:frete-me
 *   ME_RESET_SERVICE=4 pnpm ... reset:frete-me            # Jadlog .Com
 *
 * Requires the same env as the other fixtures (admin SDK + project id).
 */

/* eslint-disable no-console */

const PEDIDO_ID = process.env.ME_RESET_PEDIDO_ID?.trim() || 'dev-frete-me-01';
const SERVICE = process.env.ME_RESET_SERVICE?.trim() || '3'; // 3 = Jadlog .Package, 4 = .Com

/** ms → µs — frete datetime fields are microseconds since epoch. */
const us = (ms: number): number => ms * 1000;

function jadlogQuote(service: string): Record<string, unknown> {
  return {
    id: Number(service),
    name: service === '4' ? '.Com' : '.Package',
    company: { id: 2, name: 'Jadlog' },
  };
}

async function main(): Promise<void> {
  const ref = db().collection('pedidos').doc(PEDIDO_ID);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new Error(`pedidos/${PEDIDO_ID} not found — run \`seed:frete-me\` first.`);
  }
  const frete = (snap.data()?.freteInicial ?? null) as Record<string, unknown> | null;
  if (!frete) {
    throw new Error(`pedidos/${PEDIDO_ID} has no freteInicial — run \`seed:frete-me\` first.`);
  }

  const now = Date.now();
  await ref.update({
    'freteInicial.printLabelId': null,
    'freteInicial.externalId': null,
    'freteInicial.codRastreio': null,
    'freteInicial.estado': 'iniciado',
    'freteInicial.externalOptionId': SERVICE,
    'freteInicial.externalOptionIntegracao': 'melhorEnvios',
    'freteInicial.externalOptionData': jadlogQuote(SERVICE),
    'freteInicial.externalOptionSelectionDate': us(now),
    'freteInicial.ultimaModificacao': us(now),
  });

  console.log(
    `[reset-frete-me] ${PEDIDO_ID} re-armed: printLabelId/codRastreio cleared, ` +
      `estado=iniciado, quote=service ${SERVICE} (Jadlog ${jadlogQuote(SERVICE).name}). ` +
      `Open it and click "Comprar etiqueta".`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
