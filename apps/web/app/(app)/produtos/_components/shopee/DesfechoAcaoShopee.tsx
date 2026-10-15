'use client';

import { Alert, Button, Group, List, Stack, Text } from '@mantine/core';
import { parseIsoToMillis } from '@delfrance/core/datetime';
import {
  ACAO_STATUS_ANUNCIO,
  AGUARDAR_KIT_INCERTO_SHOPEE_MS,
  TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE,
  podeMoverAnuncioShopee,
} from '@delfrance/schemas';

import {
  ehFraseDeTerminal,
  formatarInstanteShopee,
  FRASE_RECUSA_SEM_PASSO_SHOPEE,
  textoDaEtapaShopee,
  textoDoAvisoKit,
  textoDoProblemaShopee,
  vinculoSubstituidoAlheio,
} from '@/lib/shopee/anuncioProduto';
import type {
  AnuncioStatusShopee,
  ItemPublicadoShopee,
  KitPublicadoShopee,
  ProblemaShopee,
  RespostaPublicarShopee,
} from '@/lib/shopee/wire';
import type { AcoesShopee, ArmaKitShopee } from './AcoesAnuncioShopee';

/**
 * The last outcome of an action on ONE listing, kept by the editor under the
 * link doc id it addressed (its rule R2) until the next action on that link.
 *
 *  - `status` — the pause/reactivate run's answer (200 even when refused);
 *  - `publicado` — the publish's 200: a republish of an ordinary listing or a
 *    native kit, or a recriar / converter that created (or resumed) a kit;
 *  - `recusado` — the publish 422 (`SHOPEE_PUBLISH_BLOCKED` before any Shopee
 *    write, `SHOPEE_PUBLISH_REJECTED` after one), with its `problemas`;
 *  - `falha` — any other failure, already worded for the operator.
 *
 * A re-verify that succeeds leaves no outcome here: it answers with a toast,
 * and the live link document repaints the block. Neither does an UNCERTAIN kit
 * create: that is the conta's own state (the editor's `incertos`), shown with
 * its wait and its "Repetir".
 */
