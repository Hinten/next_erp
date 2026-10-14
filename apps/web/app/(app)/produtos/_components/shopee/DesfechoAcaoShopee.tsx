'use client';

import { Alert, Button, Group, List, Stack, Text } from '@mantine/core';
import { parseIsoToMillis } from '@delfrance/core/datetime';
import {
  AGUARDAR_KIT_INCERTO_SHOPEE_MS,
  TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE,
} from '@delfrance/schemas';

import {
  ehFraseDeTerminal,
  formatarInstanteShopee,
  FRASE_RECUSA_SEM_PASSO_SHOPEE,
  textoDoProblemaShopee,
} from '@/lib/shopee/anuncioProduto';
import type {
  AnuncioStatusShopee,
  ItemPublicadoShopee,
  KitPublicadoShopee,
  ProblemaShopee,
  RespostaPublicarShopee,
} from '@/lib/shopee/wire';
import type { AcoesShopee } from './AcoesAnuncioShopee';

/**
 * The last outcome of an action on ONE listing, kept by the editor under the
 * link doc id it addressed (its rule R2) until the next action on that link.
 *
 *  - `status` — the pause/reactivate run's answer (200 even when refused);
 *  - `publicado` — the republish's 200, ordinary listing or native kit;
 *  - `recusado` — the publish 422 (`SHOPEE_PUBLISH_BLOCKED` before any Shopee
 *    write, `SHOPEE_PUBLISH_REJECTED` after one), with its `problemas`;
 *  - `falha` — any other failure, already worded for the operator.
 *
 * A re-verify that succeeds leaves no outcome here: it answers with a toast,
 * and the live link document repaints the block.
 */
export type DesfechoAcaoShopee =
  | { readonly tipo: 'status'; readonly resposta: AnuncioStatusShopee }
  | { readonly tipo: 'publicado'; readonly resposta: RespostaPublicarShopee }
  | {
      readonly tipo: 'recusado';
      /** `true` for the 422 that refused BEFORE any Shopee write. */
      readonly antesDaShopee: boolean;
      /** What exists on Shopee NOW, after a mid-publish refusal. */
      readonly etapa: string | null;
      readonly problemas: readonly ProblemaShopee[];
      /** The backend's own summary — shown only when no row could be read. */
      readonly mensagem: string;
    }
  | { readonly tipo: 'falha'; readonly mensagem: string };

export interface DesfechoAcaoShopeeProps {
  contaId: string;
  linkDocId: string;
  desfecho: DesfechoAcaoShopee;
  acoes: AcoesShopee;
}

/**
 * The outcome of the last action on one listing (`data-testid="shopee-desfecho-<linkDocId>"`),
 * rendered inline in its block.
 *
 * ⚠️ No server sentence written for the terminal is ever shown: a refusal row
 * with an `acao` reads {@link textoDoProblemaShopee}'s copy and offers the
 * button the `acao` names, on the link the `acao` names.
 */
export function DesfechoAcaoShopee({
  contaId,
  linkDocId,
  desfecho,
  acoes,
}: DesfechoAcaoShopeeProps) {
  return (
    <div data-testid={`shopee-desfecho-${linkDocId}`}>
      {desfecho.tipo === 'status' && (
        <DesfechoStatus linkDocId={linkDocId} resposta={desfecho.resposta} />
      )}
      {desfecho.tipo === 'publicado' && <DesfechoPublicado resposta={desfecho.resposta} />}
      {desfecho.tipo === 'recusado' && (
        <DesfechoRecusado
          contaId={contaId}
          linkDocId={linkDocId}
          desfecho={desfecho}
          acoes={acoes}
        />
      )}
      {desfecho.tipo === 'falha' && (
        <Alert color="red" variant="light">
          {semTerminal(desfecho.mensagem)}
        </Alert>
      )}
    </div>
  );
}

/** A backend sentence, unless it is CLI copy — then the neutral stand-in. */
function semTerminal(texto: string): string {
  return ehFraseDeTerminal(texto) ? FRASE_RECUSA_SEM_PASSO_SHOPEE : texto;
}

