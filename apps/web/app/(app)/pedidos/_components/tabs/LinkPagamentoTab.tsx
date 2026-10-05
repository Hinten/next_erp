'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  CopyButton,
  Group,
  Modal,
  NumberInput,
  SegmentedControl,
  Select,
  SimpleGrid,
  Skeleton,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
  type MantineColor,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { notifications } from '@mantine/notifications';
import {
  IconCash,
  IconCheck,
  IconCopy,
  IconPlus,
  IconRefresh,
  IconTrash,
} from '@tabler/icons-react';
import { PERM } from '@delfrance/auth';
import { dataCivilNoFuso, nowMillis, somarDiasCivis } from '@delfrance/core/datetime';
import { centavosDeReais, formatReais, roundReais } from '@delfrance/core/money';
import { buildQuery, defaultQueryConstraints, orderByField } from '@delfrance/data';
import { useSnapshot, type SnapshotRow } from '@delfrance/data/hooks';
import {
  ESTADO_NFE_LABELS,
  ESTADO_PEDIDO_LABELS,
  FUSO_FISCAL,
  LIMITES_LINK_PAGAMENTO,
  MODO_LINK_PAGAMENTO,
  MOTIVO_RECUSA_LINK,
  MOTIVO_RECUSA_LINK_LABELS,
  PERM_LINK_PAGAMENTO,
  SITUACAO_LINK_PAGAMENTO_LABELS,
  TIPO_INTEGRACAO_PGTO,
  TIPO_PAGAMENTO_MP,
  TIPO_PAGAMENTO_MP_LABELS,
  coberturaDoPedido,
  disponivelParaNovosLinksCentavos,
  estadoAoGerarLinkPagamento,
  linkPagamentoEmAberto,
  linkPgtoMercadoPagoMeta,
  mensagemLinksPagamento,
  mensagemQuemJaPagou,
  metodoPagamentoMeta,
  motivoBloqueioLinkPagamento,
  pagamentosTravadosPorNFe,
  resumirLinksPagamento,
  valorEmAbertoEmLinks,
  valorEmTransitoForaDeLinksAbertos,
  type EstadoNFe,
  type EstadoPedido,
  type LinkPagamentoResumo,
  type LinkPgtoMercadoPago,
  type MetodoPagamento,
  type MotivoRecusaLink,
  type Pagamento,
  type SituacaoLinkPagamento,
  type TipoPagamentoMp,
} from '@delfrance/schemas';

import { CurrencyInput } from '@/app/(app)/produtos/_components/CurrencyInput';
import { CopyIconButton } from '@/components/CopyIconButton';
import { usePermission } from '@/lib/auth';
import { isHttpUrl } from '@/lib/chat/safeUrl';
import { linkPgtoMercadoPagoCollection } from '@/lib/data/linkPgtoMercadoPagoCollection';
import { newDocId } from '@/lib/data/newDocId';
import { metodoPagamentoCollection, pagamentoCollection } from '@/lib/data/pagamentoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { MercadoPagoClientNetworkError, useMercadoPagoClient } from '@/lib/mercado-pago/client';
import {
  showCopyableNotification,
  showErrorNotification,
} from '@/lib/notifications/showErrorNotification';

import { descreverFalhaLink } from './linkPagamentoErros';
import {
  LINK_COMPARTILHADO_HABILITADO,
  MODO_FORM_LINK,
  TIPOS_PAGAMENTO_LINK,
  cotaDoCompartilhado,
  dividirIgualmente,
  divisoesExatas,
  errosSemSoma,
  impressaoDigital,
  linkFormValido,
  modoFormLinkSchema,
  montarCorpoCriar,
  novaPessoa,
  quantidadeDeLinks,
  somaDoFormularioCentavos,
  validarLinkForm,
  valoresIniciaisLinkForm,
  type ErrosLinkForm,
  type LinkFormState,
  type PessoaLinkForm,
} from './linkPagamentoForm';

/**
 * What the pedido editor hands the tab. `pedido` is the LIVE snapshot doc
 * (`EditarPedidoView` re-passes it on every emission), never `form.getValues()`:
 * links are sized against the PERSISTED total and devolução — the numbers the
 * server reconciles against — not the operator's unsaved edits.
 */
export interface LinkPagamentoTabProps {
  pedidoId: string;
  pedido: {
    numero?: string | null;
    estado?: EstadoPedido | null;
    ehSaida?: boolean | null;
    valorCobrado?: number | null;
    itensDevolvidos?: unknown;
    clientePedidoOuterRef?: string | null;
  };
  /** The pedido's live estado (`estadoNow` in the editor). */
  estado: EstadoPedido;
  /** The editor has unsaved changes — a link must never be sized against them. */
  formDirty: boolean;
  /** The pedido snapshot came from the local cache, not the server. */
  fromCache: boolean;
  /** Estado of the pedido's newest NF-e, `null` without one. */
  nfeEstado: EstadoNFe | null;
  /** The NF-e listener has not answered yet (default-deny while it loads). */
  nfeCarregando: boolean;
}

/** How often the clock that turns an open link into an expired one ticks. */
const INTERVALO_RELOGIO_MS = 60_000;

/** Expiry as the operator reads it: pt-BR, in the fiscal zone, never the browser's. */
const FORMATO_EXPIRACAO = new Intl.DateTimeFormat('pt-BR', {
  timeZone: FUSO_FISCAL,
  dateStyle: 'short',
  timeStyle: 'short',
});

const COR_SITUACAO: Record<SituacaoLinkPagamento, MantineColor> = {
  aberto: 'blue',
  parcial: 'yellow',
  pago: 'green',
  estornado: 'orange',
  expirado: 'gray',
  cancelado: 'red',
  legado: 'dark',
};

