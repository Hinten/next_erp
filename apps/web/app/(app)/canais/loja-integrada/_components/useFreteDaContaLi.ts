'use client';

import { useMemo, useState } from 'react';
import type { DocumentData, Firestore } from 'firebase/firestore';
import { useFormContext } from 'react-hook-form';
import { PERM } from '@delfrance/auth';
import { buildQuery, whereEqual } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import {
  VINCULO_INT_FRETE_CONTA,
  escolherIntFreteMaisNovo,
  integracaoMeta,
  toOuterRef,
} from '@delfrance/schemas';
import {
  useObjectViewTransactionDocuments,
  useObjectViewTransactionDocumentSeed,
} from '@delfrance/ui';
import { usePermission } from '@/lib/auth';
import { intFreteCollection } from '@/lib/data/intFreteCollection';
import {
  CAMPO_HORARIO_CORTE_LI,
  CAMPO_MAPA_FRETE_LI,
  valoresDoFreteDaContaLi,
} from '@/lib/loja-integrada/freteDaConta';

const VINCULO = VINCULO_INT_FRETE_CONTA.lojaIntegrada;

/**
 * Which `int_frete` doc the conta screen's freight tabs edit, and why none.
 *
 * - `carregando` — the permission or the first SERVER answer is still pending.
 * - `sem-permissao` — no `PERM.frete.read`: nothing is subscribed.
 * - `erro` — the listener failed.
 * - `ausente` — the server has no freight doc for this conta.
 * - `encontrado` — the doc to edit. `ativo` is the doc's RAW flag (`true` only
 *   when stored `true`, which is what the order importer requires); `total`
 *   counts every doc of this conta (more than one is shown as a warning);
 *   `naConsulta` turns false when the chosen doc stops matching the conta.
 */
export type FreteDaContaLi =
  | { readonly estado: 'carregando' }
  | { readonly estado: 'sem-permissao' }
  | { readonly estado: 'erro'; readonly mensagem: string }
  | { readonly estado: 'ausente' }
  | {
      readonly estado: 'encontrado';
      readonly intFreteId: string;
      readonly ativo: boolean;
      readonly total: number;
      readonly naConsulta: boolean;
    };

/** The doc id the tabs edit, or `null` when there is none. */
export function intFreteIdDe(frete: FreteDaContaLi): string | null {
  return frete.estado === 'encontrado' ? frete.intFreteId : null;
}

/**
 * The ONE listener behind both freight tabs of a Loja Integrada conta: its
 * `int_frete` docs (`tipo == 'lojaIntegrada' && contaLojaIntegradaEnviosOuterRef
 * == 'documents/integracao/<contaId>'`, the equality prefix of the step-20
 * index), and the one of them the tabs edit.
 *
 * **The pick is the order importer's**: `escolherIntFreteMaisNovo` over the
 * docs whose RAW `ativo` is `true` — the same pick as the server core's
 * `buscarIntFreteDaConta(…, { apenasAtivo: true })` — so the operator edits the
 * mapping the importer routes by, never a doc it ignores. Only when no doc is
 * active does it fall back to the newest one, shown as inactive. The query
 * therefore reads RAW bodies (`withConverter(null)`): the client converter's
 * soft parse turns an absent `ativo` into `true` and rescales dates, so a
 * parsed list would name a doc the importer never picks.
 *
 * **The choice is frozen** at the first SERVER answer that names a doc, for the
 * life of the conta id: the tabs seed their baseline from that doc, and a later
 * emission (another doc appearing, a date changing) must never retarget a save
 * at a doc the operator did not load.
 */
