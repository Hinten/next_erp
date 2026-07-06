import { describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

import { createBatchReadContext, preResolveImpostos } from '../../../lib/nfe/orchestrator/bundle';
import type { PedidoBundle } from '../../../lib/nfe/orchestrator/bundle';
import type { ImpostoResolver } from '../../../lib/nfe/imposto-resolver';

/**
 * Unit tests for the preResolveImpostos selection semantics (#398): a
 * stamped-but-INVALID imposto must reach the resolver cascade instead of
 * aborting emission downstream. The resolver is injected through the batch
 * context, so no Firestore fake is needed.
 */

const RESOLVED_BLOB = {
  origem: '0',
  configuracaoICMS: { crt: '1', csosn: '102' },
} as const;

const VALID_STAMP = {
  origem: '0',
  configuracaoICMS: { crt: '1', csosn: '400' },
} as const;

/** Invalid under the engine impostoSchema — no `origem`. */
const INVALID_STAMP = { NCM: '61091000' } as const;

function bundleWithItens(itens: Record<string, unknown[]>): PedidoBundle {
  return {
    pedidoId: 'PED-PRE',
    operacaoId: 'op-1',
    operacao: {},
    regrasImposto: [],
    pedido: { itens },
  } as unknown as PedidoBundle;
}

function harness(resolved: unknown) {
  const resolve = vi.fn().mockResolvedValue(resolved);
  const resolver: ImpostoResolver = { resolve };
  const ctx = createBatchReadContext();
  ctx.resolverByOperacaoId.set('op-1', resolver);
  return { resolve, ctx };
}

describe('preResolveImpostos — stamped-but-invalid imposto (#398)', () => {
  it('re-resolves an invalid stamp through the cascade and replaces the blob', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const entry: Record<string, unknown> = { imposto: { ...INVALID_STAMP } };
      const bundle = bundleWithItens({ 'P-1': [entry] });
      const { resolve, ctx } = harness(RESOLVED_BLOB);

      await preResolveImpostos(bundle, {} as Firestore, ctx);

      // The raw stamp is passed through (its NCM can key the regra tier)…
      expect(resolve).toHaveBeenCalledWith('P-1', { ...INVALID_STAMP });
      // …and the whole blob is REPLACED by the cascade result (deliberate
      // deviation from Flutter's partial merge — see the function docs).
      expect(entry.imposto).toEqual(RESOLVED_BLOB);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toMatch(/invalid imposto stamp.*resolver cascade/);
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps the original invalid blob when the cascade also misses (loud failure downstream)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const entry: Record<string, unknown> = { imposto: { ...INVALID_STAMP } };
      const bundle = bundleWithItens({ 'P-1': [entry] });
      const { ctx } = harness(null);

      await preResolveImpostos(bundle, {} as Firestore, ctx);

      // flattenAndValidate will now throw naming the bad sub-field.
      expect(entry.imposto).toEqual(INVALID_STAMP);
    } finally {
      warn.mockRestore();
    }
  });

  it('never consults the resolver for a VALID stamp', async () => {
    const entry: Record<string, unknown> = { imposto: { ...VALID_STAMP } };
    const bundle = bundleWithItens({ 'P-1': [entry] });
    const { resolve, ctx } = harness(RESOLVED_BLOB);

    await preResolveImpostos(bundle, {} as Firestore, ctx);

    expect(resolve).not.toHaveBeenCalled();
    expect(entry.imposto).toEqual(VALID_STAMP);
  });

  it('still resolves items with NO imposto at all (existing behavior)', async () => {
    const entry: Record<string, unknown> = { sku: 'S-1' };
    const bundle = bundleWithItens({ 'P-1': [entry] });
    const { resolve, ctx } = harness(RESOLVED_BLOB);

    await preResolveImpostos(bundle, {} as Firestore, ctx);

    expect(resolve).toHaveBeenCalledWith('P-1', null);
    expect(entry.imposto).toEqual(RESOLVED_BLOB);
  });
});
