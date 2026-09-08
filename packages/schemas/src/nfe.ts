import { z } from 'zod';
import type { CollectionMetadata } from './types';
import { microsSinceEpoch, millisSinceEpoch } from './shared/datetime';
import { finNFeOperacaoSchema, tipoNFeSchema } from './operacao';

// Mirror `PERM.nfe` from @delfrance/auth.
const PERM_NFE_READ = 1n << 32n;
const PERM_NFE_WRITE = 1n << 33n;
const PERM_NFE_DELETE = 1n << 34n;

/**
 * EstadoNotaFiscalEletronica — string-coded estado da NF-e.
 * Wire values match Flutter's `EstadoNotaFiscalEletronica.value`.
 */
export const estadoNFeSchema = z.enum([
  '0', // gerado
  '1', // enviando
  '2', // aguardandoResposta
  '3', // processamentoCompleto
  '4', // processamentoCancelado
  'a', // aprovada
  'p', // epecAprovado
  'n', // rejeitada
  'c', // cancelada
  'i', // numeracaoInutilizada
  'e', // error
]);
export type EstadoNFe = z.infer<typeof estadoNFeSchema>;

export const ESTADO_NFE = {
  gerado: '0',
  enviando: '1',
  aguardandoResposta: '2',
  processamentoCompleto: '3',
  processamentoCancelado: '4',
  aprovada: 'a',
  epecAprovado: 'p',
  rejeitada: 'n',
  cancelada: 'c',
  numeracaoInutilizada: 'i',
  error: 'e',
} as const satisfies Record<string, EstadoNFe>;

export const ESTADO_NFE_LABELS: Record<EstadoNFe, string> = {
  '0': 'Gerado',
  '1': 'Enviando',
  '2': 'Aguardando resposta',
  '3': 'Processamento completo',
  '4': 'Processamento cancelado',
  a: 'Aprovada',
  p: 'EPEC aprovado',
  n: 'Rejeitada',
  c: 'Cancelada',
  i: 'Numeração inutilizada',
  e: 'Erro',
};

/**
 * SEFAZ-final estados — another consulta can never legitimately change them.
 * Consultation flows (`consultarPedido`, the manual "Verificar novamente"
 * action) must short-circuit on these WITHOUT calling SEFAZ: `consSitNFe` for
 * a cancelada NF-e still returns the ORIGINAL authorization protNFe (cStat
 * 100), which would regress the doc to `aprovada`. `rejeitada`/`error` are
 * deliberately absent — re-verifying a possibly-stale local failure is the
 * whole point of the manual consulta.
 */
export const ESTADOS_FINAIS_NFE: ReadonlySet<EstadoNFe> = new Set<EstadoNFe>([
  ESTADO_NFE.aprovada,
  ESTADO_NFE.cancelada,
  ESTADO_NFE.numeracaoInutilizada,
]);

/** `true` when the estado is SEFAZ-final (see {@link ESTADOS_FINAIS_NFE}). */
export function isEstadoFinalNFe(estado: EstadoNFe | null | undefined): boolean {
  return estado != null && ESTADOS_FINAIS_NFE.has(estado);
}

/**
 * NF-e chave de acesso: exactly 44 digits. Shared source for every place
 * that validates a chave string (pedido `chNFeReferenciadas`, UI inputs).
 * Keep byte-identical to the pattern historically inlined at those call
 * sites (`/^\d{44}$/`) — see the anchor test in `nfe.test.ts`.
 */
export const CHAVE_NFE_REGEX = /^\d{44}$/;

/**
 * `<ICMSTot>` totals lifted out of the authorized XML into modeled numeric
 * fields, plus the two `<ide>` codes that decide whether a note is revenue at
 * all.
 *
 * **Why this exists.** `xml_nfe_proc` is a string, and no Firestore aggregation
 * can parse it — that is the whole finding of #1491, and why `pedido.impostos`
 * was retired in #1151 rather than kept. Persisting the totals is what turns
 * "sum the last 12 months of faturamento" from a full download of every NF-e
 * XML (which is what `apps/web/lib/nfe/export/buildCsvReport.ts` does today)
 * into an index-covered aggregate.
 *
 * **Components, not just `vNF`.** `vNF` is *not* receita bruta: ICMS-ST and IPI
 * are excluded from it by LC 123 art. 3º §1º, and `vDesc` covers unconditional
 * discounts, which are also excluded. Storing the parts costs the same single
 * write and means the receita-bruta definition can be refined without a second
 * migration over the whole corpus. ⚠️ No such reduction is written yet — this
 * block is deliberately a faithful copy of the document, never an
 * interpretation of it, and whichever components count as receita bruta is a
 * decision for the apuração that consumes them.
 *
 * ⚠️ **All-or-nothing on purpose.** Every component is required once the block
 * is present. The apuração planned in #1491 will count unreadable notes with an
 * `exists('totais.vNF')` probe and refuse to publish a rate while any exist —
 * that consumer is NOT written yet, and this invariant is what will make it
 * possible. A partially populated block would answer the probe wrongly, and
 * Firestore's `sum()` skips missing fields **silently**, which would understate
 * RBT12, drop the company into a lower faixa, and under-declare tax with every
 * job still reporting success.
 */
