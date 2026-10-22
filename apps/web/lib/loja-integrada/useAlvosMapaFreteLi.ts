'use client';

import { useMemo } from 'react';
import { getDoc, getDocs, type Firestore } from 'firebase/firestore';
import { useQuery } from '@tanstack/react-query';
import { buildQuery, limit, orderByField, whereOp } from '@delfrance/data';
import {
  INTEGRACAO_FRETE_LABELS,
  MOTIVO_FRETE_NAO_SUPORTADO_LI,
  POLITICA_ALVO_ETIQUETA_LI,
  TIPOS_ALVO_MAPA_FRETE_LI,
  avaliarAlvoDoMapaLi,
} from '@delfrance/schemas';
import { intFreteCollection } from '@/lib/data/intFreteCollection';

/**
 * Cap of the target list. `int_frete` holds a handful of docs per tipo (the
 * freight integrations themselves, not orders), so the cap is a backstop, not
 * a page size; a stored target past it is still resolved by id below.
 */
const LIMITE_ALVOS = 500;

/** One `int_frete` doc a `mapa` row can point at, read RAW. */
export interface AlvoFreteLi {
  readonly id: string;
  readonly nome: string;
  readonly tipo: string;
  /** The stored flag is exactly `true` — what an importer's `ativo == true` read requires. */
  readonly ativo: boolean;
  /** Its tipo is one a Loja Integrada row may be mapped to. */
  readonly suportado: boolean;
  /**
   * The Loja Integrada label ROUTE would accept it as a target — decided by the
   * route's own evaluator ({@link aceitoPelaRotaDeEtiqueta}), so a picker that
   * offers by it never offers what the route refuses, nor hides what it takes.
   * Not the same question as `ativo`: the route reads an ABSENT `ativo` (a
   * migrated doc) as active, where `ativo` above is the stored flag exactly.
   */
  readonly roteavel: boolean;
}

/**
 * Whether the label routing route accepts this RAW target doc: its own
 * evaluator (`avaliarAlvoDoMapaLi` under `POLITICA_ALVO_ETIQUETA_LI`), the
 * Melhor Envio SERVICE aside — a hand-picked Melhor Envio target takes its
 * service from the method's own mapa row, which the route checks itself.
 */
function aceitoPelaRotaDeEtiqueta(raw: Readonly<Record<string, unknown>>): boolean {
  const avaliacao = avaliarAlvoDoMapaLi(raw, null, POLITICA_ALVO_ETIQUETA_LI);
  return (
    avaliacao.tipo === 'valido' ||
    (avaliacao.tipo === 'invalido' &&
      avaliacao.motivo === MOTIVO_FRETE_NAO_SUPORTADO_LI.alvoSemServico)
  );
}

/** One target doc, as both pickers read it (exported for its tests). */
export function alvoFreteLiDoDoc(id: string, raw: Readonly<Record<string, unknown>>): AlvoFreteLi {
  const tipo = typeof raw.tipo === 'string' ? raw.tipo : '';
  return {
    id,
    nome: typeof raw.nome === 'string' && raw.nome.length > 0 ? raw.nome : id,
    tipo,
    ativo: raw.ativo === true,
    suportado: (TIPOS_ALVO_MAPA_FRETE_LI as readonly string[]).includes(tipo),
    roteavel: aceitoPelaRotaDeEtiqueta(raw),
  };
}

/** `nome (Tipo)` — the label every freight picker in the app uses. */
export function rotuloAlvoFreteLi(alvo: AlvoFreteLi): string {
  const tipo = (INTEGRACAO_FRETE_LABELS as Record<string, string>)[alvo.tipo] ?? alvo.tipo;
  return tipo ? `${alvo.nome} (${tipo})` : alvo.nome;
}

/**
 * The targets the "Destino" select offers and the stored targets it must still
 * name.
 *
 * ONE query for every Loja Integrada target picker: the conta screen's
 * "Mapeamento do Frete" tab and the `/pedidos` "Escolher transportadora…"
 * picker (master plan step 15) read the same list, under the same key, so the
 * two can never offer different targets — which is why it lives in
 * `lib/loja-integrada` and not beside either screen.
 *
 * - `alvos`: `int_frete where tipo in TIPOS_ALVO_MAPA_FRETE_LI orderBy nome`
 *   (rides `int_frete (tipo, nome)`), one-shot, active and inactive alike — the
 *   select offers the active ones and labels a stored inactive one.
 * - `armazenados`: each stored target id missing from that list, read BY ID —
 *   so a deleted target says "excluída" only when the doc is really gone, and a
 *   stored target of an unsupported tipo (a marketplace's freight) is named, not
 *   guessed. `null` means "no such doc".
 *
 * `habilitado` latches the reads to the tab's first opening: the tab stays
 * mounted from page load, and a conta screen opened only for its token must not
 * pay for the freight picker.
 */
export function useAlvosMapaFreteLi(
  db: Firestore,
  idsArmazenados: readonly string[],
  habilitado: boolean,
): {
  readonly alvos: readonly AlvoFreteLi[];
  readonly armazenados: ReadonlyMap<string, AlvoFreteLi | null>;
  readonly carregando: boolean;
  readonly erro: Error | null;
} {
  const lista = useQuery({
    queryKey: ['li-mapa-frete-alvos'],
    enabled: habilitado,
    staleTime: 60_000,
    queryFn: async () => {
      const snap = await getDocs(
        buildQuery(intFreteCollection.ref(db, {}).withConverter(null), [
          whereOp('tipo', 'in', [...TIPOS_ALVO_MAPA_FRETE_LI]),
          orderByField('nome'),
          limit(LIMITE_ALVOS),
        ]),
      );
      return snap.docs.map((d) => alvoFreteLiDoDoc(d.id, d.data()));
    },
  });

  const conhecidos = useMemo(() => new Set((lista.data ?? []).map((a) => a.id)), [lista.data]);
  const faltando = useMemo(
    () => [...new Set(idsArmazenados)].filter((id) => !conhecidos.has(id)).sort(),
    [idsArmazenados, conhecidos],
  );
  const porId = useQuery({
    queryKey: ['li-mapa-frete-alvos-armazenados', ...faltando],
    enabled: habilitado && lista.isSuccess && faltando.length > 0,
    staleTime: 60_000,
    queryFn: async () =>
      Promise.all(
        faltando.map(async (id) => {
          const snap = await getDoc(intFreteCollection.docRef(db, {}, id).withConverter(null));
          const raw = snap.data();
          return [id, raw === undefined ? null : alvoFreteLiDoDoc(id, raw)] as const;
        }),
      ),
  });

  const armazenados = useMemo(() => {
    const mapa = new Map<string, AlvoFreteLi | null>();
    for (const a of lista.data ?? []) mapa.set(a.id, a);
    for (const [id, alvo] of porId.data ?? []) mapa.set(id, alvo);
    return mapa;
  }, [lista.data, porId.data]);

  return {
    alvos: lista.data ?? [],
    armazenados,
    carregando: lista.isLoading || porId.isLoading,
    erro: lista.error ?? porId.error ?? null,
  };
}
