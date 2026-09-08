/**
 * O agregado da apuração: soma a receita bruta das NF-e aprovadas de uma
 * janela, agrupada por `(filial, tpNF, finNFe)`, e o CONTROLE que diz se essa
 * soma viu tudo (#1491).
 *
 * ⚠️ **Pipelines API — NÃO roda no emulador**, que é Standard edition. Ele até
 * expõe `db.pipeline()`, e a chamada falha só na execução, então detectar
 * capacidade pelo cliente responde "sim" e quebra depois. Por isso este módulo
 * é injetado como seam (`FetchReceita`, `FetchTotalJanela`) e os testes
 * exercitam {@link interpretarLinhasDoAgregado}, que é onde a leitura pode
 * errar.
 *
 * ## ⚠️ Por que não há filtro de filial aqui
 *
 * Havia — uma execução por empresa, com `filialId` na cláusula `where` — e era
 * um buraco por onde a receita saía calada. `countIf` conta **entre as linhas
 * que o filtro já devolveu**, então tudo que o próprio `where` derruba não é
 * contado em lugar nenhum. E `filialId` é `.nullable().optional()` no
 * `nfeSchema` justamente por tolerância a documento legado (regra 8: o corpus
 * que chega na migração carrega nomes de campo antigos e linhas que estes
 * schemas não modelam). O resultado era: nota aprovada, com receita, sem
 * `filialId` ⇒ fora da disjunção ⇒ `notasIlegiveis === 0` ⇒ alíquota
 * PROMOVIDA sobre uma RBT12 menor do que a real. Faixa menor, imposto
 * subdeclarado, todo contador do log limpo — exatamente o que o guarda existe
 * para impedir, alcançado por uma porta que ele não olhava.
 *
 * Agora a janela inteira é lida de uma vez e AGRUPADA por `filialId`, então a
 * nota sem filial vira uma linha visível em vez de um silêncio; quem decide o
 * que é de quem é o runner, que conhece as filiais configuradas.
 *
 * ## ⚠️ Índices obrigatórios (dois), não opcionais
 *
 * - `nfev4(estado, data_emissao, filialId, totais.tpNF, totais.finNFe,
 *   totais.receitaBruta)`, COLLECTION_GROUP — o agregado principal;
 * - `nfev4(estado, data_emissao)`, COLLECTION_GROUP — o controle.
 *
 * Documento `nfev4` carrega o XML inteiro da NF-e, e o Enterprise cobra DADO
 * VARRIDO: um agregado não coberto lê os DOCUMENTOS, isto é, o corpus.
 *
 * ⚠️ **O controle existe porque um índice composto pode ser ESPARSO.** No
 * Firestore Standard um documento só entra num índice composto se tiver valor
 * para TODOS os campos indexados — e se o Enterprise mantiver isso, a nota sem
 * `totais.receitaBruta` não está no índice de seis campos, o `where` nunca a
 * alcança, e `countIf(not(exists(...)))` conta ZERO por construção: o guarda
 * seria vazio. Não dá para medir isso daqui (exige
 * `explain({ analyze: true })` num projeto real). Então o controle é uma
 * `countAll()` sobre um índice de DOIS campos que todo documento tem —
 * `estado` tem default no schema e `data_emissao` é o próprio campo do range —
 * e a diferença entre ele e o que o agregado viu é contada como ilegível. O
 * guarda deixa de depender da resposta que ninguém tem.
 */
import type { Firestore } from 'firebase-admin/firestore';
// Pipeline expression builders live in the `/pipelines` subpath (admin SDK).
import * as pipelines from '@google-cloud/firestore/pipelines';

import { ESTADO_NFE } from '@delfrance/schemas';

import type {
  FetchReceita,
  FetchTotalJanela,
  GrupoReceita,
  ReceitaDaJanela,
} from './runApuracaoSimples';