/** `pausadoAte` (ISO-8601) in São Paulo, or `null` when absent or unreadable. */
function instanteIso(iso: string | null): string | null {
  if (iso === null) return null;
  const ms = parseIsoToMillis(iso);
  return ms === null ? null : formatarInstanteShopee(ms);
}

/**
 * The pause/reactivate answer for THIS link. The run's own per-listing
 * sentence says what Shopee CONFIRMED (never the action requested); a run
 * Shopee's daily quota stopped says until when.
 */
function DesfechoStatus({
  linkDocId,
  resposta,
}: {
  linkDocId: string;
  resposta: AnuncioStatusShopee;
}) {
  // One listing was addressed, so there is at most one row — matched by link,
  // with the first row as the fallback for a backend that echoes none.
  const linha =
    resposta.listings.find((l) => l.linkDocId === linkDocId) ?? resposta.listings[0] ?? null;
  const semAnuncio = resposta.produtosSemAnuncio[0] ?? null;
  const cor =
    linha === null
      ? 'yellow'
      : linha.outcome === 'enviado'
        ? 'green'
        : linha.outcome === 'falha'
          ? 'red'
          : 'yellow';
  const pausaAte = instanteIso(resposta.pausadoAte);
  return (
    <Alert color={cor} variant="light">
      <Text size="sm">
        {semTerminal(linha?.mensagem ?? semAnuncio?.mensagem ?? 'Nenhum anúncio foi alterado.')}
      </Text>
      {pausaAte !== null && (
        <Text size="sm" mt={4}>
          Cota diária da Shopee esgotada até {pausaAte}.
        </Text>
      )}
    </Alert>
  );
}

function DesfechoPublicado({ resposta }: { resposta: RespostaPublicarShopee }) {
  if (resposta.tipo === 'kit') return <DesfechoKit kit={resposta} />;
  return <DesfechoItem item={resposta} />;
}

/** The ordinary listing's 200: what the update changed on Shopee. */
function DesfechoItem({ item }: { item: ItemPublicadoShopee }) {
  const { modelos, fotos, tabelaDeMedidas } = item;
  const linhas = [
    modelos.total > 0
      ? `Variações: ${String(modelos.atualizados)} atualizada(s), ${String(modelos.criados)} criada(s)` +
        (modelos.semFilho > 0
          ? `; ${String(modelos.semFilho)} sem produto correspondente no ERP.`
          : '.')
      : null,
    `Fotos: ${String(fotos.enviadas)} enviada(s), ${String(fotos.reutilizadas)} reaproveitada(s)` +
      (fotos.falhas > 0 ? `; ${String(fotos.falhas)} falharam.` : '.'),
    textoDaTabelaDeMedidas(tabelaDeMedidas),
    item.taxInfoOmitido === null ? null : `Dados fiscais não enviados (${item.taxInfoOmitido}).`,
    item.avisoShopee === null ? null : `A Shopee avisou: ${semTerminal(item.avisoShopee)}`,
  ].filter((l): l is string => l !== null);
  return (
    <Alert color="green" variant="light" title="Anúncio republicado na Shopee">
      <List size="sm" spacing={2}>
        {linhas.map((l) => (
          <List.Item key={l}>{l}</List.Item>
        ))}
      </List>
    </Alert>
  );
}

/** Which size chart actually went out — the publish's own answer, never the tab's guess. */
function textoDaTabelaDeMedidas(t: ItemPublicadoShopee['tabelaDeMedidas']): string {
  if (t.fonte === 'modelo' && t.sizeChartId !== null) {
    return `Tabela de medidas: modelo #${String(t.sizeChartId)}.`;
  }
  if (t.fonte === 'foto') return 'Tabela de medidas: enviada como foto.';
  if (t.fonte === 'nenhuma') {
    return t.avisoObrigatoria
      ? 'Nenhuma tabela de medidas foi enviada — a categoria exige uma.'
      : 'Nenhuma tabela de medidas foi enviada.';
  }
  return `Tabela de medidas: ${t.fonte}.`;
}

const ROTULO_DESFECHO_KIT = {
  criado: 'Kit nativo criado na Shopee',
  retomado: 'Kit nativo retomado na Shopee',
  atualizado: 'Kit nativo atualizado na Shopee',
  incerto: 'A Shopee não confirmou o resultado',
} as const satisfies Record<KitPublicadoShopee['desfecho'], string>;