const OPCOES_DE_MODO = [
  { value: MODO_FORM_LINK.umLink, label: 'Um link' },
  { value: MODO_FORM_LINK.vaquinha, label: 'Vaquinha por pessoa' },
  {
    value: MODO_FORM_LINK.compartilhado,
    label: 'Link compartilhado',
    disabled: !LINK_COMPARTILHADO_HABILITADO,
  },
];

/**
 * The cancel dialog. Deliberately NOT "no payment can arrive any more": a Pix
 * QR or a boleto issued before the cancel may still be paid (Mercado Pago does
 * not confirm that expiring a preference stops them).
 */
const MSG_CONFIRMAR_CANCELAMENTO =
  'Quem abrir o link não conseguirá mais pagar. Pagamentos já iniciados, como um Pix ' +
  'gerado, ainda podem ser concluídos.';

const AVISO_SINCRONIZACAO_TRUNCADA =
  'A busca parou no limite — sincronize de novo para ver o resto.';

const MSG_SEM_GERENCIAR =
  'Requer permissão de escrita em pedidos e pagamentos para gerar, cancelar ou sincronizar links.';

const MSG_SEM_CONTAS =
  'Requer permissão de leitura em meios de pagamento para escolher a conta do Mercado Pago.';

/** The info shown before the button when the first link will move the pedido. */
function avisoDeTravamento(destino: EstadoPedido): string {
  const rotulo = ESTADO_PEDIDO_LABELS[destino];
  return (
    `Ao gerar o primeiro link, o pedido passa para "${rotulo}": itens, frete e devolução ` +
    'ficam bloqueados e o estoque do pedido é reservado.'
  );
}

/** A `metodo_pgto` account that may issue links. The doc may be a raw soft-read. */
function contaHabilitadaParaLink(conta: MetodoPagamento): boolean {
  return (
    conta.tipo === TIPO_INTEGRACAO_PGTO.mercadoPago &&
    conta.hasLinkPagamento === true &&
    conta.user_id != null
  );
}

function nomeDaConta(conta: SnapshotRow<MetodoPagamento>): string {
  const nome: unknown = conta.data.nome;
  return typeof nome === 'string' && nome.trim() !== '' ? nome : conta.id;
}

function formatarExpiracao(ms: number | null): string {
  return ms === null ? '—' : FORMATO_EXPIRACAO.format(ms);
}

function valorDoLink(resumo: LinkPagamentoResumo): string {
  return resumo.modo === MODO_LINK_PAGAMENTO.compartilhado
    ? `${resumo.quantidadeMaxima ?? 1} × ${formatReais(resumo.valor)}`
    : formatReais(resumo.valor);
}

/** Everything that decides whether a NEW link may be requested right now. */
interface EntradaBloqueio {
  formDirty: boolean;
  fromCache: boolean;
  nfeCarregando: boolean;
  nfeEstado: EstadoNFe | null;
  travadoPorNFe: boolean;
  dadosProntos: boolean;
  erroDeLeitura: boolean;
  motivo: MotivoRecusaLink | null;
  estado: EstadoPedido;
  /** Every stored link of the pedido — cancelled, expired and legacy included. */
  linksExistentes: number;
  disponivelCentavos: number;
  /** Part of what is covered is a pending payment on a link that is no longer open. */
  pendenteEmLinksEncerrados: boolean;
  semSessao: boolean;
}

/**
 * The FIRST reason creation is blocked, as operator copy, or `null`. Ordered
 * from what the operator can fix right now (save, wait) to what the pedido
 * itself forbids. The route re-checks every one of these inside its
 * transaction; this is only the notice and the disabled button.
 */
function bloqueioDaCriacao(i: EntradaBloqueio): string | null {
  if (i.formDirty) return 'Há alterações não salvas no pedido. Salve antes de gerar links.';
  if (i.fromCache) return 'Carregando a versão mais recente do pedido…';
  if (i.nfeCarregando) return 'Verificando a NF-e do pedido…';
  if (i.travadoPorNFe) {
    if (i.nfeEstado === null) return MOTIVO_RECUSA_LINK_LABELS.nfe;
    const rotulo = ESTADO_NFE_LABELS[i.nfeEstado];
    return `Links de pagamento bloqueados — a NF-e deste pedido está "${rotulo}".`;
  }
  if (!i.dadosProntos) {
    return i.erroDeLeitura
      ? 'Não foi possível carregar os links e pagamentos do pedido.'
      : 'Carregando links e pagamentos…';
  }
  if (i.motivo === MOTIVO_RECUSA_LINK.estado) {
    const rotulo = ESTADO_PEDIDO_LABELS[i.estado];
    return `${MOTIVO_RECUSA_LINK_LABELS.estado} Estado atual: "${rotulo}".`;
  }
  if (i.motivo !== null) return MOTIVO_RECUSA_LINK_LABELS[i.motivo];
  // The route's `limiteLinks`, in the order it checks it (after the pedido
  // gates, before the exposure): not even one more link fits.
  if (i.linksExistentes >= LIMITES_LINK_PAGAMENTO.linksPorPedidoMax) {
    return MOTIVO_RECUSA_LINK_LABELS.limiteLinks;
  }
  if (i.disponivelCentavos < centavosDeReais(LIMITES_LINK_PAGAMENTO.valorMinimo)) {
    if (i.pendenteEmLinksEncerrados) {
      return (
        'O restante já está coberto por links em aberto e por pagamentos pendentes em links ' +
        'encerrados. Aguarde a confirmação desses pagamentos.'
      );
    }
    return 'O restante já está coberto por links em aberto. Cancele um link para gerar outro.';
  }
  if (i.semSessao) return 'Sessão expirada — entre novamente para gerar links.';
  return null;
}

