/**
 * `loadLojaIntegradaContextoEscrita` — what a Loja Integrada WRITE run starts
 * from (master plan step 7): the conta, the package's write client and a read
 * client bound to its stored Personal Token, the writes pacer, and the
 * credential PIN.
 *
 * ## The read loader's refusals, in the read loader's order
 *
 *  0. the READ SWITCH (`LOJA_INTEGRADA_CHAMADAS`) is not exactly `on` →
 *     `LiChamadasDesligadasError`, after ONE `chamada-bloqueada` line, before
 *     ANY Firestore read and before a client exists (D17);
 *  1. no such conta, or not a Loja Integrada conta → `LiContaNaoEncontradaError`;
 *  2. `ativo === false` → `LiContaInativaError`;
 *  3. one uncached credential read: none → `LiCredencialAusenteError`, corrupt →
 *     `LiCredencialInvalidaError`, parked → `LiContaParadaError`.
 *
 * The same helpers as `core/contexto.ts` (the credential read is that module's
 * `credencialUtilizavel`). ⚠️ A file of its own on purpose: `contexto.ts` never
 * imports this one, so no App Hosting read route's import closure can reach the
 * write factory (`estrutura.test.ts` walks both step-15 routes and refuses it).
 *
 * ## Two clients, each with its own observer
 *
 *  - `escrita`, the package's write client (`criarClienteEscritaLi`): its getter
 *    only RE-READS the credential — it does not pace. The write engine
 *    (`core/escrita.ts`) owns the writes pacer and spends it before the read
 *    that decides a write, never between that read and the write;
 *  - `leitura`, the read client, used by the engine for the paged situação
 *    history only: its getter waits one interval before each request, as the
 *    read context's does.
 *
 * Each factory call builds its own observer, inline, from the app logger
 * (`log.ts`), with `conta` set to this context's id after the caller's options;
 * the seam guard (`estrutura.test.ts`) refuses a shared one.
 *
 * ## The credential PIN
 *
 * The engine pins the `ref` of the credential its first deciding read used
 * (`credencial.fixar`). From then on BOTH getters re-read the stored credential
 * and refuse, with ZERO requests, when its versioned ref
 * (`refDaCredencial`) differs: `LiCredencialTrocadaError`. So the write, the
 * read that confirms a refused write and the read-backs are made with the
 * deciding read's credential or not at all — a token re-saved between the read
 * and the write can never write onto the other store's order of the same
 * numero. The ref carries the save's stamp, so even the SAME token saved again
 * is another credential here. A park still wins: a parked credential throws
 * `LiContaParadaError` first.
 *
 * ## The check armed before a write
 *
 * The package awaits a getter OUTSIDE the request's deadline, so a slow
 * credential re-read can push a write's request well past the moment the
 * engine decided to send it. The engine therefore ARMS a check
 * (`verificacaoDaEscrita.armar`, the task deadline) right before a write; the
 * write client's getter takes it when it is CALLED — synchronously with that
 * write — and runs it after the re-read, before returning, so a refusal sends
 * nothing. One-shot: the next getter call finds it gone, and the read client
 * never takes it. The engine disarms it once the write settles, so a write the
 * package refused before its getter leaves nothing behind for a later read.
 *
 * Next-free, `db` a parameter, the environment a parameter (`deps.ambiente`).
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  type CredencialLi,
  type LiEscritaClient,
  type LiLeituraClient,
  criarClienteEscritaLi,
  criarClienteLeituraLi,
} from '@delfrance/integrations-loja-integrada';
import { INTEGRACAO_TIPO, type Integracao } from '@delfrance/schemas';

import { lerContaEmCache } from './contaCache';
import { ENVIAR_CORRELATION_ID_LI, credencialUtilizavel } from './contexto';
import { refDaCredencial } from './credencial';
import {
  LiChamadasDesligadasError,
  LiContaInativaError,
  LiContaNaoEncontradaError,
  LiCredencialTrocadaError,
} from './erros';
import { type OpcoesObservadorLi, criarObservadorLi } from './log';
import { type RitmoLi, ritmoDeEscritaLi } from './ritmo';
import { type AmbienteLi, lerChaveDeChamadas, registrarChamadaBloqueadaLi } from './valvulas';

/** The operation name the read switch's refusal line carries. */
export const OPERACAO_CONTEXTO_ESCRITA_LI = 'contexto-escrita';

/** The credential a write run decides under (module header). */
export interface PinoCredencialLi {
  /** The pinned ref, or `null` before the run's first deciding read. */
  fixada(): string | null;
  /**
   * Pin `ref`. Pinning the same ref again is a no-op; pinning ANOTHER is a
   * programming error (`TypeError`): the getters already refuse a different
   * credential, so a second ref can only come from a bug.
   */
  fixar(ref: string): void;
}

/** A check the write client's NEXT credential re-read runs, after it and before the request (module header). */
export interface VerificacaoDaEscritaLi {
  /** Arm `verificar` (it throws to refuse). Arming over an armed check is a programming error (`TypeError`). */
  armar(verificar: () => void): void;
  /** Drop the armed check, if any. */
  desarmar(): void;
}

