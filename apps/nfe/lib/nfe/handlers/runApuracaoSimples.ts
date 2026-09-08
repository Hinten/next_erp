/**
 * Apuração mensal do Simples Nacional (#1491) — o núcleo, sem trigger.
 *
 * Uma vez por mês: soma a receita bruta dos 12 meses anteriores, deriva a
 * alíquota efetiva, grava o registro da competência e — só se autorizado e só
 * se a janela foi lida por inteiro — publica a alíquota vigente.
 *
 * ## A RBT12 é da EMPRESA, o documento é da filial
 *
 * A Receita apura o Simples pela pessoa jurídica inteira: matriz e filiais
 * somam numa RBT12 só, num DAS só, recolhido pela matriz. O documento de
 * configuração é por filial porque é onde o humano edita — então este runner
 * agrupa a receita pela RAIZ do CNPJ (8 dígitos) e grava o MESMO resultado em
 * todas as filiais irmãs. Sendo ele o escritor único dos campos calculados,
 * irmãs não têm como divergir.
 *
 * ## Não roda no emulador
 *
 * O agregado é Pipelines API, que o emulador (Standard edition) não executa —
 * ele até expõe `db.pipeline()`, e a chamada falha só na execução. Por isso
 * `fetchReceita` é injetado: os testes passam um stub e exercitam a decisão,
 * que é a parte que pode estar errada.
 */
import type { Firestore } from 'firebase-admin/firestore';

import { roundReais } from '@delfrance/core/money';

import { safeErrorShape } from '../log';

import {
  apuracaoSimplesCollection,
  filialCollection,
  simplesNacionalConfigCollection,
} from '@delfrance/data/admin/collections';
import {
  APURACAO_ESTADO,
  SIMPLES_NACIONAL_CONFIG_DOC_ID,
  aliquotaEfetiva,
  competenciaAnterior,
  competenciaDe,
  janelaRbt12,
  sinalDe,
  type AnexoSimplesWire,
  type ApuracaoEstado,
} from '@delfrance/schemas';

/** Uma linha do agregado: um grupo `(filialId, tpNF, finNFe)` já somado. */
export interface GrupoReceita {
  readonly filialId: string;
  readonly tpNF: 0 | 1;
  readonly finNFe: 1 | 2 | 3 | 4;
  /** Soma da receita bruta SEM sinal das notas do grupo. */
  readonly receita: number;
  readonly notas: number;
}

/** O que o agregado devolve para uma janela. */
export interface ReceitaDaJanela {
  readonly grupos: readonly GrupoReceita[];
  /**
   * Notas aprovadas na janela sem bloco `totais` legível.
   *
   * ⚠️ O guarda de segurança do recurso. `sum()` ignora documento sem o campo
   * EM SILÊNCIO, então uma nota ilegível sairia da RBT12 e a receita pareceria
   * menor — faixa menor, imposto subdeclarado, todo job verde.
   */
  readonly notasIlegiveis: number;
  /**
   * Notas que o agregado VIU mas não soube atribuir: sem `filialId`, ou com um
   * par `(tpNF, finNFe)` fora do schema. Contam como ilegíveis pelo mesmo
   * motivo — a receita delas não entrou em RBT12 nenhuma.
   */
  readonly notasIndeterminadas: number;
}

/** O seam do agregado — injetável porque Pipelines não roda no emulador. */
export type FetchReceita = (
  fs: Firestore,
  args: {
    readonly inicioMs: number;
    readonly fimMs: number;
  },
) => Promise<ReceitaDaJanela>;

/**
 * O seam do CONTROLE: quantas NF-e aprovadas há na janela, sem olhar `filialId`
 * nem nenhum campo de `totais`.
 *
 * Existe porque o agregado só consegue contar o que o índice dele entrega, e
 * um índice composto pode não conter o documento a que falta um dos campos
 * indexados. Este total vem de outro índice, de dois campos que todo documento
 * tem — ver o cabeçalho de `fetchReceitaSimples.ts`.
 */
export type FetchTotalJanela = (
  fs: Firestore,
  args: { readonly inicioMs: number; readonly fimMs: number },
) => Promise<number>;

