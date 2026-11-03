/**
 * The NF-e upload's two decision tables (step 14, PR 14-b), over a status
 * reading (`statusNfe.ts`), the pedido's sibling documents (`pedidoNfe.ts`)
 * and, for a verification, the task payload (`tarefaNfe.ts`). Pure: they
 * answer an ACTION; the handler (PR 14-c) performs it, and builds every next
 * payload through `tarefaNfe.ts`'s builders.
 *
 * ## The sibling rule comes FIRST, in both fases
 *
 * Another eligible sale note of the same pedido (`outraElegivel`) ⇒ the aviso
 * `nfe-ambigua`: no submit, no clear, no hand-off — whatever Amazon says
 * (step-14 plan §3 decision 4). It is pure on Firestore data, so the handler
 * applies it before any Amazon call; the tables apply it again, so a caller
 * that skipped that check still cannot submit.
 *
 * ## The envio table ({@link decidirEnvioNfeAmazon}), fase `envio`
 *
 * | reading | siblings | action |
 * | --- | --- | --- |
 * | `sem-nota`, `recusada` | — | `enviar` (the verification carries this reading as `leituraAntes`) |
 * | `processando` | no cancelled sibling | `verificar` (rung 0: our earlier submit, or one made outside the ERP) |
 * | `aceita` | no cancelled sibling | `aceita` (clear our stamp, resolve, the step-15 seam) |
 * | `aceita`, `processando` | a cancelled sibling | aviso `nfe-substituta` (advisory) |
 * | `aceita-com-recusa`, `parcial` | — | aviso `nfe-parcialmente-aceita` |
 * | `indeterminado` | — | aviso `status-nfe-desconhecido` |
 *
 * A `recusada` at an `envio` dispatch (a new edge, or a person's re-drive
 * after a refusal) DOES submit: each resubmit is a human or fiscal act, never
 * a loop (step-14 plan §3 decision 15).
 *
 * ## The verification table ({@link decidirVerificacaoNfeAmazon}), fase `verificacao`
 *
 * It never submits, except the chain's ONE bounded resubmit:
 *
 * | reading | condition | action |
 * | --- | --- | --- |
 * | `aceita` | no cancelled sibling | `aceita` |
 * | `aceita` | a cancelled sibling | aviso `nfe-substituta` |
 * | `processando` | `degrau < 9` | `proximo-degrau` |
 * | `processando` | `degrau === 9` | aviso `aceite-nao-confirmado` (NO stamp: no decision is not a refusal) |
 * | `sem-nota` | `degrau ≤ 1` | `proximo-degrau` (the read-after-write lag, ≤ 3 min) |
 * | `sem-nota` | `degrau ≥ 2`, NO submit in this chain (`leituraAntes === null`) | aviso `envio-nao-confirmado` (no stamp) |
 * | `sem-nota` | `degrau ≥ 2`, a confirmed submit | aviso + stamp `nfe-nao-registrada` |
 * | `sem-nota` | `degrau ≥ 2`, an uncertain submit, `reenvios === 0` | `reenviar` (the ONE resubmit) |
 * | `sem-nota` | `degrau ≥ 2`, an uncertain submit, `reenvios === 1` | aviso `envio-nao-confirmado` |
 * | `recusada` | `degrau ≤ 1` and `leituraAntes === 'recusada'` | `proximo-degrau` (the OLD rejection our submit followed may still show) |
 * | `recusada` | otherwise | aviso + stamp `nfe-recusada` |
 * | `aceita-com-recusa`, `parcial` | — | aviso `nfe-parcialmente-aceita` (no hand-off) |
 * | `indeterminado` | — | aviso `status-nfe-desconhecido` |
 *
 * `leituraAntes` is non-null exactly when this chain's `envio` submitted
 * (`aposEnvioNfeAmazon` carries the reading the submit was planned on). A
 * chain whose `envio` read `processando` — an earlier submit of ours, or one
 * made outside the ERP — carries `null`, and a `sem-nota` there says only that
 * the note SOMEONE ELSE sent is gone: no stamp (a stamp is spent only on an
 * answer about THIS NF-e) and no automatic submit (each resubmit stays a
 * person's re-drive). The plan's verification row keyed `nfe-nao-registrada`
 * on `envioIncerto === false` alone, and its motivo row on "a CONFIRMED 2xx
 * submit"; the motivo row wins here (a plan amendment awaiting the owner's
 * confirmation).
 *
 * Whether an aviso also stamps is NEVER decided here: `motivosNfe.ts`'s sets
 * are the only source of that.
 *
 * ## The plan the write engine runs ({@link planoDeEnvioNfeAmazon})
 *
 * The envio table wrapped for `core/escrita.ts`: `escrever` is true only for
 * `enviar`, and the dry-run line names `acao` (`enviaria` for a planned
 * submit) and `statusAmazon` (the reading) — closed codes only.
 */