/**
 * Totais da Reforma Tributária (NT 2025.002, Grupo W03) — `<IBSCBSTot>`,
 * `<ISTot>` e `<vNFTot>`, irmãos de `<ICMSTot>` dentro de `<total>`.
 *
 * ⚠️ Presente apenas quando a nota foi emitida com RTC ligado
 * (`nfeConfig.emitirReformaTributaria`, opt-in por filial). `null` numa nota
 * pré-RTC não é dado faltando — é a ausência correta.
 *
 * Capturado JUNTO com o resto, e não depois, porque é exatamente o caso que a
 * justificativa deste bloco cita: guardar as partes custa o mesmo write e evita
 * uma segunda migração. Toda nota emitida com RTC entre o merge disto e um
 * "depois a gente vê" precisaria de um backfill próprio.
 */
export const nfeTotaisRtcSchema = z.object({
  /** `<vBCIBSCBS>` — base de cálculo do IBS/CBS. */
  vBCIBSCBS: z.number(),
  /** `<gIBS><vIBS>` — IBS total (UF + Município). */
  vIBS: z.number(),
  /** `<gCBS><vCBS>` — CBS total. */
  vCBS: z.number(),
  /** `<ISTot><vIS>` — Imposto Seletivo. `<ISTot>` é omitido quando zero. */
  vIS: z.number(),
  /**
   * `<vNFTot>` — `vNF` + IBS + CBS + IS. **Este** é o total da nota numa
   * emissão RTC; `ICMSTot.vNF` fica deliberadamente sem os tributos "por fora"
   * (regra de transição 2025–2026, RV VB01-10 Exceção 1) — ver
   * `packages/integrations/nfe/src/tribute/total.ts`.
   */
  vNFTot: z.number(),
});

export type NFeTotaisRtc = z.infer<typeof nfeTotaisRtcSchema>;

export const nfeTotaisSchema = z.object({
  /** `<vProd>` — soma dos produtos, antes de desconto/frete/ST. */
  vProd: z.number(),
  /** `<vDesc>` — descontos incondicionais; NÃO integram a receita bruta. */
  vDesc: z.number(),
  /** `<vST>` — ICMS-ST retido; NÃO integra a receita bruta. */
  vST: z.number(),
  /** `<vIPI>` — IPI; NÃO integra a receita bruta. */
  vIPI: z.number(),
  /** `<vFrete>` — frete cobrado do destinatário; integra o preço da operação. */
  vFrete: z.number(),
  /** `<vSeg>` — seguro cobrado do destinatário; integra o preço da operação. */
  vSeg: z.number(),
  /** `<vOutro>` — outras despesas acessórias; integram o preço da operação. */
  vOutro: z.number(),
  /**
   * `<vNF>` — total do bloco ICMS.
   *
   * ⚠️ **Não é necessariamente o total impresso no DANFE.** Numa nota emitida
   * com Reforma Tributária os tributos IBS/CBS/IS vão "por fora" e o total da
   * nota é `rtc.vNFTot`; `ICMSTot.vNF` permanece sem eles por regra de
   * transição. Para "o valor da nota" use `rtc?.vNFTot ?? vNF`.
   */
  vNF: z.number(),
  /** `<tpNF>` (B11) — 0 entrada, 1 saída. Uma entrada SUBTRAI do faturamento. */
  tpNF: tipoNFeSchema,
  /** `<finNFe>` (B25) — 1 normal, 2 complementar, 3 ajuste, 4 devolução. */
  finNFe: finNFeOperacaoSchema,
  /** Totais RTC — ver {@link nfeTotaisRtcSchema}. `null` fora de emissão RTC. */
  rtc: nfeTotaisRtcSchema.nullable().default(null),
});

export type NFeTotais = z.infer<typeof nfeTotaisSchema>;

/**
 * NotaFiscalEletronica — documento fiscal eletrônico. Subcoleção de Pedido
 * (`pedidos/{pedidoId}/nfev4` — wire name original do Flutter). Read-only na
 * UI Next; emissão fica no `apps/integrations`/Cloud Functions (Phase 5).
 * Mirrors `NotaFiscalEletronica` em `.old/packages/pedido_nfe/lib/src/models.dart`.
 */