export interface ApuracaoPorFilial {
  readonly filialId: string;
  readonly competencia: string;
  readonly estado: ApuracaoEstado;
  readonly rbt12: number;
  readonly aliquotaEfetiva: number | null;
  readonly faixa: number | null;
  readonly promovida: boolean;
}

export interface ResultadoApuracao {
  readonly competencia: string;
  readonly filiaisExaminadas: number;
  readonly semConfig: number;
  readonly promovidas: number;
  readonly incompletas: number;
  readonly aguardandoAutorizacao: number;
  readonly foraDoRegime: number;
  readonly erros: readonly { readonly filialId: string; readonly error: string }[];
  readonly porFilial: readonly ApuracaoPorFilial[];
}

/**
 * A raiz do CNPJ — os 8 primeiros dígitos, que identificam a EMPRESA.
 * `null` quando o campo não tem 14 dígitos, caso em que a filial é apurada
 * sozinha em vez de entrar num grupo errado.
 */
export function raizCnpj(cnpj: string | null | undefined): string | null {
  if (typeof cnpj !== 'string') return null;
  const digitos = cnpj.replace(/\D/g, '');
  return digitos.length === 14 ? digitos.slice(0, 8) : null;
}

/** Uma filial com o que a apuração precisa dela. */
interface FilialParaApuracao {
  readonly id: string;
  readonly raiz: string;
  readonly anexo: AnexoSimplesWire;
  readonly recalculoAutomatico: boolean;
}

/**
 * Dobra os grupos do agregado numa receita líquida, aplicando o sinal de cada
 * combinação `(tpNF, finNFe)` pela MESMA função que a leitura de nota única usa.
 */
export function dobrarGrupos(grupos: readonly GrupoReceita[]): {
  readonly receita: number;
  readonly notasContadas: number;
  readonly notasNeutras: number;
} {
  let receita = 0;
  let notasContadas = 0;
  let notasNeutras = 0;
  for (const g of grupos) {
    const sinal = sinalDe(g.tpNF, g.finNFe);
    if (sinal === 0) {
      notasNeutras += g.notas;
      continue;
    }
    receita += g.receita * sinal;
    notasContadas += g.notas;
  }
  return { receita: roundReais(receita), notasContadas, notasNeutras };
}

/**
 * Quantas notas da janela NINGUÉM contou — a soma dos três buracos, em um número.
 *
 * `total` vem do controle (uma `countAll()` sobre `estado + data_emissao`);
 * `vistas` é tudo que o agregado enxergou, atribuído ou não. A diferença só
 * pode ser documento que o agregado não alcançou, e o caso que a motiva é o
 * índice composto ESPARSO: se o Enterprise, como o Standard, mantém fora do
 * índice o documento sem um dos campos indexados, então a nota sem
 * `totais.receitaBruta` não chega nem ao `countIf` que deveria contá-la, e o
 * guarda seria vazio. Isto o pega de outro ângulo.
 *
 * ⚠️ `max(0, …)` não é paranoia de tipo: as duas execuções são consultas
 * separadas, e uma emissão que aterrisse entre elas pode fazer o agregado ver
 * uma nota a mais que o controle. Um número negativo aí viraria um CRÉDITO de
 * ilegíveis, apagando um bloqueio real vindo de outra fonte.
 */
export function notasForaDoAgregado(args: {
  readonly total: number;
  readonly vistas: number;
}): number {
  return Math.max(0, args.total - args.vistas);
}

/**
 * Quantas notas da janela **nenhuma RBT12 vai receber** — a soma dos três
 * buracos por onde a receita saía calada. Pura, porque é a conta que decide se
 * uma alíquota pode ser publicada.
 *
 * 1. **Sem dono** — o grupo tem `filialId`, mas essa filial não está entre as
 *    configuradas neste run. A receita dela não entra em apuração nenhuma.
 * 2. **Indeterminadas** — o agregado viu a linha e não soube atribuí-la: sem
 *    `filialId`, ou com `(tpNF, finNFe)` fora do schema.
 * 3. **Fora do agregado** — {@link notasForaDoAgregado}, a diferença contra o
 *    controle, que pega o documento que o índice pode nem conter.
 *
 * ⚠️ O resultado é somado à conta de **todas** as filiais, não de uma. Uma nota
 * que ninguém soube atribuir não é problema de uma empresa — é uma janela que
 * ninguém conhece, e a regra do recurso é recusar em vez de subdeclarar.
 *
 * ⚠️ **Só as notas que MOVEM receita contam.** `dobrarGrupos` já exclui as
 * neutras de `notasContadas`, e `notasIndeterminadas` já aplicou o mesmo teste
 * na origem. Contar um ajuste seria um falso positivo permanente: uma nota de
 * ajuste legada congelaria a alíquota de todo mundo para sempre, e como ela não
 * é receita nem quando a filial existe, nada a resolveria.
 */