export type DesfechoAcaoShopee =
  | { readonly tipo: 'status'; readonly resposta: AnuncioStatusShopee }
  | { readonly tipo: 'publicado'; readonly resposta: RespostaPublicarShopee }
  | {
      readonly tipo: 'recusado';
      /** `true` for the 422 that refused BEFORE any Shopee write. */
      readonly antesDaShopee: boolean;
      /**
       * WHERE in the publish sequence a mid-publish refusal landed (apps/shopee's
       * `EtapaPublicacao`) — never a channel state, which depends on the arm
       * too. Worded by `textoDaEtapaShopee`; the raw code is never printed.
       */
      readonly etapa: string | null;
      readonly problemas: readonly ProblemaShopee[];
      /** The backend's own summary — shown only when no row could be read. */
      readonly mensagem: string;
      /**
       * The kit create arm the refused request was — what an `informar-principal`
       * row re-opens, on the same link; `null` for any other publish.
       */
      readonly pedidoKit: { readonly arma: ArmaKitShopee; readonly linkDocId: string } | null;
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
      {desfecho.tipo === 'publicado' && (
        <DesfechoPublicado contaId={contaId} resposta={desfecho.resposta} acoes={acoes} />
      )}
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

function DesfechoPublicado({
  contaId,
  resposta,
  acoes,
}: {
  contaId: string;
  resposta: RespostaPublicarShopee;
  acoes: AcoesShopee;
}) {
  if (resposta.tipo === 'kit')
    return <DesfechoKit contaId={contaId} kit={resposta} acoes={acoes} />;
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
 * A native kit's 200: a republish (`kit-atualizar`), or a recriar / converter
 * that created or resumed a kit. Each aviso is worded by
 * {@link textoDoAvisoKit} — the 200 carries the CODE only, and a code this
 * build does not know reads a neutral line naming it. A create also says which
 * link holds the new kit and what became of the listing it replaced.
 *
 * The next step an aviso asks for is a button ({@link passosDoAvisoKit}), on
 * the link the BODY names — the new kit's `linkDocId` or the replaced
 * listing's `antecessor.linkDocId` — never the block the outcome sits in.
 *
 * The uncertain outcome here only says to wait and re-verify: it is the plain
 * republish's (which never reaches a create arm, so no identical re-send is
 * owed). A create's uncertainty is the editor's `incertos`, with its "Repetir".
 */
function DesfechoKit({
  contaId,
  kit,
  acoes,
}: {
  contaId: string;
  kit: KitPublicadoShopee;
  acoes: AcoesShopee;
}) {
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
  const novo =
    kit.arma !== 'kit-atualizar' && kit.linkDocId !== null
      ? `Kit novo: vínculo ${kit.linkDocId}` +
        (kit.itemId === null ? '.' : ` (anúncio ${String(kit.itemId)} na Shopee).`)
      : null;
  const antecessor = kit.antecessor;
  const fraseDoAntecessor =
    antecessor === null
      ? null
      : antecessor.excluido
        ? `O anúncio anterior (vínculo ${antecessor.linkDocId}) foi excluído na Shopee.`
        : antecessor.substituido
          ? `O anúncio anterior (vínculo ${antecessor.linkDocId}) foi marcado como substituído e ` +
            'ainda pode estar vendendo na Shopee.'
          : `O anúncio anterior (vínculo ${antecessor.linkDocId}) não foi alterado.`;
  const passos = acoes.permitidas ? passosDoAvisoKit(kit, contaId, acoes) : [];
  return (
    <Alert
      color={kit.avisos.length > 0 ? 'yellow' : 'green'}
      variant="light"
      title={ROTULO_DESFECHO_KIT[kit.desfecho]}
    >
      <Stack gap={4}>
        {novo !== null && <Text size="sm">{novo}</Text>}
        {fraseDoAntecessor !== null && <Text size="sm">{fraseDoAntecessor}</Text>}
        {kit.avisos.length > 0 && (
          <List size="sm" spacing={2} data-testid="shopee-kit-avisos">
            {kit.avisos.map((a, i) => (
              <List.Item key={`${a.codigo}-${a.produtoId ?? ''}-${String(i)}`}>
                {textoDoAvisoKit(a.codigo)}
                {a.produtoId === null ? '' : ` (produto ${a.produtoId})`}
              </List.Item>
            ))}
          </List>
        )}
        {kit.avisosResolvidos > 0 && (
          <Text size="sm">{kit.avisosResolvidos} aviso(s) de composição resolvido(s).</Text>
        )}
        {passos.length > 0 && (
          <Group gap="xs">
            {passos.map((p) => (
              <BotaoDoPasso key={p.rotulo} contaId={contaId} passo={p} acoes={acoes} />
            ))}
          </Group>
        )}
      </Stack>
    </Alert>
  );
}

/** One next step a refusal row or a kit aviso offers, already bound to its link. */
interface PassoShopee {
  readonly rotulo: string;
  readonly agir: () => void;
  /**
   * A native-kit CREATE (recriar / converter): it also waits out this conta's
   * uncertain create — a second `add_kit_item` before Shopee lists the first is
   * a second kit.
   */
  readonly criaKit: boolean;
}

/**
 * The buttons a kit 200's avisos ask for, one per distinct step:
 *
 *  - `receita-divergente` → recriar the kit the run addressed (`linkDocId`);
 *  - `kit-novo-inativo` → reactivate the NEW kit (`linkDocId`) — only when
 *    `podeMoverAnuncioShopee` allows it on the kit's reading, the predicate the
 *    block's own Reativar and the route's pre-check use (a banned kit is never
 *    relisted, one under review is Shopee's to change) — then recriar the OLD
 *    one (`antecessor.linkDocId`): the old kit is deleted only once the new one
 *    is live;
 *  - `kit-antigo-nao-excluido` → re-verify the OLD listing (`antecessor`);
 *  - every other code is text: its next step is in the ERP or Seller Centre,
 *    or (`kit-alvo-mais-novo`) the body does not say which kit is the old one.
 */
function passosDoAvisoKit(
  kit: KitPublicadoShopee,
  contaId: string,
  acoes: AcoesShopee,
): readonly PassoShopee[] {
  const passos = new Map<string, PassoShopee>();
  const juntar = (p: PassoShopee) => {
    if (!passos.has(p.rotulo)) passos.set(p.rotulo, p);
  };
  const recriar = (alvo: string): PassoShopee => ({
    rotulo: `Recriar o kit do vínculo ${alvo}`,
    agir: () => acoes.abrirKit(contaId, alvo, 'recriar'),
    criaKit: true,
  });
  const novo = kit.linkDocId;
  const antigo = kit.antecessor?.linkDocId ?? null;
  for (const { codigo } of kit.avisos) {
    if (codigo === 'receita-divergente' && novo !== null) juntar(recriar(novo));
    if (codigo === 'kit-novo-inativo') {
      const reativavel = podeMoverAnuncioShopee(
        { item_id: kit.itemId, estadoAnuncio: kit.estadoAnuncio },
        ACAO_STATUS_ANUNCIO.reativar,
      ).pode;
      if (novo !== null && reativavel) {
        juntar({
          rotulo: `Reativar o kit novo (vínculo ${novo})`,
          agir: () => acoes.reativar(contaId, novo),
          criaKit: false,
        });
      }
      if (antigo !== null) juntar(recriar(antigo));
    }
    if (codigo === 'kit-antigo-nao-excluido' && antigo !== null) {
      juntar({
        rotulo: `Reverificar o vínculo ${antigo}`,
        agir: () => acoes.reverificar(contaId, antigo),
        criaKit: false,
      });
    }
  }
  return [...passos.values()];
}

/** The button of one {@link PassoShopee}: disabled with every write button, and a create also by the wait. */
function BotaoDoPasso({
  contaId,
  passo,
  acoes,
}: {
  contaId: string;
  passo: PassoShopee;
  acoes: AcoesShopee;
}) {
  const esperando = passo.criaKit && (acoes.incertoDe(contaId)?.pendente ?? false);
  return (
    <Button
      type="button"
      size="xs"
      variant="light"
      disabled={acoes.bloqueadas || esperando}
      onClick={passo.agir}
    >
      {passo.rotulo}
    </Button>
  );
}

/**
 * The publish 422: one row per refusal. A row with an `acao` reads the tab's
 * copy and offers the next step on the link the `acao` names:
 *
 *  - `republicar` with a link → "Republicar o vínculo <id>" on THAT link, the
 *    successor — when the row is about the block itself (the dispatcher's
 *    case). A row about ANOTHER superseded link (a kit create's duplicate scan
 *    found K's old kit still live, `vinculoSubstituidoAlheio`) offers "Recriar
 *    o kit do vínculo <antigo>" instead, the retry of its delete: republishing
 *    the successor — often the very block — cannot clear it;
 *  - `sem-opcoes-de-kit` → a republish of this link, with no kit option;
 *  - `recriar` → the Recriar confirmation for the link the `acao` names (a
 *    removed native kit is not necessarily the block the refusal sits in);
 *  - `informar-principal` → the SAME kit arm's confirmation again, its cursor on
 *    the principal pick — only after a recriar / converter (a plain republish
 *    never sends a principal, so it has nothing to re-open);
 *  - `importar` / `escolher-vinculo` → text: they point elsewhere.
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
        {desfecho.etapa !== null && <Text size="sm">{textoDaEtapaShopee(desfecho.etapa)}</Text>}
        {desfecho.problemas.length === 0 ? (
          <Text size="sm">{semTerminal(desfecho.mensagem)}</Text>
        ) : (
          desfecho.problemas.map((p, i) => (
            <Stack key={i} gap={4} data-testid={`shopee-problema-${linkDocId}-${String(i)}`}>
              <Text size="sm">{textoDoProblemaShopee(p, linkDocId)}</Text>
              <BotaoDoProblema
                contaId={contaId}
                linkDocId={linkDocId}
                problema={p}
                pedidoKit={desfecho.pedidoKit}
                acoes={acoes}
              />
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
  pedidoKit,
  acoes,
}: {
  contaId: string;
  linkDocId: string;
  problema: ProblemaShopee;
  pedidoKit: Extract<DesfechoAcaoShopee, { tipo: 'recusado' }>['pedidoKit'];
  acoes: AcoesShopee;
}) {
  const { acao } = problema;
  if (acao === null || !acoes.permitidas) return null;
  let passo: PassoShopee;
  const antigo = vinculoSubstituidoAlheio(acao, linkDocId);
  if (antigo !== null) {
    passo = {
      rotulo: `Recriar o kit do vínculo ${antigo}`,
      agir: () => acoes.abrirKit(contaId, antigo, 'recriar'),
      criaKit: true,
    };
  } else if (
    acao.tipo === TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.republicar &&
    acao.linkDocId !== null
  ) {
    const alvo = acao.linkDocId;
    passo = {
      rotulo: `Republicar o vínculo ${alvo}`,
      agir: () => acoes.republicar(contaId, alvo),
      criaKit: false,
    };
  } else if (acao.tipo === TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.semOpcoesDeKit) {
    passo = {
      rotulo: 'Republicar sem as opções de kit',
      agir: () => acoes.republicar(contaId, linkDocId),
      criaKit: false,
    };
  } else if (acao.tipo === TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.recriar) {
    const alvo = acao.linkDocId;
    passo = {
      rotulo: `Recriar o kit do vínculo ${alvo}`,
      agir: () => acoes.abrirKit(contaId, alvo, 'recriar'),
      criaKit: true,
    };
  } else if (
    acao.tipo === TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.informarPrincipal &&
    pedidoKit !== null
  ) {
    passo = {
      rotulo: 'Escolher o componente principal',
      agir: () => acoes.abrirKit(contaId, pedidoKit.linkDocId, pedidoKit.arma, true),
      criaKit: true,
    };
  } else {
    return null;
  }
  return (
    <Group>
      <BotaoDoPasso contaId={contaId} passo={passo} acoes={acoes} />
    </Group>
  );
}