/** Um número finito, ou `null` — nunca `NaN` disfarçado de zero. */
function numero(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Traduz as linhas cruas do agregado em {@link ReceitaDaJanela}. **Pura** — é a
 * metade testável de um agregado que o emulador não executa.
 *
 * ⚠️ Nenhuma linha é descartada em silêncio. Uma linha que não vira grupo — sem
 * `filialId`, ou com `tpNF`/`finNFe` que o schema não reconhece — tem as notas
 * dela contadas em `notasIndeterminadas`, porque são notas cuja contribuição
 * ninguém sabe. A exceção é a linha SEM filial que o par `(tpNF, finNFe)` já
 * diz ser neutra (ajuste, devolução de compra): essa não é receita de ninguém,
 * então bloquear por causa dela seria um falso positivo permanente.
 *
 * ⚠️ `nIlegiveis` é somado de TODAS as linhas — inclusive das descartadas como
 * grupo. Somá-lo só das válidas perderia justamente a nota que o contador
 * existe para enxergar.
 */
export function interpretarLinhasDoAgregado(
  linhas: readonly Record<string, unknown>[],
): ReceitaDaJanela {
  const grupos: GrupoReceita[] = [];
  let notasIlegiveis = 0;
  let notasIndeterminadas = 0;

  for (const linha of linhas) {
    notasIlegiveis += numero(linha.nIlegiveis) ?? 0;

    const tpNF = numero(linha.tpNF);
    const finNFe = numero(linha.finNFe);
    const notas = numero(linha.nNotas) ?? 0;
    const filialId = linha.filialId;

    const tpOk = tpNF === 0 || tpNF === 1;
    const finOk = finNFe === 1 || finNFe === 2 || finNFe === 3 || finNFe === 4;
    if (!tpOk || !finOk) {
      // Códigos que o schema não reconhece: não dá para dizer se é receita.
      notasIndeterminadas += notas;
      continue;
    }

    if (typeof filialId !== 'string' || filialId === '') {
      // Nota aprovada sem filial. Só bloqueia se PUDER ser receita.
      if (sinalNaoNeutro(tpNF, finNFe)) notasIndeterminadas += notas;
      continue;
    }

    grupos.push({
      filialId,
      tpNF,
      finNFe,
      // Já somado pelo servidor a partir de `totais.receitaBruta` — a definição
      // vive em `receitaBrutaDeComponentes` e é aplicada uma vez, na emissão.
      receita: numero(linha.receita) ?? 0,
      notas,
    });
  }

  return { grupos, notasIlegiveis, notasIndeterminadas };
}

/**
 * `true` quando o par move receita. Duplica deliberadamente o teste de
 * `sinalDe` em vez de importá-lo, porque aqui a pergunta é binária e o import
 * criaria um ciclo entre este módulo e o runner que o tipa.
 */
function sinalNaoNeutro(tpNF: 0 | 1, finNFe: 1 | 2 | 3 | 4): boolean {
  return tpNF === 1 ? finNFe === 1 || finNFe === 2 : finNFe === 4;
}

/** O `where` que as DUAS execuções compartilham — uma definição só. */
function janela(inicioMs: number, fimMs: number) {
  return pipelines.and(
    pipelines.equal(pipelines.field('estado'), ESTADO_NFE.aprovada),
    pipelines.field('data_emissao').greaterThanOrEqual(inicioMs),
    pipelines.field('data_emissao').lessThan(fimMs),
  );
}

/**
 * A implementação real: UMA execução por apuração, cobrindo todas as filiais.
 *
 * O filtro de estado é `aprovada` apenas: uma nota `cancelada` conserva o
 * `xml_nfe_proc` e o bloco `totais`, então filtrar por "tem totais" contaria
 * receita cancelada. `epecAprovado` também fica de fora — é contingência em
 * trânsito que vira `aprovada` quando aterrissa, e contá-la nos dois estados a
 * somaria duas vezes.
 */
export const fetchReceitaSimples: FetchReceita = async (fs: Firestore, args) => {
  // eslint-disable-next-line no-restricted-syntax -- pipeline SOURCE stage, not a raw ref; admin collection handles have no pipeline surface
  const snap = await fs
    .pipeline()
    .collectionGroup('nfev4')
    .where(janela(args.inicioMs, args.fimMs))
    .aggregate({
      accumulators: [
        // UMA soma, do escalar derivado — não cinco somas dos componentes. É o
        // que permite um índice de 6 campos em vez de 10.
        pipelines.sum('totais.receitaBruta').as('receita'),
        pipelines.countIf(pipelines.exists('totais.receitaBruta')).as('nNotas'),
        // ⚠️ O contador que abre a mão conta a ausência do campo QUE É SOMADO,
        // não de um campo qualquer do bloco. `sum` ignora em silêncio o
        // documento sem `receitaBruta`; contar `vNF` no lugar mediria outra
        // coisa. ⚠️ Ele NÃO é o guarda inteiro: se o índice for esparso este
        // documento nem chega aqui — ver o controle no cabeçalho.
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

/**
 * O CONTROLE: quantas NF-e aprovadas existem na janela, ponto.
 *
 * ⚠️ Nenhum campo de `totais` entra nesta consulta, e nem `filialId` — é o que
 * a torna imune tanto ao filtro que derrubava nota sem filial quanto à possível
 * esparsidade do índice de seis campos (cabeçalho). O runner compara este total
 * com o que o agregado enxergou; a diferença é nota que ninguém contou.
 */
export const fetchTotalJanelaSimples: FetchTotalJanela = async (fs: Firestore, args) => {
  // eslint-disable-next-line no-restricted-syntax -- pipeline SOURCE stage, not a raw ref; admin collection handles have no pipeline surface
  const snap = await fs
    .pipeline()
    .collectionGroup('nfev4')
    .where(janela(args.inicioMs, args.fimMs))
    .aggregate({ accumulators: [pipelines.countAll().as('total')], groups: [] })
    .execute();

  const linha = snap.results[0]?.data() as Record<string, unknown> | undefined;
  const total = numero(linha?.total);
  if (total === null) {
    // Sem controle não há guarda, e sem guarda a alíquota seria promovida sobre
    // uma soma que ninguém verificou. Falhar é a única saída honesta.
    throw new Error('[apuracao-simples] o agregado de controle não devolveu um total legível');
  }
  return total;
};
