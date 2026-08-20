'use client';

import type { QueryClient } from '@tanstack/react-query';
import type { Firestore } from 'firebase/firestore';
import { MODALIDADE_FRETE, type ModalidadeFrete } from '@delfrance/schemas';
import type { VolumeFormState } from '../../types';
import { fretePath, type PedidoFormHandle } from './fields';
import { pesoPedido, shouldSeedVolume, volumePadrao, type PesoPedidoItem } from './pesoPedido';
import { dimensoesPedido, type AvisoDimensoes } from './dimensoesPedido';
import { loadProdutoPesoMap } from './produtoPeso';

/** A `FlatItem` subset — the fields the seed reads. */
export interface SeedVolumeItem extends PesoPedidoItem {
  _delete?: boolean;
}

export interface SeedVolumePadraoArgs {
  form: PedidoFormHandle;
  db: Firestore;
  queryClient: QueryClient;
  /** `_itensFlat`; staged-for-deletion rows are filtered out here. */
  itens: readonly SeedVolumeItem[];
  marketplaceOwned: boolean;
}

/**
 * Seed the pedido's single default Volume, weighed from its items — the port
 * of the legacy `adicionarVolumePedido` (issue #371), which the Melhor Envio
 * widget ran when frete was first activated with no volumes
 * (`.old/lib/integracoes_frete/melhor_envios/widgets.dart:87,112-134`).
 *
 * Called from `onModalidadeChange`, i.e. from the **user gesture that
 * activates frete**, never from a mount effect. That is the whole design: the
 * form is owned by `PedidoForm`, so it outlives the Frete tab (whose Tabs use
 * `keepMounted={false}`) and this still completes if the operator switches
 * tabs mid-fetch — while a passive remount can never re-trigger it.
 *
 * Without a Volume, `buildCalculatePayload` quotes a fabricated
 * 20×20×20cm / **1kg** package, so seeding is what makes a quote use the
 * pedido's real weight.
 *
 * Returns the estimator's `aviso` when a Volume was written (`null` = seeded
 * cleanly), or `'naoSemeado'` when it declined. A produto read failure REJECTS
 * (`FirebaseError`) rather than seeding a wrong weight — the caller decides
 * how to surface both.
 */
export async function seedVolumePadrao(
  args: SeedVolumePadraoArgs,
): Promise<AvisoDimensoes | 'naoSemeado' | null> {
  const readVolumes = () =>
    (args.form.getValues(fretePath('volumes')) as VolumeFormState[] | null) ?? null;

  if (!shouldSeedVolume({ marketplaceOwned: args.marketplaceOwned, volumes: readVolumes() })) {
    return 'naoSemeado';
  }

  const itens = args.itens.filter((i) => !i._delete);
  const pesoById = await loadProdutoPesoMap(
    args.queryClient,
    args.db,
    itens.map((i) => i.produtoUid),
  );

  // Re-read AFTER the await, and re-decide from that value: the operator can
  // add a volume by hand while the batch is in flight, and a seed that
  // clobbered it would silently discard their entry (root CLAUDE.md rule 7 —
  // decide what happens when your write is the loser).
  if (!shouldSeedVolume({ marketplaceOwned: args.marketplaceOwned, volumes: readVolumes() })) {
    return 'naoSemeado';
  }

  // One batched map feeds both estimators — the weight and the box come from
  // the same produto reads (#371).
  const estimativa = dimensoesPedido(itens, pesoById);
  args.form.setValue(
    fretePath('volumes'),
    [volumePadrao(pesoPedido(itens, pesoById), estimativa)] as unknown as VolumeFormState[],
    { shouldDirty: true, shouldValidate: true },
  );
  return estimativa.aviso;
}

/**
 * Whether a modalidade change turns frete ON — the only moment a default
 * Volume is seeded.
 *
 * `wasAtivo` must be read from the form BEFORE the change is written
 * (`temFrete` is derived from watched state and only catches up next render).
 * Switching between two real modalidades on an already-active pedido is NOT an
 * activation, so it neither re-seeds nor spends a produto read.
 */
export function isAtivacaoDeFrete(wasAtivo: boolean, proxima: ModalidadeFrete): boolean {
  return !wasAtivo && proxima !== MODALIDADE_FRETE.semTransporte;
}