import type { CamposLogAmazon } from '../core/log';
import type { PlanoEscritaAmazon } from '../core/escrita';
import { MOTIVO_NFE_AMAZON } from './motivosNfe';
import type { IrmaosDaNfeAmazon } from './pedidoNfe';
import { LEITURA_STATUS_NFE_AMAZON, type LeituraStatusNfe } from './statusNfe';
import {
  type LeituraAntesNfeAmazon,
  LEITURA_ANTES_NFE_AMAZON,
  MAX_REENVIOS_NFE_AMAZON,
  type TarefaNfeAmazon,
  ULTIMO_DEGRAU_NFE_AMAZON,
} from './tarefaNfe';

/** The last rung on which a `sem-nota`, or our own old `recusada`, may still be the lag. */
export const ULTIMO_DEGRAU_DO_ATRASO_NFE_AMAZON = 1;

/** The avisos the two tables raise. */
export type MotivoDecisaoNfeAmazon =
  | typeof MOTIVO_NFE_AMAZON.nfeAmbigua
  | typeof MOTIVO_NFE_AMAZON.nfeSubstituta
  | typeof MOTIVO_NFE_AMAZON.nfeParcialmenteAceita
  | typeof MOTIVO_NFE_AMAZON.statusNfeDesconhecido
  | typeof MOTIVO_NFE_AMAZON.aceiteNaoConfirmado
  | typeof MOTIVO_NFE_AMAZON.nfeNaoRegistrada
  | typeof MOTIVO_NFE_AMAZON.envioNaoConfirmado
  | typeof MOTIVO_NFE_AMAZON.nfeRecusada;

/** The `aceita` path: clear our stamp if any, resolve `nfe-validada`, the step-15 seam. */
type Aceita = { readonly acao: 'aceita' };
/** An aviso (and, per `motivosNfe.ts`'s sets, maybe a stamp); the chain stops. */
type Avisar = { readonly acao: 'avisar'; readonly motivo: MotivoDecisaoNfeAmazon };

/** What an `envio` dispatch does. */
export type DecisaoEnvioNfeAmazon =
  | { readonly acao: 'enviar'; readonly leituraAntes: LeituraAntesNfeAmazon }
  | { readonly acao: 'verificar' }
  | Aceita
  | Avisar;

/** What a `verificacao` dispatch does. */
export type DecisaoVerificacaoNfeAmazon =
  | { readonly acao: 'proximo-degrau' }
  | { readonly acao: 'reenviar' }
  | Aceita
  | Avisar;

const avisar = (motivo: MotivoDecisaoNfeAmazon): Avisar => ({ acao: 'avisar', motivo });
const ACEITA: Aceita = { acao: 'aceita' };

/** The envio table (module header). */
export function decidirEnvioNfeAmazon(
  leitura: LeituraStatusNfe,
  irmaos: IrmaosDaNfeAmazon,
): DecisaoEnvioNfeAmazon {
  if (irmaos.outraElegivel) return avisar(MOTIVO_NFE_AMAZON.nfeAmbigua);
  switch (leitura.tipo) {
    case LEITURA_STATUS_NFE_AMAZON.semNota:
      return { acao: 'enviar', leituraAntes: LEITURA_ANTES_NFE_AMAZON.semNota };
    case LEITURA_STATUS_NFE_AMAZON.recusada:
      return { acao: 'enviar', leituraAntes: LEITURA_ANTES_NFE_AMAZON.recusada };
    case LEITURA_STATUS_NFE_AMAZON.processando:
      return irmaos.irmaCancelada ? avisar(MOTIVO_NFE_AMAZON.nfeSubstituta) : { acao: 'verificar' };
    case LEITURA_STATUS_NFE_AMAZON.aceita:
      return irmaos.irmaCancelada ? avisar(MOTIVO_NFE_AMAZON.nfeSubstituta) : ACEITA;
    case LEITURA_STATUS_NFE_AMAZON.aceitaComRecusa:
    case LEITURA_STATUS_NFE_AMAZON.parcial:
      return avisar(MOTIVO_NFE_AMAZON.nfeParcialmenteAceita);
    case LEITURA_STATUS_NFE_AMAZON.indeterminado:
      return avisar(MOTIVO_NFE_AMAZON.statusNfeDesconhecido);
  }
}