export interface ContextoEscritaLojaIntegrada {
  readonly integracaoId: string;
  readonly conta: Integracao;
  /** The package's write client. Only the write engine uses it (`estrutura.test.ts`). */
  readonly escrita: LiEscritaClient;
  /** The read client, for the paged situação-history read; paced in its getter. */
  readonly leitura: LiLeituraClient;
  /** The writes pacer, spent by the engine. */
  readonly ritmo: RitmoLi;
  readonly credencial: PinoCredencialLi;
  /** The engine's check before a write — the write client's getter only. */
  readonly verificacaoDaEscrita: VerificacaoDaEscritaLi;
}

export interface ContextoEscritaDeps {
  /** The process environment, as the entry point passes it in — the read switch only. REQUIRED. */
  readonly ambiente: AmbienteLi;
  /** The sleep the writes pacer is bound to (`setTimeout` in production). REQUIRED. */
  readonly esperar: (ms: number) => Promise<void>;
  /** What the logger adds to each call line; `conta` is always this context's id. */
  readonly registro?: Omit<OpcoesObservadorLi, 'conta'>;
  /** Test seams, forwarded as-is. */
  readonly fetch?: typeof globalThis.fetch;
  readonly gerarCorrelationId?: () => string;
}

export async function loadLojaIntegradaContextoEscrita(
  db: Firestore,
  integracaoId: string,
  deps: ContextoEscritaDeps,
): Promise<ContextoEscritaLojaIntegrada> {
  // FIRST: no Firestore read, no client, nothing at all while the switch is off.
  if (!lerChaveDeChamadas(deps.ambiente)) {
    registrarChamadaBloqueadaLi(OPERACAO_CONTEXTO_ESCRITA_LI, deps.ambiente, {
      ...deps.registro,
      conta: integracaoId,
    });
    throw new LiChamadasDesligadasError(integracaoId);
  }

  const conta = await lerContaEmCache(db, integracaoId);
  if (conta === null || conta.tipo !== INTEGRACAO_TIPO.lojaIntegrada) {
    throw new LiContaNaoEncontradaError(integracaoId);
  }
  if (conta.ativo === false) throw new LiContaInativaError(integracaoId);

  // Fail fast: a run that cannot make a single request should not start.
  await credencialUtilizavel(db, integracaoId);

  let refFixada: string | null = null;
  const credencial: PinoCredencialLi = {
    fixada: () => refFixada,
    fixar: (ref) => {
      if (refFixada !== null && refFixada !== ref) {
        throw new TypeError('contextoEscrita: a credencial desta execução já está fixada em outra');
      }
      refFixada = ref;
    },
  };

  // Re-read every time, never the copy read above; refuse a credential other
  // than the pinned one before anything is built from it.
  const credencialAtual = async (): Promise<CredencialLi> => {
    const { credencial: lida } = await credencialUtilizavel(db, integracaoId);
    const ref = refDaCredencial(lida);
    if (refFixada !== null && ref !== refFixada) {
      throw new LiCredencialTrocadaError(integracaoId);
    }
    return { token: lida.personalToken, ref };
  };

  const ritmo = ritmoDeEscritaLi(deps.esperar);

  let verificacaoArmada: (() => void) | null = null;
  const verificacaoDaEscrita: VerificacaoDaEscritaLi = {
    armar: (verificar) => {
      if (verificacaoArmada !== null) {
        throw new TypeError('contextoEscrita: já há uma verificação armada para a próxima escrita');
      }
      verificacaoArmada = verificar;
    },
    desarmar: () => {
      verificacaoArmada = null;
    },
  };

  const escrita = criarClienteEscritaLi({
    // No wait here: the engine paces BEFORE the read that decides a write.
    obterCredencial: async (): Promise<CredencialLi> => {
      // Taken when CALLED — synchronously with the write that armed it — so
      // only that request runs it, after the re-read and before the request.
      const verificar = verificacaoArmada;
      verificacaoArmada = null;
      const credencial = await credencialAtual();
      verificar?.();
      return credencial;
    },
    enviarCorrelationId: ENVIAR_CORRELATION_ID_LI,
    // `conta` LAST: whatever the options carry, the line names this conta.
    onChamada: criarObservadorLi({ ...deps.registro, conta: integracaoId }),
    fetch: deps.fetch,
    gerarCorrelationId: deps.gerarCorrelationId,
  });

  const leitura = criarClienteLeituraLi({
    obterCredencial: async (): Promise<CredencialLi> => {
      // The pacer FIRST, then the read, as in the read context.
      await ritmo.esperar(ritmo.intervaloMs);
      return credencialAtual();
    },
    enviarCorrelationId: ENVIAR_CORRELATION_ID_LI,
    onChamada: criarObservadorLi({ ...deps.registro, conta: integracaoId }),
    fetch: deps.fetch,
    gerarCorrelationId: deps.gerarCorrelationId,
  });

  return { integracaoId, conta, escrita, leitura, ritmo, credencial, verificacaoDaEscrita };
}