export const nfeSchema = z.object({
  numeracao: z.number().int(),
  serie: z.number().int(),
  tpEmis: z.number().int().default(1),
  estado: estadoNFeSchema.default(ESTADO_NFE.gerado),

  /**
   * Denormalized owning-filial id (the parent pedido's filial). Lets a
   * `collectionGroup('nfev4')` range query be scoped to one filial — used by
   * the inutilização pre-check + reconciliation. `.optional()` only for
   * read-tolerance of legacy docs written before this field existed; the
   * orchestrator's writers always set a concrete string (never `undefined`),
   * so no Firebase `undefined`-write issue arises.
   */
  filialId: z.string().min(1).nullable().optional(),

  chave: z.string().min(1).nullable(),
  idLote: z.string().min(1).nullable(),
  infNFe: z.string().min(1).nullable(),
  xml_nfe_proc: z.string().min(1).nullable(),
  xml_epec_proc: z.string().min(1).nullable(),
  /**
   * Signed NF-e XML archived **before** the SOAP send (the anti-loss anchor).
   * The poller / recovery flow re-queries SEFAZ with this, never regenerates.
   * Set to `null` in the same write that persists `xml_nfe_proc` — the
   * nfeProc embeds the signed NFe, so keeping both would double the XML
   * payload (#128). EPEC docs (estado `'p'`) keep it until the pós-EPEC
   * transmission lands the proc.
   */
  xml_assinado: z.string().min(1).nullable(),
  /**
   * SEFAZ receipt number returned with `cStat=103` (lote async) and the
   * duplicidade codes (204/205/218/539). Used to poll `consReciNFe` and as
   * a hint when the chave is uncertain.
   */
  nRec: z.string().min(1).nullable(),
  /**
   * Bounded retry counter for the lote-pendente (cStat=105) poll loop.
   * The state machine resets this on every non-105 outcome. Also the
   * attempt counter the async reconciler caps at `MAX_RECONCILE_ATTEMPTS`.
   */
  retries: z.number().int().min(0).nullable(),
  /**
   * Earliest time the async reconciler may consult this lote again — the
   * consumo-indevido gate (avoids SEFAZ rejection 656). Seeded at emit time
   * to `now + tMed` (SEFAZ's estimate), then pushed out by the per-attempt
   * backoff (`nextConsultaDelayMs`). The Cloud Task is scheduled for this
   * instant; the backstop sweep skips docs whose `proximaConsultaEm` is in
   * the future. Cleared to `null` on any terminal outcome. Microseconds
   * since epoch (the project datetime standard — see `@delfrance/core/datetime`).
   */
  proximaConsultaEm: microsSinceEpoch().nullable().default(null),

  cStat: z.string().nullable(),
  xMotivo: z.string().nullable(),
  cMsg: z.string().nullable().optional(),
  xMsg: z.string().nullable().optional(),

  data_emissao: millisSinceEpoch().nullable().default(null),
  data_autorizacao: millisSinceEpoch().nullable().default(null),
  dataContingencia: millisSinceEpoch().nullable().default(null),
  justificativaContingencia: z.string().min(15).max(255).nullable(),

  /**
   * Totais do `<ICMSTot>` (+ RTC) — ver {@link nfeTotaisSchema}. Escrito no
   * MESMO write que persiste `xml_nfe_proc`, derivado desses próprios bytes.
   *
   * ⚠️ `null` em toda nota autorizada ANTES deste campo existir, e assim
   * permanece: nada preenche o histórico retroativamente hoje. Um backfill é
   * trabalho da janela de migração (regra 8) e ainda não tem script nem issue
   * — o #1491 acompanha.
   *
   * A alíquota e o imposto rateado NÃO moram aqui ainda: os campos chegam
   * junto do runner que os escreve, e não antes. Um campo que nada escreve é
   * exatamente o que o #1151 acabou de remover deste repositório.
   */
  totais: nfeTotaisSchema.nullable().default(null),

  error: z.string().nullable(),
  ultima_modificacao: millisSinceEpoch().nullable().default(null),
});

export type NotaFiscalEletronica = z.infer<typeof nfeSchema>;

export const nfeMeta: CollectionMetadata = {
  collectionPath: 'pedidos/{pedidoId}/nfev4',
  permissions: {
    read: PERM_NFE_READ,
    write: PERM_NFE_WRITE,
    delete: PERM_NFE_DELETE,
  },
};

export const nfe = { schema: nfeSchema, meta: nfeMeta };
