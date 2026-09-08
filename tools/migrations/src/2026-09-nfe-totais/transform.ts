/**
 * A decisão do backfill de `totais`, isolada do Firestore (#1491).
 *
 * O bloco `nfeTotaisSchema` passou a ser gravado na EMISSÃO
 * (`apps/nfe/lib/nfe/orchestrator/audit.ts`, no mesmo write que persiste
 * `xml_nfe_proc`). Toda nota autorizada ANTES disso não o tem — e enquanto não
 * tiver, a apuração mensal a conta em `notasIlegiveis` e se RECUSA a publicar
 * uma alíquota. Este backfill é a chave que liga a feature, não uma faxina.
 *
 * ⚠️ **A releitura usa o MESMO `extrairTotaisNFe` da emissão**, injetado como
 * parâmetro. Uma segunda cópia da dobra XML→números divergiria devagar, e a
 * divergência aqui seria invisível: o número continua saindo, só sai errado.
 */
import {
  nfeTotaisRtcSchema,
  nfeTotaisSchema,
  type NFeTotais,
  type NFeTotaisRtc,
} from '@delfrance/schemas';

/** Por que uma nota não recebe bloco. */
export type MotivoPular =
  /** Sem `xml_nfe_proc`: nunca autorizada, ou EPEC ainda em trânsito. */
  | 'sem-xml'
  /** Tem XML, mas o parser não conseguiu ler os totais. Precisa de humano. */
  | 'ilegivel'
  /** Já tem exatamente este bloco — a idempotência. */
  | 'ja-igual';

/** Por que uma nota recebe bloco. */
export type MotivoGravar =
  /** Não tinha bloco nenhum — a população principal. */
  | 'ausente'
  /** Tinha um bloco que DISCORDA do recalculado (ver o ⚠️ em `planejarTotais`). */
  | 'divergente';

export type PlanoTotais =
  | { readonly acao: 'gravar'; readonly motivo: MotivoGravar; readonly totais: NFeTotais }
  | { readonly acao: 'pular'; readonly motivo: MotivoPular };

/**
 * As chaves comparadas saem do PRÓPRIO schema, nunca de uma lista à mão: um
 * campo novo em `nfeTotaisSchema` que esta comparação ignorasse faria o backfill
 * responder `ja-igual` para exatamente as notas que precisam dele — um pulo
 * silencioso, que é a única classe de erro que este pacote não pode ter.
 */
const CHAVES_TOTAIS = Object.keys(nfeTotaisSchema.shape) as readonly (keyof NFeTotais)[];
const CHAVES_RTC = Object.keys(nfeTotaisRtcSchema.shape) as readonly (keyof NFeTotaisRtc)[];

/**
 * `undefined` (chave ausente) e `null` significam a mesma coisa nos dois lados —
 * "esta nota não tem grupo RTC" — e precisam comparar iguais, ou toda nota
 * pré-Reforma seria reescrita a cada passada.
 */
function rtcIgual(armazenado: unknown, calculado: NFeTotaisRtc | null): boolean {
  const stored = armazenado ?? null;
  if (calculado === null || stored === null) return calculado === stored;
  if (typeof stored !== 'object') return false;
  const bruto = stored as Record<string, unknown>;
  return CHAVES_RTC.every((chave) => bruto[chave] === (calculado[chave] as unknown));
}

/**
 * O bloco gravado é o mesmo que acabamos de calcular?
 *
 * ⚠️ Comparação de CAMPOS nomeados, não um `deepEqual`: o que conta como "igual"
 * é uma decisão desta migração e fica escrita aqui, onde o teste de campo-a-campo
 * ao lado a percorre inteira a partir do schema.
 */
export function totaisIguais(armazenado: unknown, calculado: NFeTotais): boolean {
  if (typeof armazenado !== 'object' || armazenado === null) return false;
  const bruto = armazenado as Record<string, unknown>;
  for (const chave of CHAVES_TOTAIS) {
    if (chave === 'rtc') continue;
    if (bruto[chave] !== (calculado[chave] as unknown)) return false;
  }
  return rtcIgual(bruto.rtc, calculado.rtc);
}

/**
 * O que fazer com uma NF-e.
 *
 * ⚠️ **`divergente` reescreve, e é o caso que existe de verdade.** A fatia 1
 * (#1541) gravou o bloco sem `receitaBruta`; a fatia 2 acrescentou o campo. Toda
 * nota emitida entre as duas carrega um bloco PARCIAL — completo pelo schema da
 * época, incompleto para a soma mensal, que ignora em silêncio o documento sem
 * `receitaBruta`. Recalcular a partir do mesmo `xml_nfe_proc` é seguro porque
 * esse campo tem UM escritor (`swapAnchorForProc`) e é imutável depois de
 * gravado: os bytes de origem não mudam, então as duas leituras só discordam
 * quando o PARSER mudou — que é justamente quando queremos a nova.
 *
 * ⚠️ `ilegivel` nunca vira zero. Um componente malformado dobrado para `0`
 * deixaria a nota parecendo legível e a apuração publicaria uma alíquota sobre
 * uma receita que ela própria estragou. A nota fica sem bloco, contada, e o log
 * a nomeia.
 */
export function planejarTotais(
  dados: Record<string, unknown>,
  extrair: (xml: string) => NFeTotais | null,
): PlanoTotais {
  const xml = dados.xml_nfe_proc;
  if (typeof xml !== 'string' || xml === '') return { acao: 'pular', motivo: 'sem-xml' };

  const calculado = extrair(xml);
  if (calculado === null) return { acao: 'pular', motivo: 'ilegivel' };

  const armazenado = dados.totais ?? null;
  if (armazenado === null) return { acao: 'gravar', motivo: 'ausente', totais: calculado };
  if (totaisIguais(armazenado, calculado)) return { acao: 'pular', motivo: 'ja-igual' };
  return { acao: 'gravar', motivo: 'divergente', totais: calculado };
}