/** The verification table (module header). */
export function decidirVerificacaoNfeAmazon(
  leitura: LeituraStatusNfe,
  tarefa: TarefaNfeAmazon,
  irmaos: IrmaosDaNfeAmazon,
): DecisaoVerificacaoNfeAmazon {
  if (irmaos.outraElegivel) return avisar(MOTIVO_NFE_AMAZON.nfeAmbigua);
  const noAtraso = tarefa.degrau <= ULTIMO_DEGRAU_DO_ATRASO_NFE_AMAZON;
  switch (leitura.tipo) {
    case LEITURA_STATUS_NFE_AMAZON.aceita:
      return irmaos.irmaCancelada ? avisar(MOTIVO_NFE_AMAZON.nfeSubstituta) : ACEITA;
    case LEITURA_STATUS_NFE_AMAZON.processando:
      return tarefa.degrau < ULTIMO_DEGRAU_NFE_AMAZON
        ? { acao: 'proximo-degrau' }
        : avisar(MOTIVO_NFE_AMAZON.aceiteNaoConfirmado);
    case LEITURA_STATUS_NFE_AMAZON.semNota:
      if (noAtraso) return { acao: 'proximo-degrau' };
      // This chain never submitted (its envio read `processando`): what vanished
      // was a note someone else sent, so nothing here is an answer about OURS —
      // no stamp, and no automatic submit either (module header).
      if (tarefa.leituraAntes === null) return avisar(MOTIVO_NFE_AMAZON.envioNaoConfirmado);
      if (!tarefa.envioIncerto) return avisar(MOTIVO_NFE_AMAZON.nfeNaoRegistrada);
      return tarefa.reenvios < MAX_REENVIOS_NFE_AMAZON
        ? { acao: 'reenviar' }
        : avisar(MOTIVO_NFE_AMAZON.envioNaoConfirmado);
    case LEITURA_STATUS_NFE_AMAZON.recusada:
      return noAtraso && tarefa.leituraAntes === LEITURA_ANTES_NFE_AMAZON.recusada
        ? { acao: 'proximo-degrau' }
        : avisar(MOTIVO_NFE_AMAZON.nfeRecusada);
    case LEITURA_STATUS_NFE_AMAZON.aceitaComRecusa:
    case LEITURA_STATUS_NFE_AMAZON.parcial:
      return avisar(MOTIVO_NFE_AMAZON.nfeParcialmenteAceita);
    case LEITURA_STATUS_NFE_AMAZON.indeterminado:
      return avisar(MOTIVO_NFE_AMAZON.statusNfeDesconhecido);
  }
}

/** The envio table as the write engine's plan (module header). */
export interface PlanoEnvioNfeAmazon extends PlanoEscritaAmazon {
  readonly decisao: DecisaoEnvioNfeAmazon;
  readonly leitura: LeituraStatusNfe;
}

/** The action a dry-run line names for a planned submit. */
export const ACAO_ENVIARIA_NFE_AMAZON = 'enviaria';

/** The plan of one `envio` dispatch, for `core/escrita.ts` (module header). */
export function planoDeEnvioNfeAmazon(
  leitura: LeituraStatusNfe,
  irmaos: IrmaosDaNfeAmazon,
): PlanoEnvioNfeAmazon {
  const decisao = decidirEnvioNfeAmazon(leitura, irmaos);
  const escrever = decisao.acao === 'enviar';
  const diff: CamposLogAmazon = {
    acao: escrever ? ACAO_ENVIARIA_NFE_AMAZON : decisao.acao,
    statusAmazon: leitura.tipo,
    motivo: decisao.acao === 'avisar' ? decisao.motivo : null,
  };
  return { escrever, diff, decisao, leitura };
}
