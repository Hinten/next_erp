/**
 * O agregado da apuração: soma a receita bruta das NF-e aprovadas de uma
 * janela, agrupada por `(filial, tpNF, finNFe)` (#1491).
 *
 * ⚠️ **Pipelines API — NÃO roda no emulador**, que é Standard edition. Ele até
 * expõe `db.pipeline()`, e a chamada falha só na execução, então detectar
 * capacidade pelo cliente responde "sim" e quebra depois. Por isso este módulo
 * é injetado como seam (`FetchReceita`) e os testes exercitam
 * {@link interpretarLinhasDoAgregado}, que é onde a leitura pode errar.
 *
 * ⚠️ **Índice obrigatório**, não opcional:
 * `nfev4(filialId, estado, data_emissao, totais.tpNF, totais.finNFe, …)`,
 * COLLECTION_GROUP. Documento `nfev4` carrega o XML inteiro da NF-e, e o
 * Enterprise cobra DADO VARRIDO — um agregado que precise ler os documentos
 * custa o tamanho do corpus inteiro em vez do tamanho do índice.
 */
import type { Firestore } from 'firebase-admin/firestore';
// Pipeline expression builders live in the `/pipelines` subpath (admin SDK).
import * as pipelines from '@google-cloud/firestore/pipelines';

import { ESTADO_NFE } from '@delfrance/schemas';

import type { FetchReceita, GrupoReceita, ReceitaDaJanela } from './runApuracaoSimples';

/** Um número finito, ou `null` — nunca `NaN` disfarçado de zero. */
function numero(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Traduz as linhas cruas do agregado em {@link ReceitaDaJanela}. **Pura** — é a
 * metade testável de um agregado que o emulador não executa.
 *
 * ⚠️ Uma nota sem `totais` não tem `tpNF` nem `finNFe`, então ela cai num grupo
 * de chave nula que NÃO é receita de lugar nenhum. Por isso `nIlegiveis` é
 * somado de TODAS as linhas — inclusive das que esta função descarta como
 * grupo. Somá-lo só das linhas válidas perderia exatamente as notas que o
 * contador existe para enxergar.
 */
export function interpretarLinhasDoAgregado(
  linhas: readonly Record<string, unknown>[],
): ReceitaDaJanela {
  const grupos: GrupoReceita[] = [];
  let notasIlegiveis = 0;

  for (const linha of linhas) {
    notasIlegiveis += numero(linha.nIlegiveis) ?? 0;

    const tpNF = numero(linha.tpNF);
    const finNFe = numero(linha.finNFe);
    const filialId = linha.filialId;
    if (typeof filialId !== 'string' || filialId === '') continue;
    if (tpNF !== 0 && tpNF !== 1) continue;
    if (finNFe !== 1 && finNFe !== 2 && finNFe !== 3 && finNFe !== 4) continue;

    // receita bruta = vProd − vDesc + vFrete + vSeg + vOutro — a mesma
    // definição de `receitaBrutaDeNota`, aplicada às somas do grupo.
    const receita =
      (numero(linha.vProd) ?? 0) -
      (numero(linha.vDesc) ?? 0) +
      (numero(linha.vFrete) ?? 0) +
      (numero(linha.vSeg) ?? 0) +
      (numero(linha.vOutro) ?? 0);

    grupos.push({
      filialId,
      tpNF,
      finNFe,
      receita,
      notas: numero(linha.nNotas) ?? 0,
    });
  }

  return { grupos, notasIlegiveis };
}

/** O filtro de filial: um `equal`, ou um `or` deles. */
function filtroFilial(filialIds: readonly string[]) {
  const iguais = filialIds.map((id) => pipelines.equal(pipelines.field('filialId'), id));
  if (iguais.length === 1) return iguais[0]!;
  return pipelines.or(iguais[0]!, iguais[1]!, ...iguais.slice(2));
}

/**
 * A implementação real. Uma execução de pipeline por empresa e por apuração.
 *
 * O filtro de estado é `aprovada` apenas: uma nota `cancelada` conserva o
 * `xml_nfe_proc` e o bloco `totais`, então filtrar por "tem totais" contaria
 * receita cancelada. `epecAprovado` também fica de fora — é contingência em
 * trânsito que vira `aprovada` quando aterrissa, e contá-la nos dois estados a
 * somaria duas vezes.
 */
export const fetchReceitaSimples: FetchReceita = async (fs: Firestore, args) => {
  if (args.filialIds.length === 0) return { grupos: [], notasIlegiveis: 0 };

  // eslint-disable-next-line no-restricted-syntax -- pipeline SOURCE stage, not a raw ref; admin collection handles have no pipeline surface
  const snap = await fs
    .pipeline()
    .collectionGroup('nfev4')
    .where(
      pipelines.and(
        pipelines.equal(pipelines.field('estado'), ESTADO_NFE.aprovada),
        pipelines.field('data_emissao').greaterThanOrEqual(args.inicioMs),
        pipelines.field('data_emissao').lessThan(args.fimMs),
        filtroFilial(args.filialIds),
      ),
    )
    .aggregate({
      accumulators: [
        pipelines.sum('totais.vProd').as('vProd'),
        pipelines.sum('totais.vDesc').as('vDesc'),
        pipelines.sum('totais.vFrete').as('vFrete'),
        pipelines.sum('totais.vSeg').as('vSeg'),
        pipelines.sum('totais.vOutro').as('vOutro'),
        pipelines.countIf(pipelines.exists('totais.vNF')).as('nNotas'),
        // O contador que abre a mão: notas que o `sum` ignorou em silêncio.
        // Mesma varredura, nenhuma query a mais.
        pipelines.countIf(pipelines.not(pipelines.exists('totais.vNF'))).as('nIlegiveis'),
      ],
      groups: ['filialId', 'totais.tpNF', 'totais.finNFe'],
    })
    .execute();

  return interpretarLinhasDoAgregado(
    snap.results.map((r) => {
      const row = r.data() as Record<string, unknown>;
      // `groups` devolve os campos aninhados sob o nome do último segmento.
      const totais = row.totais as Record<string, unknown> | undefined;
      return { ...row, tpNF: totais?.tpNF ?? row.tpNF, finNFe: totais?.finNFe ?? row.finNFe };
    }),
  );
};