/**
 * The pedido editor's "Link Pgto" tab (#367): Mercado Pago Checkout Pro links
 * that settle a saída pedido — one link, a per-person vaquinha, or (behind
 * {@link LINK_COMPARTILHADO_HABILITADO}) one link paid N times.
 *
 * The tab never sends anything to the payer: WhatsApp is COPY-only ("Copiar
 * todos os links" / "Copiar quem já pagou"). Every write goes through the
 * `apps/mercado-pago` routes, which re-derive each gate shown here inside a
 * transaction — this component only explains and disables.
 *
 * Money: the summary and the create limit come from the SAME pure helpers the
 * route uses (`coberturaDoPedido`, `disponivelParaNovosLinksCentavos` — restante
 * minus open links minus pending payments on links no longer open), compared in
 * integer cents, so a vaquinha that adds up to "Disponível para novos links" is
 * exactly what the server lets through and exactly what settles the pedido.
 *
 * Ids: every link id is minted HERE (`newDocId`) and reused only for a retry of
 * the same draft after a network failure — the one case where the server may
 * have created the links without us hearing back. Any HTTP answer, or any edit,
 * mints new ones. Such a retry skips the client-side sum check (the route answers
 * `reaproveitado`, or re-checks the exposure itself), and once every id of the
 * unanswered attempt shows up in the links listener the attempt is settled: the
 * draft is cleared and the operator is told the links already exist.
 */
