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
 * `nfev4(filialId, estado, data_emissao, totais.tpNF, totais.finNFe,
 * totais.receitaBruta)`, COLLECTION_GROUP. Documento `nfev4` carrega o XML
 * inteiro da NF-e, e o Enterprise cobra DADO VARRIDO — um agregado que precise
 * ler os documentos custa o corpus inteiro em vez do índice. Somar UM escalar
 * derivado em vez dos cinco componentes é o que mantém esse índice em 6 campos.
 *
 * ⚠️ A cobertura é um JULGAMENTO a partir do contrato da API, não uma medição.
 * Confirmar exige `execute({ explainOptions: { mode: 'analyze' } })` num projeto
 * real e ler `snapshot.explainStats.text` — e execução sem resultado NÃO traz
 * `explainStats`, então a janela sondada precisa casar com linhas de verdade.
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

    grupos.push({
      filialId,
      tpNF,
      finNFe,
      // Já somado pelo servidor a partir de `totais.receitaBruta` — a definição
      // vive em `receitaBrutaDeComponentes` e é aplicada uma vez, na emissão.
      receita: numero(linha.receita) ?? 0,
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
        // UMA soma, do escalar derivado — não cinco somas dos componentes. É o
        // que permite um índice de 6 campos em vez de 10, e o que mantém o
        // agregado coberto pelo índice: sem cobertura ele leria os DOCUMENTOS,
        // e um `nfev4` carrega o XML inteiro da nota.
        pipelines.sum('totais.receitaBruta').as('receita'),
        pipelines.countIf(pipelines.exists('totais.receitaBruta')).as('nNotas'),
        // ⚠️ O contador que abre a mão conta a ausência do campo QUE É SOMADO,
        // não de um campo qualquer do bloco. `sum` ignora em silêncio o
        // documento sem `receitaBruta`; contar `vNF` no lugar mediria outra
        // coisa e deixaria justamente a nota perdida fora da conta.
        pipelines.countIf(pipelines.not(pipelines.exists('totais.receitaBruta'))).as('nIlegiveis'),
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
