/**
 * Test seams for the native-kit create LEASE (#1912, `../criacaoKitEmCurso.ts`).
 * Test-only, imported by no `src` file.
 *
 * - {@link aoVivoDeTeste}: the live controls a create arm requires, over a
 *   fixed instant (or a function, to move the clock inside one run).
 * - {@link reservaDeTeste}: a REAL lease taken on the fake db, for a test that
 *   drives an applier (`criarKit`, `garantirKitNovo`, …) directly instead of
 *   through `publicarKitShopee`, which takes its own.
 * - {@link semEscritasDaReserva}: a write log without the lease's own writes —
 *   for the "nothing written" assertions of a run that holds a lease.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { criacaoKitShopeeMeta, type ArmaDaCriacaoDeKitShopee } from '@delfrance/schemas';

import type { ControlesDaPublicacaoAoVivo } from '../../anuncios/reservaRascunho';
import { reservarCriacaoDeKit, type ReservaDeCriacaoDeKit } from '../criacaoKitEmCurso';

export function aoVivoDeTeste(agora: number | (() => number)): ControlesDaPublicacaoAoVivo {
  return {
    agora: typeof agora === 'number' ? () => agora : agora,
    prazoDaRequisicao: null,
    aquecerCredencial: () => Promise.resolve(),
    confirmarSegundoAnuncio: false,
    confirmarCriacaoIncerta: false,
  };
}

export async function reservaDeTeste(
  deps: {
    readonly db: Firestore;
    readonly integracaoId: string;
    readonly nowMs: number;
    readonly aoVivo?: ControlesDaPublicacaoAoVivo;
  },
  produtoId: string,
  arma: ArmaDaCriacaoDeKitShopee = 'kit-criar',
): Promise<ReservaDeCriacaoDeKit> {
  return await reservarCriacaoDeKit(
    deps.db,
    { integracaoId: deps.integracaoId, produtoId, arma },
    deps.aoVivo ?? aoVivoDeTeste(deps.nowMs),
  );
}

/** The collection prefix of every lease document. */
export const PREFIXO_DA_RESERVA = `${criacaoKitShopeeMeta.collectionPath}/`;

/** `paths` without the lease's own documents. */
export function semEscritasDaReserva<T extends string | { readonly path: string }>(
  escritas: readonly T[],
): T[] {
  return escritas.filter(
    (e) => !(typeof e === 'string' ? e : e.path).startsWith(PREFIXO_DA_RESERVA),
  );
}
