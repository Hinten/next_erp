'use client';

import { useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { notifications } from '@mantine/notifications';

/**
 * Toast the outcome of a channel's OAuth callback (`?<chave>=connected|error&reason=…`).
 *
 * Every channel backend redirects the browser back here with a `reason` slug after a
 * connect attempt. The three channels used to interpolate that slug raw — the user
 * saw "Falha ao conectar a conta X (exchange)." with no next step — and each carried
 * its own copy of this effect.
 *
 * Lives in `lib/` rather than beside any one channel because the three sit in three
 * different sections (`canais/`, `pagamentos/`, `logistica/`), so no channel folder
 * is a neutral home. The per-channel slug→message maps stay local to their channel;
 * only the mechanism is shared. Unlike the backends — where each app keeps private
 * copies of shared helpers so they deploy independently — apps/web is a single
 * deployable, so that justification for duplication does not apply here.
 */
export interface OAuthCallbackToastConfig {
  /** The query-string key the channel's callback sets: `ml`, `me`, `mp`. */
  readonly chave: string;
  /** Shown on success. */
  readonly sucesso: string;
  /** Title of the error notification. */
  readonly tituloErro: string;
  /** `reason` slug → an actionable pt-BR message. */
  readonly mensagens: Readonly<Record<string, string>>;
}

/**
 * ⚠️ `reason` arrives in the URL, so it is untrusted input. React escapes it, but an
 * unrecognised slug is still echoed only when it looks like one of ours — an
 * arbitrary query string must never be reflected into the UI verbatim.
 */
const SLUG_SEGURO = /^[a-z_]{1,32}$/;

export function oauthCallbackMessage(
  reason: string | null,
  mensagens: Readonly<Record<string, string>>,
): string {
  // `Object.hasOwn` (not a bare index read) because the maps are plain object
  // literals: `mensagens.constructor` resolves to an inherited FUNCTION, which is
  // truthy, so a `?reason=constructor` would be returned as the message and render
  // an empty red toast instead of the unknown-reason fallback. The slug alphabet
  // does not save us — the lookup happens before it, and `constructor`/`__proto__`
  // both match `SLUG_SEGURO` anyway.
  const conhecido =
    reason !== null && Object.hasOwn(mensagens, reason) ? mensagens[reason] : undefined;
  if (conhecido) return conhecido;
  return reason && SLUG_SEGURO.test(reason)
    ? `Motivo não reconhecido (${reason}).`
    : 'Motivo não informado.';
}

export function useOAuthCallbackToast(config: OAuthCallbackToastConfig): void {
  const searchParams = useSearchParams();
  const { chave, sucesso, tituloErro, mensagens } = config;

  // ⚠️ Read in render and keyed on the VALUES, never on `searchParams` itself.
  // Every URL change hands back a NEW params object, and the list pages that
  // mount this hook also mount a TableView, which mirrors its sort / filter /
  // page into the query string while keeping every foreign key — so
  // `?ml=error&reason=bad_state` became `…&sort=nome` and an effect keyed on
  // the object re-showed the same failure on the first sort click, and on every
  // one after it. Two strings compare by value, so the toast re-fires only when
  // the callback result itself changes.
  const estado = searchParams.get(chave);
  const reason = searchParams.get('reason');

  useEffect(() => {
    if (estado === 'connected') {
      notifications.show({ color: 'green', message: sucesso });
      return;
    }
    if (estado !== 'error') return;
    notifications.show({
      color: 'red',
      title: tituloErro,
      message: oauthCallbackMessage(reason, mensagens),
    });
  }, [estado, reason, sucesso, tituloErro, mensagens]);
}