export function notasNaoContabilizadas(args: {
  readonly janela: ReceitaDaJanela;
  readonly totalNaJanela: number;
  readonly configuradas: ReadonlySet<string>;
}): number {
  const { janela, totalNaJanela, configuradas } = args;

  const semDono = dobrarGrupos(
    janela.grupos.filter((g) => !configuradas.has(g.filialId)),
  ).notasContadas;

  const todos = dobrarGrupos(janela.grupos);
  const fora = notasForaDoAgregado({
    total: totalNaJanela,
    vistas:
      todos.notasContadas + todos.notasNeutras + janela.notasIlegiveis + janela.notasIndeterminadas,
  });

  return semDono + janela.notasIndeterminadas + fora;
}

/**
 * Decide o estado de uma apuração. Pura, porque é a regra que não pode errar.
 *
 * ⚠️ `notasIlegiveis > 0` vence TUDO, inclusive autorização. Uma RBT12 lida
 * pela metade não é uma RBT12 pequena — é uma que não se sabe.
 *
 * ⚠️ **Inclusive quando ela sai ZERO**, e essa ordem é a correção do #1546: o
 * `!aliquotaOk` vinha primeiro, então uma janela INTEIRAMENTE ilegível — que dá
 * `rbt12 = 0`, logo `semReceita` — era reportada como `foraDoRegime`. É o
 * primeiro estado em que um projeto real cai, porque enquanto o backfill do
 * #1553 não rodar toda nota anterior é ilegível; e a tela então manda o
 * operador conferir o FATURAMENTO ("a receita dos 12 meses está zerada… fale
 * com a contabilidade") quando o que está errado são as notas, sem sequer
 * mostrar quantas. A cópia de `incompleta`, escrita justamente para esse caso,
 * nunca aparecia nele.
 */
export function estadoDaApuracao(args: {
  readonly notasIlegiveis: number;
  readonly recalculoAutomatico: boolean;
  readonly aliquotaOk: boolean;
}): ApuracaoEstado {
  if (args.notasIlegiveis > 0) return APURACAO_ESTADO.incompleta;
  if (!args.aliquotaOk) return APURACAO_ESTADO.foraDoRegime;
  return args.recalculoAutomatico ? APURACAO_ESTADO.vigente : APURACAO_ESTADO.aguardandoAutorizacao;
}

/** Argumentos do núcleo. `nowMs` e `fetchReceita` são injetados para teste. */
export interface ApuracaoArgs {
  readonly fs: Firestore;
  readonly nowMs: number;
  readonly fetchReceita: FetchReceita;
  /** O controle da janela — ver {@link FetchTotalJanela}. */
  readonly fetchTotalJanela: FetchTotalJanela;
  /** Competência a apurar. Omitida, usa o mês ANTERIOR ao de `nowMs`. */
  readonly competencia?: string;
}

/**
 * Carrega as filiais que têm configuração do Simples, já agrupadas por raiz de
 * CNPJ. Uma filial sem documento de configuração é ignorada (e contada): o
 * regime é uma decisão humana, e apurar sem ela seria inventar um anexo.
 */