export function LinkPagamentoTab({
  pedidoId,
  pedido,
  estado,
  formDirty,
  fromCache,
  nfeEstado,
  nfeCarregando,
}: LinkPagamentoTabProps) {
  const ler = usePermission(PERM_LINK_PAGAMENTO.ler);
  const gerenciar = usePermission(PERM_LINK_PAGAMENTO.gerenciar);
  const listarContas = usePermission(PERM_LINK_PAGAMENTO.listarContas);
  const reconectar = usePermission(PERM.metodoPagamento.write);
  const client = useMercadoPagoClient();
  const db = useMemo(() => getFirebaseFirestore(), []);

  // A ticking clock: an open link must turn "Expirado" (and stop counting as
  // exposure) while the tab stays open, not only on the next snapshot.
  const [agoraMs, setAgoraMs] = useState(() => nowMillis());
  useEffect(() => {
    const relogio = window.setInterval(() => setAgoraMs(nowMillis()), INTERVALO_RELOGIO_MS);
    return () => window.clearInterval(relogio);
  }, []);
  const hoje = dataCivilNoFuso(agoraMs, FUSO_FISCAL);

  // Each listener exists only when its read bit does — a denied listener would
  // surface as a permission-denied error instead of the hint below.
  const podeLer = ler.allowed;
  const podeListarContas = listarContas.allowed;
  const linksQuery = useMemo(
    () =>
      podeLer
        ? buildQuery(
            linkPgtoMercadoPagoCollection.ref(db, { pedidoId }),
            defaultQueryConstraints(linkPgtoMercadoPagoMeta.defaultQuery!),
          )
        : null,
    [db, pedidoId, podeLer],
  );
  // The SAME shape as PedidoFooter / PagamentosSection, so the SDK shares one watch.
  const pagamentosQuery = useMemo(
    () =>
      podeLer
        ? buildQuery(pagamentoCollection.ref(db, { pedidoId }), [
            orderByField('dataCadastro', 'desc'),
          ])
        : null,
    [db, pedidoId, podeLer],
  );
  // The indexed defaultQuery, filtered CLIENT-side: `hasLinkPagamento` / `user_id`
  // filters in the query would be an unindexed Enterprise scan.
  const contasQuery = useMemo(
    () =>
      podeListarContas
        ? buildQuery(
            metodoPagamentoCollection.ref(db, {}),
            defaultQueryConstraints(metodoPagamentoMeta.defaultQuery!),
          )
        : null,
    [db, podeListarContas],
  );
  const links = useSnapshot<LinkPgtoMercadoPago>(linksQuery);
  const pagamentos = useSnapshot<Pagamento>(pagamentosQuery);
  const contas = useSnapshot<MetodoPagamento>(contasQuery);

  const temCliente =
    typeof pedido.clientePedidoOuterRef === 'string' && pedido.clientePedidoOuterRef.trim() !== '';
  const [form, setForm] = useState<LinkFormState>(() =>
    valoresIniciaisLinkForm(dataCivilNoFuso(nowMillis(), FUSO_FISCAL), null, temCliente),
  );
  const [mostrarErros, setMostrarErros] = useState(false);
  const [criando, setCriando] = useState(false);
  const [sincronizando, setSincronizando] = useState(false);
  const [alvoCancelamento, setAlvoCancelamento] = useState<LinkPagamentoResumo | null>(null);
  const [cancelando, setCancelando] = useState(false);
  // The ids of the last request, keyed by the draft's fingerprint. Kept only
  // across a NETWORK failure (see the component docblock).
  const tentativa = useRef<{ impressao: string; linkIds: string[] } | null>(null);

  /* ------------------------------ derived data ----------------------------- */

  const resumos = resumirLinksPagamento({
    links: links.data ?? [],
    pagamentos: pagamentos.data ?? [],
    agoraMs,
  });
  const cobertura = coberturaDoPedido(
    {
      valorCobrado: pedido.valorCobrado,
      ehSaida: pedido.ehSaida,
      itensDevolvidos: pedido.itensDevolvidos,
    },
    (pagamentos.data ?? []).map((row) => row.data),
  );
  const emAberto = valorEmAbertoEmLinks(resumos);
  const emTransito = valorEmTransitoForaDeLinksAbertos(resumos, pagamentos.data ?? []);
  // The ONE "available for new links" rule — the route's exposure guard refuses
  // above this very figure, so the tab can never offer a batch the server refuses.
  const disponivelCentavos = disponivelParaNovosLinksCentavos({
    restante: cobertura.restante,
    resumos,
    pagamentos: pagamentos.data ?? [],
  });
  const disponivel = roundReais(disponivelCentavos / 100);
  // Every stored link counts against the per-pedido cap, as on the route.
  const linksExistentes = links.data?.length ?? 0;

  const todasContas = contas.data ?? [];
  const nomesDasContas = new Map(todasContas.map((conta) => [conta.id, nomeDaConta(conta)]));
  const elegiveis = todasContas.filter((conta) => contaHabilitadaParaLink(conta.data));
  const contaUnica = elegiveis.length === 1 ? (elegiveis[0]?.id ?? null) : null;
  // The operator's pick while it is still eligible; otherwise the only eligible
  // account (auto-pick), otherwise nothing — DERIVED, so an account disabled
  // meanwhile can never be submitted.
  const metodoIdEfetivo =
    form.metodoId !== null && elegiveis.some((conta) => conta.id === form.metodoId)
      ? form.metodoId
      : contaUnica;
  const formEfetivo: LinkFormState = {
    ...form,
    metodoId: metodoIdEfetivo,
    preencherPagador: form.preencherPagador && temCliente,
  };
  const erros = validarLinkForm(formEfetivo, {
    restanteSemLinkCentavos: disponivelCentavos,
    linksExistentes,
    hoje,
    compartilhadoHabilitado: LINK_COMPARTILHADO_HABILITADO,
  });
  const errosVisiveis: ErrosLinkForm = mostrarErros ? erros : {};

  const travadoPorNFe = pagamentosTravadosPorNFe(nfeEstado, estado);
  const bloqueio = bloqueioDaCriacao({
    formDirty,
    fromCache,
    nfeCarregando,
    nfeEstado,
    travadoPorNFe,
    // A cached emission is not ready either: the IndexedDB copy may predate a
    // link or a payment the server already has, and sizing a link against it is
    // exactly the overpayment the exposure rule exists to prevent.
    dadosProntos:
      links.data !== undefined &&
      pagamentos.data !== undefined &&
      links.fromCache !== true &&
      pagamentos.fromCache !== true,
    erroDeLeitura: links.error !== undefined || pagamentos.error !== undefined,
    motivo: motivoBloqueioLinkPagamento({
      ehSaida: pedido.ehSaida,
      estado,
      // The route enforces the channel (it reads the integração in its
      // transaction); the tab has no integração to judge it with.
      canalMarketplace: false,
      pagamentosTravadosPorNFe: travadoPorNFe,
      restante: cobertura.restante,
    }),
    estado,
    linksExistentes,
    disponivelCentavos,
    pendenteEmLinksEncerrados: centavosDeReais(emTransito) > 0,
    semSessao: client === null,
  });
  const estadoAposGerar = estadoAoGerarLinkPagamento(estado);

  // ⚠️ Every situação is derived from the pagamentos. Until they are known
  // (loading, or the listener failed) `resumos` was built on NONE: a paid link
  // whose stored status is still `aberto` would read Aberto — with a live
  // Cancelar and a place in "Copiar todos os links" — and an auto-closed one
  // Estornado. The list and both messages wait instead of guessing.
  const pagamentosConhecidos = pagamentos.data !== undefined;
  const mensagemLinks = pagamentosConhecidos
    ? mensagemLinksPagamento({
        numeroPedido: pedido.numero ?? null,
        resumos,
        fuso: FUSO_FISCAL,
      })
    : null;
  const mensagemPagantes = pagamentosConhecidos
    ? mensagemQuemJaPagou({ numeroPedido: pedido.numero ?? null, resumos })
    : null;

  // For a sync failure that needs a reconnect: the account of the pedido's
  // links when there is exactly one, else the account picked in the form.
  const contasDosLinks = new Set(
    resumos.flatMap((resumo) => (resumo.contaId === null ? [] : [resumo.contaId])),
  );
  const contaDosLinks = contasDosLinks.size === 1 ? ([...contasDosLinks][0] ?? null) : null;

  // A request that got NO answer may still have been created — the connection
  // dropped after the server committed. Once EVERY id of that attempt shows up in
  // the links listener it did land: the draft is done, and a replay would only be
  // answered `reaproveitado`. Skipped while a request is in flight, whose own
  // answer settles the draft (the listener often beats the HTTP response).
  const linksLidos = links.data;
  useEffect(() => {
    const anterior = tentativa.current;
    if (anterior === null || criando || linksLidos === undefined) return;
    const gravados = new Set(linksLidos.map((row) => row.id));
    if (!anterior.linkIds.every((id) => gravados.has(id))) return;
    tentativa.current = null;
    // Syncing the draft to an external system (the links listener), guarded by
    // the attempt ref so it converges.
    setForm((atual) => ({
      ...valoresIniciaisLinkForm(hoje, metodoIdEfetivo, temCliente),
      modo: atual.modo,
    }));
    setMostrarErros(false);
    notifications.show({ color: 'blue', message: 'Os links já foram gerados.' });
  }, [linksLidos, criando, hoje, metodoIdEfetivo, temCliente]);

  /* -------------------------------- actions -------------------------------- */

  async function gerarLinks() {
    if (client === null || bloqueio !== null || criando) return;
    setMostrarErros(true);

    const impressao = impressaoDigital(formEfetivo);
    const quantidade = quantidadeDeLinks(formEfetivo);
    const anterior = tentativa.current;
    // An EXACT replay of an unanswered request keeps its ids — and skips the sum
    // check: if that request did create the links, they now count against the
    // available figure and the check would refuse the replay of its own batch,
    // while the route answers `reaproveitado` (or re-checks the exposure itself).
    const idsDoReplay =
      anterior?.impressao === impressao && anterior.linkIds.length === quantidade
        ? anterior.linkIds
        : null;
    if (!linkFormValido(idsDoReplay === null ? erros : errosSemSoma(erros))) return;
    const linkIds = idsDoReplay ?? Array.from({ length: quantidade }, () => newDocId());
    tentativa.current = { impressao, linkIds };
    const corpo = montarCorpoCriar(formEfetivo, {
      pedidoId,
      valorCobradoEsperado: cobertura.valorCobrado,
      linkIds,
    });

    setCriando(true);
    try {
      const resposta = await client.criarLinks(corpo);
      tentativa.current = null;
      notifications.show({
        color: 'green',
        title: resposta.reaproveitado ? 'Links já existentes' : 'Links gerados',
        message: `${resposta.links.length} link(s) gerado(s).`,
      });
      const modo = form.modo;
      setForm({ ...valoresIniciaisLinkForm(hoje, metodoIdEfetivo, temCliente), modo });
      setMostrarErros(false);
    } catch (err) {
      // Only a request that got NO answer may be replayed with the same ids; any
      // HTTP answer (a 409, a 502 after which the server expired its
      // preferences) means the next attempt is a new request.
      if (!(err instanceof MercadoPagoClientNetworkError)) tentativa.current = null;
      const falha = descreverFalhaLink(err, {
        metodoId: formEfetivo.metodoId,
        podeReconectar: reconectar.allowed,
      });
      if (falha === null) throw err;
      showErrorNotification(falha);
    } finally {
      setCriando(false);
    }
  }

  async function sincronizar() {
    if (client === null || sincronizando) return;
    setSincronizando(true);
    try {
      const resultado = await client.sincronizarLinks({ pedidoId });
      const { encontrados, reconciliados, truncado, falhas } = resultado;
      const texto = `${encontrados} pagamento(s) encontrado(s), ${reconciliados} reconciliado(s).`;
      notifications.show({
        color: 'green',
        title: 'Sincronizado com o Mercado Pago',
        message: truncado ? `${texto} ${AVISO_SINCRONIZACAO_TRUNCADA}` : texto,
      });
      if (falhas.length > 0) {
        showCopyableNotification({
          color: 'yellow',
          title: `${falhas.length} pagamento(s) não sincronizado(s)`,
          message: falhas.map((falha) => `${falha.paymentId}: ${falha.motivo}`).join('\n'),
        });
      }
    } catch (err) {
      const falha = descreverFalhaLink(err, {
        metodoId: contaDosLinks ?? metodoIdEfetivo,
        podeReconectar: reconectar.allowed,
      });
      if (falha === null) throw err;
      showErrorNotification(falha);
    } finally {
      setSincronizando(false);
    }
  }

  async function confirmarCancelamento() {
    const alvo = alvoCancelamento;
    if (client === null || alvo === null || cancelando) return;
    setCancelando(true);
    try {
      await client.cancelarLink({ pedidoId, linkId: alvo.linkId });
      notifications.show({ color: 'green', message: 'Link cancelado.' });
      setAlvoCancelamento(null);
    } catch (err) {
      const falha = descreverFalhaLink(err, {
        metodoId: alvo.contaId,
        podeReconectar: reconectar.allowed,
      });
      if (falha === null) throw err;
      showErrorNotification(falha);
    } finally {
      setCancelando(false);
    }
  }

  function atualizar(patch: Partial<LinkFormState>) {
    setForm((atual) => ({ ...atual, ...patch }));
  }

  function preencherValor() {
    atualizar({ valor: disponivel });
  }

  function preencherTotalCompartilhado() {
    atualizar({ valorTotalCompartilhado: disponivel });
  }

  function escolherModo(valor: string) {
    const lido = modoFormLinkSchema.safeParse(valor);
    if (!lido.success) return;
    atualizar({ modo: lido.data });
    setMostrarErros(false);
  }

  function atualizarPessoa(indice: number, patch: Partial<PessoaLinkForm>) {
    setForm((atual) => ({
      ...atual,
      pessoas: atual.pessoas.map((pessoa, i) => (i === indice ? { ...pessoa, ...patch } : pessoa)),
    }));
  }

  function adicionarPessoa() {
    const chave = newDocId();
    setForm((atual) => ({ ...atual, pessoas: [...atual.pessoas, novaPessoa(chave)] }));
  }

  function removerPessoa(indice: number) {
    setForm((atual) => ({ ...atual, pessoas: atual.pessoas.filter((_, i) => i !== indice) }));
  }

  function dividir() {
    const valores = dividirIgualmente(disponivelCentavos, form.pessoas.length);
    setForm((atual) => ({
      ...atual,
      pessoas: atual.pessoas.map((pessoa, i) => ({ ...pessoa, valor: valores[i] ?? pessoa.valor })),
    }));
  }

  function alternarTipo(tipo: TipoPagamentoMp, aceito: boolean) {
    setForm((atual) => {
      const outros = atual.tiposExcluidos.filter((t) => t !== tipo);
      return { ...atual, tiposExcluidos: aceito ? outros : [...outros, tipo] };
    });
  }

  function mudarParcelas(valor: number | string) {
    const parcelas = typeof valor === 'number' && Number.isFinite(valor) ? Math.trunc(valor) : null;
    atualizar({ parcelasMaximas: parcelas });
  }

  function mudarQuantidade(valor: number | string) {
    const n = typeof valor === 'number' && Number.isFinite(valor) ? Math.trunc(valor) : null;
    atualizar({ quantidade: n });
  }

  /* -------------------------------- render --------------------------------- */

  const podeGerenciar = gerenciar.allowed;
  const somaCentavos = somaDoFormularioCentavos(formEfetivo);
  const somaExcede = somaCentavos !== null && somaCentavos > disponivelCentavos;
  const somaTexto = somaCentavos === null ? '—' : formatReais(somaCentavos / 100);
  const creditoExcluido = form.tiposExcluidos.includes(TIPO_PAGAMENTO_MP.cartaoCredito);
  const ajudaParcelas = creditoExcluido
    ? 'Só vale para cartão de crédito.'
    : 'Vazio = padrão do Mercado Pago.';
  const limiteExpiracao = somarDiasCivis(hoje, LIMITES_LINK_PAGAMENTO.expiracaoDiasMax);
  const cotaCompartilhada = cotaDoCompartilhado(formEfetivo);
  const divisoes = divisoesExatas(centavosDeReais(form.valorTotalCompartilhado ?? 0));
  const opcoesDeConta = elegiveis.map((conta) => ({
    value: conta.id,
    label: nomesDasContas.get(conta.id) ?? conta.id,
  }));

  const resumoFinanceiro = [
    { rotulo: 'Total', valor: cobertura.valorCobrado, testId: 'link-resumo-total' },
    { rotulo: 'Devoluções', valor: cobertura.creditoDevolucao, testId: 'link-resumo-devolucoes' },
    { rotulo: 'Pago', valor: cobertura.valorPago, testId: 'link-resumo-pago' },
    { rotulo: 'Em links abertos', valor: emAberto, testId: 'link-resumo-em-aberto' },
    // Only when there is some: a Pix issued before its link lapsed may still land.
    ...(centavosDeReais(emTransito) > 0
      ? [
          {
            rotulo: 'Pagamentos pendentes em links encerrados',
            valor: emTransito,
            testId: 'link-resumo-em-transito',
          },
        ]
      : []),
    { rotulo: 'Restante', valor: cobertura.restante, testId: 'link-resumo-restante' },
    { rotulo: 'Disponível para novos links', valor: disponivel, testId: 'link-resumo-disponivel' },
  ];

  function camposUmLink(): ReactNode {
    return (
      <>
        <Group grow align="flex-start">
          <CurrencyInput
            label="Valor do link"
            value={form.valor}
            onChange={(valor) => atualizar({ valor })}
            error={errosVisiveis.valor}
            rightSection={<BotaoPreencher valor={disponivel} onPreencher={preencherValor} />}
          />
          <TextInput
            label="Nome do pagador"
            description="Opcional — só o primeiro nome."
            placeholder="Primeiro nome"
            maxLength={LIMITES_LINK_PAGAMENTO.nomePagadorMax}
            value={form.nomePagador}
            onChange={(event) => atualizar({ nomePagador: event.currentTarget.value })}
            error={errosVisiveis.nomePagador}
          />
        </Group>
        {temCliente && (
          <Switch
            label="Preencher dados do cliente no checkout"
            checked={form.preencherPagador}
            onChange={(event) => atualizar({ preencherPagador: event.currentTarget.checked })}
          />
        )}
      </>
    );
  }

  function camposVaquinha(): ReactNode {
    return (
      <Stack gap="xs">
        {form.pessoas.map((pessoa, indice) => (
          <Group key={pessoa.chave} align="flex-start" wrap="nowrap">
            <TextInput
              aria-label={`Nome da pessoa ${indice + 1}`}
              placeholder="Primeiro nome"
              maxLength={LIMITES_LINK_PAGAMENTO.nomePagadorMax}
              value={pessoa.nome}
              onChange={(event) => atualizarPessoa(indice, { nome: event.currentTarget.value })}
              error={errosVisiveis.pessoa?.[indice]?.nome}
              style={{ flex: 1 }}
            />
            <CurrencyInput
              ariaLabel={`Valor da pessoa ${indice + 1}`}
              value={pessoa.valor}
              onChange={(valor) => atualizarPessoa(indice, { valor })}
              error={errosVisiveis.pessoa?.[indice]?.valor}
              style={{ width: 160 }}
            />
            <ActionIcon
              type="button"
              variant="subtle"
              color="red"
              mt={4}
              aria-label={`Remover pessoa ${indice + 1}`}
              disabled={form.pessoas.length <= 1}
              onClick={() => removerPessoa(indice)}
            >
              <IconTrash size={16} />
            </ActionIcon>
          </Group>
        ))}
        {errosVisiveis.pessoas && (
          <Text size="sm" c="red">
            {errosVisiveis.pessoas}
          </Text>
        )}
        <Group gap="xs">
          <Button
            type="button"
            variant="light"
            size="xs"
            leftSection={<IconPlus size={14} />}
            disabled={form.pessoas.length >= LIMITES_LINK_PAGAMENTO.linksPorLoteMax}
            onClick={adicionarPessoa}
          >
            Adicionar pessoa
          </Button>
          <Button
            type="button"
            variant="light"
            size="xs"
            disabled={form.pessoas.length === 0 || disponivelCentavos <= 0}
            onClick={dividir}
          >
            Dividir igualmente
          </Button>
        </Group>
        <Text size="sm" c={somaExcede ? 'red' : 'dimmed'}>
          Soma: {somaTexto} de {formatReais(disponivel)} disponível para novos links.
        </Text>
      </Stack>
    );
  }

  function camposCompartilhado(): ReactNode {
    const detalhe =
      cotaCompartilhada !== null && form.quantidade !== null
        ? `${form.quantidade} × ${formatReais(cotaCompartilhada)}`
        : `Divide exatamente em: ${divisoes.join(', ') || 'nenhuma quantidade'} pagamento(s).`;
    return (
      <>
        <Group grow align="flex-start">
          <CurrencyInput
            label="Valor total"
            ariaLabel="Valor total do link compartilhado"
            value={form.valorTotalCompartilhado}
            onChange={(valor) => atualizar({ valorTotalCompartilhado: valor })}
            error={errosVisiveis.valorTotalCompartilhado}
            rightSection={
              <BotaoPreencher valor={disponivel} onPreencher={preencherTotalCompartilhado} />
            }
          />
          <NumberInput
            label="Quantidade de pagamentos"
            min={2}
            max={LIMITES_LINK_PAGAMENTO.quantidadeMaximaMax}
            allowDecimal={false}
            value={form.quantidade ?? ''}
            onChange={mudarQuantidade}
            error={errosVisiveis.quantidade}
          />
        </Group>
        <Text size="sm" c="dimmed">
          {detalhe}
        </Text>
      </>
    );
  }

  function secaoDeCriacao(): ReactNode {
    if (!gerenciar.loading && !podeGerenciar) {
      return <Alert color="gray">{MSG_SEM_GERENCIAR}</Alert>;
    }
    if (!listarContas.loading && !podeListarContas) {
      return <Alert color="gray">{MSG_SEM_CONTAS}</Alert>;
    }
    if (!podeGerenciar || !podeListarContas) return null;

    const semContas = contas.data !== undefined && elegiveis.length === 0;
    return (
      <Card withBorder padding="md">
        <Stack gap="sm">
          <Title order={5}>Gerar link de pagamento</Title>
          {contas.error && (
            <Alert color="red" title="Não foi possível carregar as contas do Mercado Pago">
              {contas.error.message}
            </Alert>
          )}
          {semContas ? (
            <Alert color="yellow">
              <Stack gap={4}>
                <Text size="sm">Nenhuma conta Mercado Pago habilitada para links.</Text>
                <Anchor component={Link} href="/pagamentos/mercado-pago" size="sm">
                  Configurar contas do Mercado Pago
                </Anchor>
              </Stack>
            </Alert>
          ) : (
            formularioDeCriacao()
          )}
        </Stack>
      </Card>
    );
  }

  function formularioDeCriacao(): ReactNode {
    return (
      <>
        <Stack gap={4}>
          <SegmentedControl value={form.modo} onChange={escolherModo} data={OPCOES_DE_MODO} />
          {!LINK_COMPARTILHADO_HABILITADO && (
            <Text size="xs" c="dimmed">
              Link compartilhado: aguardando validação com o Mercado Pago.
            </Text>
          )}
        </Stack>

        <Select
          label="Conta Mercado Pago"
          placeholder={contas.loading ? 'Carregando contas…' : 'Escolha a conta'}
          data={opcoesDeConta}
          value={metodoIdEfetivo}
          onChange={(valor) => atualizar({ metodoId: valor })}
          allowDeselect={false}
          error={errosVisiveis.metodoId}
        />

        {form.modo === MODO_FORM_LINK.umLink && camposUmLink()}
        {form.modo === MODO_FORM_LINK.vaquinha && camposVaquinha()}
        {form.modo === MODO_FORM_LINK.compartilhado && camposCompartilhado()}

        <Group grow align="flex-start">
          <DatePickerInput
            label="Expira em"
            description="Expira às 23:59 (horário de Brasília) do dia escolhido."
            valueFormat="DD/MM/YYYY"
            value={form.expiraEm}
            minDate={hoje}
            maxDate={limiteExpiracao ?? undefined}
            onChange={(valor) => {
              if (valor !== null) atualizar({ expiraEm: valor });
            }}
            error={errosVisiveis.expiraEm}
          />
          <NumberInput
            label="Parcelas máx."
            description={ajudaParcelas}
            min={1}
            max={LIMITES_LINK_PAGAMENTO.parcelasMax}
            allowDecimal={false}
            value={form.parcelasMaximas ?? ''}
            disabled={creditoExcluido}
            onChange={mudarParcelas}
            error={errosVisiveis.parcelasMaximas}
          />
        </Group>

        <Stack gap={4}>
          <Text size="sm" fw={500}>
            Formas de pagamento aceitas
          </Text>
          <Group gap="lg">
            {TIPOS_PAGAMENTO_LINK.map((tipo) => (
              <Switch
                key={tipo}
                label={TIPO_PAGAMENTO_MP_LABELS[tipo]}
                checked={!form.tiposExcluidos.includes(tipo)}
                onChange={(event) => alternarTipo(tipo, event.currentTarget.checked)}
              />
            ))}
          </Group>
          {errosVisiveis.tiposExcluidos && (
            <Text size="xs" c="red">
              {errosVisiveis.tiposExcluidos}
            </Text>
          )}
        </Stack>

        {errosVisiveis.modo && <Alert color="red">{errosVisiveis.modo}</Alert>}
        {errosVisiveis.soma && <Alert color="red">{errosVisiveis.soma}</Alert>}
        {errosVisiveis.limiteLinks && <Alert color="red">{errosVisiveis.limiteLinks}</Alert>}
        {bloqueio !== null && <Alert color="yellow">{bloqueio}</Alert>}
        {estadoAposGerar !== null && (
          <Alert color="blue" title="O pedido será travado">
            {avisoDeTravamento(estadoAposGerar)}
          </Alert>
        )}

        <Group justify="flex-end">
          <Button
            type="button"
            loading={criando}
            disabled={bloqueio !== null}
            onClick={() => void gerarLinks()}
          >
            {form.modo === MODO_FORM_LINK.vaquinha ? 'Gerar links' : 'Gerar link'}
          </Button>
        </Group>
      </>
    );
  }

  if (ler.loading) return <Skeleton height={120} />;
  if (!podeLer) {
    return (
      <Alert color="yellow" title="Links de pagamento indisponíveis">
        Requer permissão de leitura em pagamentos.
      </Alert>
    );
  }

  return (
    <Stack gap="md">
      {pagamentos.error && (
        <Alert color="red" title="Não foi possível carregar os pagamentos">
          {pagamentos.error.message}
        </Alert>
      )}
      {pagamentos.data === undefined && !pagamentos.error && <Skeleton height={64} />}
      {pagamentos.data !== undefined && (
        <Card withBorder padding="sm">
          <SimpleGrid cols={{ base: 2, sm: 3, lg: resumoFinanceiro.length }} spacing="sm">
            {resumoFinanceiro.map((item) => (
              <Stack key={item.testId} gap={0}>
                <Text size="xs" c="dimmed">
                  {item.rotulo}
                </Text>
                <Text fw={600} data-testid={item.testId}>
                  {formatReais(item.valor)}
                </Text>
              </Stack>
            ))}
          </SimpleGrid>
        </Card>
      )}

      {secaoDeCriacao()}

      <Stack gap="xs">
        <Group justify="space-between" align="center">
          <Title order={5}>Links gerados</Title>
          <Group gap="xs">
            <BotaoCopiar texto={mensagemLinks} rotulo="Copiar todos os links" />
            <BotaoCopiar texto={mensagemPagantes} rotulo="Copiar quem já pagou" />
            {podeGerenciar && (
              <Button
                type="button"
                variant="default"
                size="xs"
                leftSection={<IconRefresh size={14} />}
                loading={sincronizando}
                disabled={client === null}
                onClick={() => void sincronizar()}
              >
                Sincronizar com Mercado Pago
              </Button>
            )}
          </Group>
        </Group>

        {links.error && (
          <Alert color="red" title="Não foi possível carregar os links">
            {links.error.message}
          </Alert>
        )}
        {(links.data === undefined || pagamentos.data === undefined) &&
          !links.error &&
          !pagamentos.error && <Skeleton height={64} />}
        {links.data !== undefined && resumos.length === 0 && (
          <Text c="dimmed" size="sm">
            Nenhum link de pagamento gerado para este pedido.
          </Text>
        )}
        {pagamentosConhecidos && resumos.length > 0 && (
          <Table.ScrollContainer minWidth={820}>
            <Table striped>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Nome</Table.Th>
                  <Table.Th>Valor</Table.Th>
                  <Table.Th>Conta</Table.Th>
                  <Table.Th>Expira</Table.Th>
                  <Table.Th>Situação</Table.Th>
                  <Table.Th>Pagantes</Table.Th>
                  <Table.Th>Ações</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {resumos.map((resumo) => (
                  <LinhaDoLink
                    key={resumo.linkId}
                    resumo={resumo}
                    nomesDasContas={nomesDasContas}
                    podeCancelar={podeGerenciar && client !== null && linkPagamentoEmAberto(resumo)}
                    onCancelar={() => setAlvoCancelamento(resumo)}
                  />
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Stack>

      <Modal
        opened={alvoCancelamento !== null}
        onClose={() => {
          if (!cancelando) setAlvoCancelamento(null);
        }}
        title="Cancelar link de pagamento"
        centered
      >
        <Stack>
          {alvoCancelamento && (
            <Text size="sm" fw={500}>
              {alvoCancelamento.nomePagador ?? 'Link sem nome'} — {valorDoLink(alvoCancelamento)}
            </Text>
          )}
          <Text size="sm">{MSG_CONFIRMAR_CANCELAMENTO}</Text>
          <Group justify="flex-end">
            <Button
              type="button"
              variant="default"
              disabled={cancelando}
              onClick={() => setAlvoCancelamento(null)}
            >
              Voltar
            </Button>
            <Button
              type="button"
              color="red"
              loading={cancelando}
              onClick={() => void confirmarCancelamento()}
            >
              Confirmar cancelamento
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}

/** The "fill with what is still available" icon inside a money field. */
function BotaoPreencher({ valor, onPreencher }: { valor: number; onPreencher: () => void }) {
  return (
    <Tooltip label={`Preencher com o valor disponível (${formatReais(valor)})`} withArrow>
      <ActionIcon
        type="button"
        variant="subtle"
        aria-label="Preencher com o valor disponível"
        disabled={valor <= 0}
        onClick={onPreencher}
      >
        <IconCash size={16} />
      </ActionIcon>
    </Tooltip>
  );
}

/** A toolbar copy button: a constant accessible name, disabled when there is nothing to copy. */
function BotaoCopiar({ texto, rotulo }: { texto: string | null; rotulo: string }) {
  return (
    <CopyButton value={texto ?? ''} timeout={1500}>
      {({ copied, copy }) => (
        <Button
          type="button"
          variant="light"
          size="xs"
          color={copied ? 'teal' : 'blue'}
          leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
          disabled={texto === null}
          onClick={copy}
        >
          {rotulo}
        </Button>
      )}
    </CopyButton>
  );
}

function LinhaDoLink({
  resumo,
  nomesDasContas,
  podeCancelar,
  onCancelar,
}: {
  resumo: LinkPagamentoResumo;
  /** `metodo_pgto` doc id → name, for every account the operator can read. */
  nomesDasContas: ReadonlyMap<string, string>;
  podeCancelar: boolean;
  onCancelar: () => void;
}) {
  const pagantes = resumo.pagantes.map((pagante) => pagante.nome ?? 'Sem nome').join(', ');
  const nomeConta = resumo.contaId === null ? undefined : nomesDasContas.get(resumo.contaId);
  return (
    <Table.Tr data-testid="link-pagamento-linha">
      <Table.Td>{resumo.nomePagador ?? '—'}</Table.Td>
      <Table.Td>{valorDoLink(resumo)}</Table.Td>
      <Table.Td>{nomeConta ?? '—'}</Table.Td>
      <Table.Td>{formatarExpiracao(resumo.dataExpiracaoMs)}</Table.Td>
      <Table.Td>
        <Badge color={COR_SITUACAO[resumo.situacao]} variant="light">
          {SITUACAO_LINK_PAGAMENTO_LABELS[resumo.situacao]}
        </Badge>
      </Table.Td>
      <Table.Td>{pagantes === '' ? '—' : pagantes}</Table.Td>
      <Table.Td>
        <Group gap={4} wrap="nowrap">
          {resumo.link !== null && <CopyIconButton value={resumo.link} label="Copiar link" />}
          {resumo.link !== null && isHttpUrl(resumo.link) && (
            <Anchor href={resumo.link} target="_blank" rel="noopener noreferrer" size="sm">
              Abrir
            </Anchor>
          )}
          {podeCancelar && (
            <Button
              type="button"
              size="compact-xs"
              variant="subtle"
              color="red"
              onClick={onCancelar}
            >
              Cancelar link
            </Button>
          )}
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}