export function useFreteDaContaLi(db: Firestore, contaId: string): FreteDaContaLi {
  const { allowed, loading: permissaoCarregando } = usePermission(PERM.frete.read);
  const consulta = useMemo(
    () =>
      allowed
        ? buildQuery(intFreteCollection.ref(db, {}).withConverter(null), [
            whereEqual('tipo', VINCULO.tipoFrete),
            whereEqual(
              VINCULO.campoBackRef,
              toOuterRef(`${integracaoMeta.collectionPath}/${contaId}`),
            ),
          ])
        : null,
    [db, contaId, allowed],
  );
  const snap = useSnapshot<DocumentData>(consulta);

  const linhas = useMemo(
    () => (snap.data ?? []).map((d) => ({ id: d.id, data: d.data as Record<string, unknown> })),
    [snap.data],
  );
  const servidor = snap.fromCache === false && snap.data !== undefined;
  const escolhido = servidor
    ? (escolherIntFreteMaisNovo(linhas, (d) => d.ativo === true) ??
      escolherIntFreteMaisNovo(linhas))
    : null;

  // Frozen per conta id: set during render (React's "adjust state on a prop
  // change" pattern), never moved once set for this conta.
  const [congelado, setCongelado] = useState<{ contaId: string; id: string } | null>(null);
  if (escolhido !== null && congelado?.contaId !== contaId) {
    setCongelado({ contaId, id: escolhido.id });
  }
  const idCongelado = congelado?.contaId === contaId ? congelado.id : null;

  const linhaCongelada =
    idCongelado === null ? undefined : linhas.find((l) => l.id === idCongelado);
  const ativo = linhaCongelada?.data.ativo === true;
  const total = linhas.length;
  const naConsulta = linhaCongelada !== undefined;
  const erro = snap.error?.message ?? null;

  return useMemo((): FreteDaContaLi => {
    if (permissaoCarregando) return { estado: 'carregando' };
    if (!allowed) return { estado: 'sem-permissao' };
    if (idCongelado !== null) {
      return { estado: 'encontrado', intFreteId: idCongelado, ativo, total, naConsulta };
    }
    if (erro !== null) return { estado: 'erro', mensagem: erro };
    if (!servidor) return { estado: 'carregando' };
    return { estado: 'ausente' };
  }, [permissaoCarregando, allowed, idCongelado, ativo, total, naConsulta, erro, servidor]);
}

/**
 * Seed BOTH freight tabs from ONE server-truth snapshot of the conta's freight
 * doc — the sibling baseline the save's guard compares against, and the two
 * transient form fields — inside the conta's `ObjectView`.
 *
 * - **Server truth only**: `useObjectViewTransactionDocumentSeed` waits for a
 *   `fromCache === false` snapshot with no pending writes, then detaches; a
 *   later emission (another operator's save, the importer's append) moves
 *   neither the baseline nor the form, so it surfaces as a conflict at save.
 *   Only a commit, or a conflict the operator accepts, rebases them.
 * - **Both fields at once, by either tab**: both tabs call this with the same
 *   doc and the seed is idempotent (the registry keeps the first baseline and
 *   the first form baseline), so whichever runs first seeds both.
 * - **As defaults, not edits**: `resetField(…, { defaultValue })` makes the
 *   seeded value the field's default, so a freshly loaded conta is pristine —
 *   no leave-guard prompt, and the conta's own server-truth correction is not
 *   held back by a "dirty" form nobody touched.
 *
 * `ready` is false until the baseline exists; the tabs stay read-only until
 * then.
 */
export function useSemearFreteDaContaLi(
  db: Firestore,
  intFreteId: string | null,
): { readonly ready: boolean; readonly error: string | null } {
  const form = useFormContext();
  const documents = useObjectViewTransactionDocuments();
  const ref = useMemo(
    () => (intFreteId === null ? null : intFreteCollection.docRef(db, {}, intFreteId)),
    [db, intFreteId],
  );
  const seed = useObjectViewTransactionDocumentSeed(ref, (data) => {
    const valores = valoresDoFreteDaContaLi(data as Readonly<Record<string, unknown>> | null);
    for (const campo of [CAMPO_MAPA_FRETE_LI, CAMPO_HORARIO_CORTE_LI] as const) {
      if (documents?.getFormBaseline(campo) !== undefined) continue;
      documents?.seedFormField(campo, valores[campo]);
      form.resetField(campo, { defaultValue: valores[campo] });
    }
  });
  return {
    ready: ref !== null && documents !== null && seed.ready,
    error: seed.error?.message ?? null,
  };
}