async function carregarFiliais(
  fs: Firestore,
): Promise<{ readonly porRaiz: Map<string, FilialParaApuracao[]>; readonly semConfig: number }> {
  const snap = await filialCollection.ref(fs, {}).get();
  const porRaiz = new Map<string, FilialParaApuracao[]>();
  let semConfig = 0;

  for (const doc of snap.docs) {
    const filial = filialCollection.parseRead(doc.data(), doc.ref.path);
    const cfgSnap = await simplesNacionalConfigCollection
      .docRef(fs, { filialId: doc.id }, SIMPLES_NACIONAL_CONFIG_DOC_ID)
      .get();
    if (!cfgSnap.exists) {
      semConfig += 1;
      continue;
    }
    const cfg = simplesNacionalConfigCollection.parseRead(cfgSnap.data(), cfgSnap.ref.path);
    // A filial sem CNPJ legível é apurada sozinha, sob uma chave que só ela
    // ocupa — melhor uma RBT12 estreita e visível do que somar receita na
    // empresa errada.
    const raiz = raizCnpj(filial.cnpj) ?? `filial:${doc.id}`;
    const lista = porRaiz.get(raiz) ?? [];
    lista.push({
      id: doc.id,
      raiz,
      anexo: cfg.anexo,
      recalculoAutomatico: cfg.recalculoAutomatico,
    });
    porRaiz.set(raiz, lista);
  }
  return { porRaiz, semConfig };
}

/**
 * Grava a apuração da competência e, quando cabe, promove a alíquota vigente.
 *
 * **Rule 7, classe B** (decisão de fora + guarda nomeada): `recalculoAutomatico`
 * é relido DENTRO da transação e a promoção é re-derivada do `tx.get`, nunca da
 * leitura que montou o lote. Um humano que desligue a autorização enquanto o
 * runner soma não pode ter a alíquota publicada por baixo dele.
 */
async function gravarApuracao(args: {
  readonly fs: Firestore;
  readonly filial: FilialParaApuracao;
  readonly competencia: string;
  readonly rbt12: number;
  readonly notasIlegiveis: number;
  readonly notasNeutras: number;
  readonly notasContadas: number;
  readonly filiaisConsolidadas: readonly string[];
  readonly nowMs: number;
}): Promise<ApuracaoPorFilial> {
  const { fs, filial, competencia, rbt12, nowMs } = args;
  const calculo = aliquotaEfetiva(filial.anexo, rbt12);
  const configRef = simplesNacionalConfigCollection.docRef(
    fs,
    { filialId: filial.id },
    SIMPLES_NACIONAL_CONFIG_DOC_ID,
  );

  const decidido = await fs.runTransaction(async (tx) => {
    const atual = await tx.get(configRef);
    // Re-derivado do tx.get — NÃO do `filial.recalculoAutomatico` capturado
    // antes do agregado. Essa releitura é a guarda.
    const autorizado =
      atual.exists &&
      simplesNacionalConfigCollection.parseRead(atual.data(), configRef.path)
        .recalculoAutomatico === true;

    const estado = estadoDaApuracao({
      notasIlegiveis: args.notasIlegiveis,
      recalculoAutomatico: autorizado,
      aliquotaOk: calculo.ok,
    });
    const promovida = estado === APURACAO_ESTADO.vigente;

    tx.set(
      apuracaoSimplesCollection.docRef(fs, { filialId: filial.id }, competencia),
      apuracaoSimplesCollection.parse({
        competencia,
        rbt12,
        aliquotaEfetiva: calculo.ok ? calculo.aliquotaEfetiva : null,
        faixa: calculo.ok ? calculo.faixa.faixa : null,
        anexo: filial.anexo,
        estado,
        notasContadas: args.notasContadas,
        notasIlegiveis: args.notasIlegiveis,
        notasNeutras: args.notasNeutras,
        filiaisConsolidadas: [...args.filiaisConsolidadas],
        calculadoEm: nowMs,
      }),
    );

    // Os campos de diagnóstico são gravados SEMPRE — é assim que a tela mostra
    // "incompleta: 3 notas ilegíveis" em vez de silêncio. A alíquota só entra
    // no lote quando promovida.
    tx.set(
      configRef,
      simplesNacionalConfigCollection.parseMerge({
        rbt12,
        faixa: calculo.ok ? calculo.faixa.faixa : null,
        competencia,
        estadoApuracao: estado,
        calculadoEm: nowMs,
        notasIlegiveis: args.notasIlegiveis,
        notasNeutras: args.notasNeutras,
        filiaisConsolidadas: [...args.filiaisConsolidadas],
        ultimaModificacao: nowMs,
        ...(promovida && calculo.ok ? { aliquotaEfetiva: calculo.aliquotaEfetiva } : {}),
      }),
      { merge: true },
    );

    return { estado, promovida };
  });

  return {
    filialId: filial.id,
    competencia,
    estado: decidido.estado,
    rbt12,
    aliquotaEfetiva: calculo.ok ? calculo.aliquotaEfetiva : null,
    faixa: calculo.ok ? calculo.faixa.faixa : null,
    promovida: decidido.promovida,
  };
}

