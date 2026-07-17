/**
 * Account-health aggregator for a WhatsApp integração — the data behind the
 * "Saúde da conta" card (apps/web). It probes the token, the phone-number node
 * (status / quality / verification), the webhook wiring, and recent inbound
 * activity, and folds them into a fixed list of check rows plus two verdicts
 * (`canSend` / `canReceive`).
 *
 * Resilience contract: EVERY probe failure becomes a check row, NEVER a thrown
 * route error — the route always answers 200 with whatever it could gather. The
 * only exception is `loadWhatsappContext` failing (missing / non-WhatsApp
 * account), which is a genuine 404 and is left to propagate to the route's
 * error mapper. Narrow catches per repo rule 6.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  WhatsAppClient,
  WhatsAppHttpError,
  WhatsAppNetworkError,
  type PhoneNumberStatus,
} from '@delfrance/integrations-whatsapp-cloud-api';
import {
  conversaCollection,
  integracaoCollection,
  notificacoesWhatsappCollection,
} from '@delfrance/data/admin/collections';

import { loadWhatsappContext } from './whatsapp';

export type HealthStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface HealthCheck {
  readonly id: string;
  readonly status: HealthStatus;
  readonly label: string;
  readonly detail: string | null;
  readonly hint: string | null;
}

export interface WhatsappHealth {
  /** Aggregation time (ms since epoch). */
  readonly generatedAt: number;
  /** Whether the account can send: token ok AND phone status ok. */
  readonly canSend: boolean;
  /**
   * Whether the account can receive: `webhook_secret` ok AND the subscription
   * (ok → true, fail → false, skip/indeterminate → null). `null` = unknown
   * (e.g. no WABA id to check the subscription with).
   */
  readonly canReceive: boolean | null;
  readonly checks: HealthCheck[];
}

/** Injectable seams (tests). */
export interface HealthDeps {
  /** Passed to the `WhatsAppClient` for the Graph probes. */
  fetch?: typeof fetch;
  /** Clock (defaults to `Date.now`). */
  now?: () => number;
  /** Env source for the webhook-secret presence check (defaults to process.env). */
  env?: Record<string, string | undefined>;
}

const GRAPH_INVALID_TOKEN_CODE = 190;

/** Whether a Graph HTTP error means the token is dead (401 or error code 190). */
function isReauth(err: WhatsAppHttpError): boolean {
  if (err.status === 401) return true;
  try {
    return (
      (JSON.parse(err.body) as { error?: { code?: unknown } }).error?.code ===
      GRAPH_INVALID_TOKEN_CODE
    );
  } catch (e) {
    if (e instanceof SyntaxError) return false;
    throw e;
  }
}

/** Human relative age for an ms-since-epoch instant, e.g. "há 3 h". */
function formatAge(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'agora há pouco';
  if (min < 60) return `há ${min} min`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.floor(hours / 24);
  return `há ${days} d`;
}