/**
 * A native kit's 200 (a republish reaches `kit-atualizar`). The avisos are
 * listed by their code; the uncertain outcome only says to wait and re-verify —
 * a plain republish never reaches a create arm, so no identical re-send is owed.
 */
function DesfechoKit({ kit }: { kit: KitPublicadoShopee }) {
  if (kit.desfecho === 'incerto') {
    const minutos = Math.ceil((kit.aguardarMs ?? AGUARDAR_KIT_INCERTO_SHOPEE_MS) / 60_000);
    return (
      <Alert color="yellow" variant="light" title={ROTULO_DESFECHO_KIT.incerto}>
        <Text size="sm">
          Aguarde {minutos} minutos e use &quot;Reverificar&quot; antes de publicar de novo.
        </Text>
      </Alert>
    );
  }
  return (
    <Alert color="green" variant="light" title={ROTULO_DESFECHO_KIT[kit.desfecho]}>
      {kit.avisos.length > 0 && (
        <Text size="sm">Avisos do kit: {kit.avisos.map((a) => a.codigo).join(', ')}.</Text>
      )}
      {kit.avisosResolvidos > 0 && (
        <Text size="sm">{kit.avisosResolvidos} aviso(s) de composição resolvido(s).</Text>
      )}
    </Alert>
  );
}

/**
 * The publish 422: one row per refusal. A row with an `acao` reads the tab's
 * copy and offers the next step on the link the `acao` names:
 *
 *  - `republicar` with a link → "Republicar o vínculo <id>" on THAT link (the
 *    successor of a superseded listing is not the block the refusal sits in);
 *  - `sem-opcoes-de-kit` → a republish of this link, with no kit option;
 *  - every other `tipo` is text: the native-kit arms are not part of this row
 *    of buttons, and an `importar` / `escolher-vinculo` points elsewhere.
 */
function DesfechoRecusado({
  contaId,
  linkDocId,
  desfecho,
  acoes,
}: {
  contaId: string;
  linkDocId: string;
  desfecho: Extract<DesfechoAcaoShopee, { tipo: 'recusado' }>;
  acoes: AcoesShopee;
}) {
  return (
    <Alert
      color="red"
      variant="light"
      title={
        desfecho.antesDaShopee
          ? 'Publicação bloqueada — nada foi enviado à Shopee'
          : 'A Shopee recusou a publicação'
      }
    >
      <Stack gap="xs">
        {desfecho.etapa !== null && <Text size="sm">Na Shopee agora: {desfecho.etapa}.</Text>}
        {desfecho.problemas.length === 0 ? (
          <Text size="sm">{semTerminal(desfecho.mensagem)}</Text>
        ) : (
          desfecho.problemas.map((p, i) => (
            <Stack key={i} gap={4} data-testid={`shopee-problema-${linkDocId}-${String(i)}`}>
              <Text size="sm">{textoDoProblemaShopee(p)}</Text>
              <BotaoDoProblema contaId={contaId} linkDocId={linkDocId} problema={p} acoes={acoes} />
            </Stack>
          ))
        )}
      </Stack>
    </Alert>
  );
}

function BotaoDoProblema({
  contaId,
  linkDocId,
  problema,
  acoes,
}: {
  contaId: string;
  linkDocId: string;
  problema: ProblemaShopee;
  acoes: AcoesShopee;
}) {
  const { acao } = problema;
  if (acao === null || !acoes.permitidas) return null;
  let alvo: string;
  let rotulo: string;
  if (acao.tipo === TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.republicar && acao.linkDocId !== null) {
    alvo = acao.linkDocId;
    rotulo = `Republicar o vínculo ${acao.linkDocId}`;
  } else if (acao.tipo === TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.semOpcoesDeKit) {
    alvo = linkDocId;
    rotulo = 'Republicar sem as opções de kit';
  } else {
    return null;
  }
  return (
    <Group>
      <Button
        type="button"
        size="xs"
        variant="light"
        disabled={acoes.bloqueadas}
        onClick={() => acoes.republicar(contaId, alvo)}
      >
        {rotulo}
      </Button>
    </Group>
  );
}