/**
 * Roda a apuração de uma competência para todas as filiais configuradas.
 *
 * ⚠️ **Uma leitura da janela para o run inteiro, não uma por empresa.** O
 * agregado não filtra por filial (ver o cabeçalho de `fetchReceitaSimples.ts`):
 * ele devolve a janela agrupada por `filialId`, e a atribuição é feita AQUI,
 * que é o único lugar que sabe quais filiais estão configuradas. Foi o que
 * fechou o buraco: com o filtro dentro do `where`, toda nota que ele derrubava
 * — sem `filialId`, ou de filial sem configuração — saía da RBT12 sem ser
 * contada em lugar nenhum, e a alíquota era promovida sobre uma receita menor
 * que a real.
 */
export async function runApuracaoSimples(args: ApuracaoArgs): Promise<ResultadoApuracao> {
  const { fs, nowMs, fetchReceita, fetchTotalJanela } = args;
  const competencia = args.competencia ?? competenciaAnterior(competenciaDe(nowMs))!;
  const janela = janelaRbt12(competencia);
  if (janela === null) {
    throw new Error(`[apuracao-simples] competência inválida: ${competencia}`);
  }

  const { porRaiz, semConfig } = await carregarFiliais(fs);
  const porFilial: ApuracaoPorFilial[] = [];
  const erros: { filialId: string; error: string }[] = [];

  const escopo = { inicioMs: janela.inicioMs, fimMs: janela.fimMs };
  const janelaRec = await fetchReceita(fs, escopo);
  const totalNaJanela = await fetchTotalJanela(fs, escopo);

  // Toda filial que este run vai apurar. Um grupo cuja filial não esteja aqui é
  // receita que nenhuma RBT12 vai receber — e isso precisa bloquear, não sumir.
  const configuradas = new Set<string>();
  for (const filiais of porRaiz.values()) for (const f of filiais) configuradas.add(f.id);

  const naoContabilizadas = notasNaoContabilizadas({
    janela: janelaRec,
    totalNaJanela,
    configuradas,
  });

  for (const [raiz, filiais] of porRaiz) {
    const filialIds = filiais.map((f) => f.id);
    try {
      const meus = janelaRec.grupos.filter((g) => filialIds.includes(g.filialId));
      const dobrado = dobrarGrupos(meus);

      for (const filial of filiais) {
        porFilial.push(
          await gravarApuracao({
            fs,
            filial,
            competencia,
            rbt12: dobrado.receita,
            notasIlegiveis: janelaRec.notasIlegiveis + naoContabilizadas,
            notasNeutras: dobrado.notasNeutras,
            notasContadas: dobrado.notasContadas,
            filiaisConsolidadas: filialIds,
            nowMs,
          }),
        );
      }
    } catch (e) {
      // Por-empresa, nunca fatal: uma raiz que falhe a ESCRITA não pode impedir
      // as outras de apurar — é a convenção das varreduras deste repositório
      // (falha por unidade se coleta e reporta; nunca se engole). A leitura da
      // janela é uma só e fica fora daqui: se ela falha, não há o que apurar.
      //
      // `safeErrorShape` em vez de um `instanceof Error` solto: ele já extrai
      // name/message/code sem prometer um narrowing que não faz, e é o que o
      // resto de `apps/nfe` usa em fronteira de log.
      const { name, message } = safeErrorShape(e);
      for (const f of filiais) {
        erros.push({ filialId: f.id, error: `raiz ${raiz}: ${name}: ${message}` });
      }
    }
  }

  return {
    competencia,
    filiaisExaminadas: porFilial.length,
    semConfig,
    promovidas: porFilial.filter((r) => r.promovida).length,
    incompletas: porFilial.filter((r) => r.estado === APURACAO_ESTADO.incompleta).length,
    aguardandoAutorizacao: porFilial.filter(
      (r) => r.estado === APURACAO_ESTADO.aguardandoAutorizacao,
    ).length,
    foraDoRegime: porFilial.filter((r) => r.estado === APURACAO_ESTADO.foraDoRegime).length,
    erros,
    porFilial,
  };
}