export async function buildWhatsappHealth(
  db: Firestore,
  integracaoId: string,
  deps: HealthDeps = {},
): Promise<WhatsappHealth> {
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;
  const checks: HealthCheck[] = [];
  const push = (c: HealthCheck): void => {
    checks.push(c);
  };

  // A missing / non-WhatsApp account throws WhatsappContaNotConfiguredError →
  // the route maps it to 404. Everything past here is best-effort.
  const ctx = await loadWhatsappContext(db, integracaoId);
  const conta = ctx.conta;
  const phoneNumberId = conta.phoneNumberId;
  const wabaId = conta.waba_id ?? null;
  // Inbound-resolution key: failure docs carry the webhook's
  // `metadata.phone_number_id`, which the pipeline matches against `wa_id`
  // (the documented quirk) — NOT against `phoneNumberId`.
  const waId = conta.wa_id ?? null;

  const cred = await ctx.store.load();
  const client = cred
    ? new WhatsAppClient({
        phoneNumberId: phoneNumberId ?? '',
        accessToken: cred.permanent_token,
        fetch: deps.fetch,
      })
    : null;

  // ---- Single phone-node probe: token + status + quality + verification ----
  let probe: PhoneNumberStatus | null = null;
  let probeErr: 'reauth' | 'graph' | 'network' | null = null;
  if (client && phoneNumberId) {
    try {
      probe = await client.getPhoneNumberStatus();
    } catch (err) {
      if (err instanceof WhatsAppHttpError) {
        probeErr = isReauth(err) ? 'reauth' : 'graph';
      } else if (err instanceof WhatsAppNetworkError) {
        probeErr = 'network';
      } else {
        throw err;
      }
    }
  }

  // token
  if (!cred) {
    push({
      id: 'token',
      status: 'fail',
      label: 'Token',
      detail: 'Nenhum token cadastrado',
      hint: 'Cadastre o token permanente da conta.',
    });
  } else if (probeErr === 'reauth') {
    push({
      id: 'token',
      status: 'fail',
      label: 'Token',
      detail: 'Token inválido — reconecte',
      hint: 'Cadastre um novo token permanente.',
    });
  } else if (probeErr === 'graph' || probeErr === 'network') {
    push({
      id: 'token',
      status: 'warn',
      label: 'Token',
      detail: 'Não foi possível validar o token agora',
      hint: null,
    });
  } else {
    push({ id: 'token', status: 'ok', label: 'Token', detail: 'Token cadastrado', hint: null });
  }

  // phone_status
  if (!phoneNumberId) {
    push({
      id: 'phone_status',
      status: 'skip',
      label: 'Status do número',
      detail: 'Número não configurado',
      hint: 'Preencha o ID do número de telefone.',
    });
  } else if (!probe) {
    push({
      id: 'phone_status',
      status: 'skip',
      label: 'Status do número',
      detail: 'Não foi possível consultar o status',
      hint: null,
    });
  } else {
    const raw = probe.status ?? null;
    if (raw === 'CONNECTED') {
      push({
        id: 'phone_status',
        status: 'ok',
        label: 'Status do número',
        detail: raw,
        hint: null,
      });
    } else {
      push({
        id: 'phone_status',
        status: 'fail',
        label: 'Status do número',
        detail: raw ?? 'desconhecido',
        hint: 'Verifique o número no painel do Meta.',
      });
    }
  }

  // quality
  if (!probe) {
    push({ id: 'quality', status: 'skip', label: 'Qualidade', detail: null, hint: null });
  } else {
    const q = (probe.quality_rating ?? '').toUpperCase();
    // GREEN ok; RED fail; YELLOW / UNKNOWN / NA / anything unexpected → warn.
    const status: HealthStatus = q === 'GREEN' ? 'ok' : q === 'RED' ? 'fail' : 'warn';
    push({
      id: 'quality',
      status,
      label: 'Qualidade',
      detail: probe.quality_rating ?? 'desconhecida',
      hint: status === 'fail' ? 'Qualidade baixa — risco de restrição pelo Meta.' : null,
    });
  }

  // code_verification (+ self-heal the account doc when Graph says VERIFIED)
  if (!probe) {
    push({
      id: 'code_verification',
      status: 'skip',
      label: 'Verificação do número',
      detail: null,
      hint: null,
    });
  } else {
    const cv = probe.code_verification_status ?? null;
    if (cv === 'VERIFIED') {
      push({
        id: 'code_verification',
        status: 'ok',
        label: 'Verificação do número',
        detail: cv,
        hint: null,
      });
      if (conta.verificado !== true) {
        try {
          await integracaoCollection.merge(db, {}, integracaoId, { verificado: true });
        } catch (err) {
          // Best-effort self-heal — a write failure is not a health failure,
          // but it must leave a trace (a persistent failure here means
          // `verificado` never converges).
          if (!(err instanceof Error)) throw err;
          console.error('[whatsapp] health: self-heal de verificado falhou', {
            integracaoId,
            message: err.message,
          });
        }
      }
    } else {
      push({
        id: 'code_verification',
        status: 'warn',
        label: 'Verificação do número',
        detail: cv ?? 'não verificado',
        hint: 'Use a seção "Verificação do número" para confirmar.',
      });
    }
  }

  // webhook_subscription
  if (!wabaId) {
    push({
      id: 'webhook_subscription',
      status: 'skip',
      label: 'Inscrição do webhook',
      detail: 'Preencha o WABA ID',
      hint: 'Informe o WABA ID (conta comercial) para checar a inscrição.',
    });
  } else if (!client) {
    push({
      id: 'webhook_subscription',
      status: 'skip',
      label: 'Inscrição do webhook',
      detail: 'Sem token para consultar',
      hint: null,
    });
  } else {
    try {
      const apps = await client.getSubscribedApps(wabaId);
      if (apps.length > 0) {
        const names = apps
          .map((a) => a.whatsapp_business_api_data?.name)
          .filter((n): n is string => typeof n === 'string' && n.length > 0);
        push({
          id: 'webhook_subscription',
          status: 'ok',
          label: 'Inscrição do webhook',
          detail: names.length > 0 ? names.join(', ') : 'App inscrito',
          hint: null,
        });
      } else {
        push({
          id: 'webhook_subscription',
          status: 'fail',
          label: 'Inscrição do webhook',
          detail: 'Webhook não inscrito',
          hint: 'Registre o callback no painel do Meta.',
        });
      }
    } catch (err) {
      if (err instanceof WhatsAppHttpError || err instanceof WhatsAppNetworkError) {
        push({
          id: 'webhook_subscription',
          status: 'warn',
          label: 'Inscrição do webhook',
          detail: 'Não foi possível consultar a inscrição',
          hint: null,
        });
      } else {
        throw err;
      }
    }
  }

  // webhook_secret (env presence only — never the values)
  const hasAppSecret = Boolean(env.WHATSAPP_APP_SECRET);
  const hasVerifyToken = Boolean(env.WHATSAPP_VERIFY_TOKEN);
  if (hasAppSecret && hasVerifyToken) {
    push({
      id: 'webhook_secret',
      status: 'ok',
      label: 'Segredos do webhook',
      detail: 'WHATSAPP_APP_SECRET e WHATSAPP_VERIFY_TOKEN definidos',
      hint: null,
    });
  } else {
    const missing = [
      hasAppSecret ? null : 'WHATSAPP_APP_SECRET',
      hasVerifyToken ? null : 'WHATSAPP_VERIFY_TOKEN',
    ].filter((m): m is string => m !== null);
    push({
      id: 'webhook_secret',
      status: 'fail',
      label: 'Segredos do webhook',
      detail: `Ausente(s): ${missing.join(', ')}`,
      hint: 'Defina os segredos do webhook no ambiente do backend.',
    });
  }

  // inbound_recent
  try {
    const outerRef = `documents/integracao/${integracaoId}`;
    const snap = await conversaCollection
      .ref(db, {})
      .where('integracaoOuterRef', '==', outerRef)
      .orderBy('ultimaModificacaoIntegracao', 'desc')
      .limit(1)
      .get();
    const first = snap.docs[0];
    if (!first) {
      push({
        id: 'inbound_recent',
        status: 'warn',
        label: 'Recebimento recente',
        detail: 'Nenhuma conversa recebida ainda',
        hint: null,
      });
    } else {
      const raw = first.data() as { ultimaModificacaoIntegracao?: unknown };
      const ms =
        typeof raw.ultimaModificacaoIntegracao === 'number'
          ? raw.ultimaModificacaoIntegracao
          : null;
      push({
        id: 'inbound_recent',
        status: 'ok',
        label: 'Recebimento recente',
        detail: ms != null ? `Última mensagem ${formatAge(ms, now())}` : 'Conversa recebida',
        hint: null,
      });
    }
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    console.error('[whatsapp] health: consulta de conversas falhou', {
      integracaoId,
      message: err.message,
    });
    push({
      id: 'inbound_recent',
      status: 'warn',
      label: 'Recebimento recente',
      detail: 'Não foi possível consultar as conversas',
      hint: null,
    });
  }

  // notificacoes_failed — keyed by `wa_id`: the failure docs' `phoneNumberId`
  // field carries the webhook's `metadata.phone_number_id`, and inbound account
  // resolution matches THAT against `conta.wa_id` (never `conta.phoneNumberId`).
  // A receive-only account (wa_id set, phoneNumberId null) is still counted.
  if (!waId) {
    push({
      id: 'notificacoes_failed',
      status: 'skip',
      label: 'Notificações com falha',
      detail: 'wa_id não configurado',
      hint: 'Preencha o wa_id (id do número do webhook) para checar as falhas.',
    });
  } else {
    try {
      const agg = await notificacoesWhatsappCollection
        .ref(db, {})
        .where('phoneNumberId', '==', waId)
        .where('status', '==', 'failed')
        .count()
        .get();
      const count = agg.data().count;
      if (count > 0) {
        push({
          id: 'notificacoes_failed',
          status: 'warn',
          label: 'Notificações com falha',
          detail: `${count} notificaç${count === 1 ? 'ão' : 'ões'} com falha`,
          hint: 'Verifique o log de notificações / a varredura de reprocessamento.',
        });
      } else {
        push({
          id: 'notificacoes_failed',
          status: 'ok',
          label: 'Notificações com falha',
          detail: 'Sem falhas de processamento',
          hint: null,
        });
      }
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      console.error('[whatsapp] health: contagem de notificações falhou', {
        integracaoId,
        message: err.message,
      });
      push({
        id: 'notificacoes_failed',
        status: 'warn',
        label: 'Notificações com falha',
        detail: 'Não foi possível contar as notificações',
        hint: null,
      });
    }
  }

  // ---- Verdicts ----
  const statusOf = (id: string): HealthStatus => checks.find((c) => c.id === id)?.status ?? 'skip';
  const canSend = statusOf('token') === 'ok' && statusOf('phone_status') === 'ok';
  const secretOk = statusOf('webhook_secret') === 'ok';
  const sub = statusOf('webhook_subscription');
  const canReceive = !secretOk ? false : sub === 'ok' ? true : sub === 'fail' ? false : null;

  return { generatedAt: now(), canSend, canReceive, checks };
}
