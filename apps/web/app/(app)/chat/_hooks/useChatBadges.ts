'use client';

import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { buildQuery, limit, whereArrayContains, whereEqual } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import type { Conversa } from '@delfrance/schemas';
import {
  ESTADO_CONVERSA_EM_RESPOSTA,
  ESTADO_CONVERSA_NAO_RESPONDIDO,
} from '@/lib/chat/conversaConstraints';
import { countAwaitingReply, formatBadgeCount } from '@/lib/chat/badges';
import { lastMensagemQueryOptions, type LastMensagem } from '@/lib/chat/lastMensagemQuery';
import { conversaCollection } from '@/lib/data/conversaCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

/** Legacy parity: both badge streams cap at 10 docs (the "9+" trigger). */
const BADGE_LIMIT = 10;

export interface ChatBadges {
  /** Formatted Pendentes badge ('1'…'9', '9+'), or null when zero/hidden. */
  pendentes: string | null;
  /** Formatted Atendimento badge (conversas awaiting the operator's reply). */
  atendimento: string | null;
}

/**
 * The two inbox tab badges (legacy `MenuLateral` `contadorPendentesStream` /
 * `contadorAtivasStream`), each with its own small live listener:
 *
 *  - **Pendentes**: a live `estadoConversa == 0` count (limit 10), capped "9+".
 *  - **Atendimento**: the operator's in-progress conversas (array-contains uid,
 *    `estadoConversa == 1`, limit 10) whose LAST message is from the customer
 *    (`estadoEnvio == recebido`). The last-message reads go through the SAME
 *    cached query as the tiles (`lastMensagemQueryOptions`), so when the
 *    Atendimento tab is open these are cache hits — no extra fetch.
 */
export function useChatBadges(uid: string | null | undefined): ChatBadges {
  const db = getFirebaseFirestore();

  const pendentesQuery = useMemo(
    () =>
      buildQuery(conversaCollection.ref(db, {}), [
        whereEqual('estadoConversa', ESTADO_CONVERSA_NAO_RESPONDIDO),
        limit(BADGE_LIMIT),
      ]),
    [db],
  );

  const ativasQuery = useMemo(
    () =>
      uid
        ? buildQuery(conversaCollection.ref(db, {}), [
            whereArrayContains('usuarios', uid),
            whereEqual('estadoConversa', ESTADO_CONVERSA_EM_RESPOSTA),
            limit(BADGE_LIMIT),
          ])
        : null,
    [db, uid],
  );

  const pendentes = useSnapshot<Conversa>(pendentesQuery);
  const ativas = useSnapshot<Conversa>(ativasQuery);

  const ativasRows = ativas.data ?? [];
  const lastMsgs = useQueries({
    queries: ativasRows.map((row) => lastMensagemQueryOptions(row.id, row.data.ultima_modificacao)),
  });

  return useMemo(() => {
    const lastData = lastMsgs.map((q) => q.data as LastMensagem | undefined);
    return {
      pendentes: formatBadgeCount(pendentes.data?.length ?? 0),
      atendimento: formatBadgeCount(countAwaitingReply(lastData)),
    };
  }, [pendentes.data, lastMsgs]);
}
