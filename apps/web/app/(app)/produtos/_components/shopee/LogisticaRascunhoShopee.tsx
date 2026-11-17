'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Checkbox,
  Group,
  Loader,
  SegmentedControl,
  Stack,
  Switch,
  Text,
} from '@mantine/core';
import { FirebaseError } from 'firebase/app';
import { CAMPO_RASCUNHO_SHOPEE, type CanalLogisticaRascunhoShopee } from '@delfrance/schemas';

import {
  FRASE_LOGISTICA_RASCUNHO_SHOPEE,
  linhaDoCanalSomenteLeituraShopee,
} from '@/lib/shopee/anuncioProduto';
import {
  ShopeeClientHttpError,
  ShopeeClientNetworkError,
  useShopeeClient,
  type ShopeeClient,
} from '@/lib/shopee/client';
import { descreverFalhaShopee, shopeeQueryRetry } from '@/lib/shopee/erros';
import {
  MODO_LOGISTICA_SHOPEE,
  MOTIVO_DA_LOGISTICA_INVALIDA_SHOPEE,
  algumLigadoDisponivelShopee,
  canaisGravadosForaDaLojaShopee,
  chaveCanaisShopee,
  comCanalShopee,
  escolhaAoEscolherCanaisShopee,
  freteGratisTravadoShopee,
  interruptorTravadoShopee,
  linhasDaLogisticaShopee,
  mesmaChaveCanaisShopee,
  modoDaLogisticaShopee,
  type CanalForaDaLojaShopee,
  type LinhaLogisticaShopee,
  type MotivoDaLogisticaInvalidaShopee,
  type MudancaDoCanalShopee,
} from '@/lib/shopee/logisticaRascunho';
import {
  MOTIVO_INDISPONIVEL_CANAL_SHOPEE,
  type MotivoIndisponivelCanalShopee,
  type RespostaCanaisShopee,
} from '@/lib/shopee/wire';

import { idDoCampoRascunhoShopee } from './DesfechoAcaoShopee';
import { semEnviarOFormularioDoProduto } from './semEnviarOFormularioDoProduto';

/** One channel of the draft's logistics value — the form's and the projection's shape. */
type Canal = CanalLogisticaRascunhoShopee;

/* -------------------------------------------------------------------------- */
/*                                    Props                                    */
/* -------------------------------------------------------------------------- */

export interface LogisticaRascunhoShopeeProps {
  /** The draft's link doc id — the test ids' and the field id's suffix; supplied by `RascunhoShopee`. */
  linkDocId: string;
  /** The conta (`integracao` id) the channels are read for; `null` = the draft's tab names no conta document that can answer — then NO read and no control, the stored channels as plain lines. */
  contaId: string | null;
  /** The produto whose STORED weight and measures the route checks each channel against. */
  produtoId: string;
  /** The STORED produto's `ultimaModificacao` (`null` while unknown) — in the read's key, so a produto save reads the channels again (D16-10). */
  revisaoDoProduto: number | null;
  /** The FORM's channel list (`bloco.valores.logistic_info`); `null` = «Automática». */
  valor: readonly Canal[] | null;
  /** The HELD projection's list (`bloco.logisticaGravada`): «Escolher canais» over it puts it back at once (D16-2). */
  guardada: readonly Canal[] | null;
  /** A draft not saved yet (`bloco.novo`): its channels are chosen after the first save (D-13) — no control, no read. */
  novo: boolean;
  /** The STORED draft keeps a list the ERP never stamped (`bloco.logisticaDoSistemaAnterior`) — the banner. */
  logisticaDoSistemaAnterior: boolean;
  /** The PLAN's verdict on the field (`bloco.logisticaInvalida`) — the zero-ON sentence reads it, never the value (#1369). */
  logisticaInvalida: MotivoDaLogisticaInvalidaShopee | null;
  /** The block takes a logistics edit now (`bloco.logisticaEditavel`); `false` ⇒ every control DISABLED, never removed (D16-12). */
  editavel: boolean;
  /** The new form value; `RascunhoShopee` forwards it as `onCampo('logistic_info', valor)`. */
  onMudar: (valor: readonly Canal[] | null) => void;
}

/* -------------------------------------------------------------------------- */
/*                         Copy (design-C-LOG §5.3, P16 §7)                    */
/* -------------------------------------------------------------------------- */

/** The section's title — and the accessible name of its mode picker. */
export const ROTULO_LOGISTICA_RASCUNHO_SHOPEE = 'Logística (canais de envio)';

/** The mode of a draft that stores no channel list: the publish picks the channels. */
export const ROTULO_LOGISTICA_AUTOMATICA_SHOPEE = 'Automática';

/** The mode in which the draft names its channels. */
export const ROTULO_ESCOLHER_CANAIS_SHOPEE = 'Escolher canais';

/** A draft not saved yet: why it offers no channel choice (D-13). */
export const FRASE_SALVE_PARA_ESCOLHER_CANAIS_SHOPEE =
  'Salve o rascunho para escolher os canais de envio.';

/** The STORED draft keeps the previous system's channel list (unstamped): the publish ignores it. */
export const FRASE_LOGISTICA_DO_SISTEMA_ANTERIOR_SHOPEE =
  'Este rascunho guarda canais de envio do sistema anterior, que nunca foram enviados à Shopee. ' +
  'A publicação não os usa — vale a escolha automática. Para escolher os canais deste anúncio, ' +
  'use «Escolher canais» e salve o rascunho.';

/** «Escolher canais»'s intro. «Oferece frete grátis» is the produto field's own label. */
export const FRASE_CANAIS_ESCOLHIDOS_SHOPEE =
  'Só os canais ligados abaixo vão na publicação. O frete grátis vale por canal: a opção ' +
  '«Oferece frete grátis» do produto não vale para este anúncio.';

/** The basis of every fit verdict: the route reads the STORED produto. */
export const FRASE_BASE_DA_CONFERENCIA_CANAIS_SHOPEE =
  'Conferido com o peso e as medidas salvos do produto.';

/** `medidasCompletas: false` — the stored produto lacks its weight or a dimension. */
export const FRASE_MEDIDAS_INCOMPLETAS_CANAIS_SHOPEE =
  'Cadastre o peso e as três medidas do produto e salve-o para o ERP conferir em quais canais o ' +
  'pacote cabe.';

/** The read is on its way. */
export const FRASE_LENDO_CANAIS_SHOPEE = 'Lendo os canais de envio da loja na Shopee…';

/** A failed read with no sentence of its own — the `desconhecido` of `descreverFalhaShopee`. */
export const FRASE_FALHA_CANAIS_SHOPEE =
  'Não foi possível ler os canais de envio da loja na Shopee.';

/** The retry of a failed read (the same form's category suggestions say it too). */
export const ROTULO_TENTAR_DE_NOVO_CANAIS_SHOPEE = 'Tentar de novo';

/** The shop answers no selectable channel at all. */
export const FRASE_SEM_CANAL_SELECIONAVEL_SHOPEE =
  'A loja não tem nenhum canal de envio ativo na Shopee. Ative um canal no Seller Centre.';

/** A channel row's switch. */
export const ROTULO_CANAL_LIGADO_SHOPEE = 'Ligado';

/** A channel row's free-shipping checkbox. */
export const ROTULO_FRETE_GRATIS_CANAL_SHOPEE =
  'Frete grátis para o comprador (pago pelo vendedor)';

/** `bloqueiaFreteGratisDoVendedor` — the checkbox is disabled and unchecked. */
export const FRASE_FRETE_GRATIS_BLOQUEADO_SHOPEE =
  'A loja não permite frete grátis pago pelo vendedor neste canal.';

/** `obrigatorio` — the switch is locked ON; true for every value this section writes (D16-3). */
export const FRASE_CANAL_OBRIGATORIO_SHOPEE = 'Obrigatório nesta loja: fica sempre ligado.';

/** Why a selectable channel cannot take this produto — one sentence per DTO verdict. */
export const FRASE_INDISPONIVEL_CANAL_SHOPEE = {
  [MOTIVO_INDISPONIVEL_CANAL_SHOPEE.naoCabe]:
    'O pacote do produto não cabe neste canal (peso ou medidas).',
  [MOTIVO_INDISPONIVEL_CANAL_SHOPEE.limiteIlegivel]:
    'A Shopee informou os limites deste canal numa unidade que o ERP não conhece: ele não vai na ' +
    'publicação.',
  [MOTIVO_INDISPONIVEL_CANAL_SHOPEE.exigeValorDoSellerCentre]:
    'Este canal pede um tamanho ou uma tarifa que só o Seller Centre define: o ERP não o envia.',
} as const satisfies Record<MotivoIndisponivelCanalShopee, string>;

/** An ON row that is unavailable: this prefix, then the reason. */
export const PREFIXO_LIGADO_INDISPONIVEL_SHOPEE = 'Ligado, mas não vai na publicação: ';

/** A channel's name: the DTO's, else its id (`nome: null`). */
export function rotuloDoCanalLogisticaShopee(logisticId: number, nome: string | null): string {
  return nome ?? `Canal ${String(logisticId)}`;
}

/**
 * The stored channels with no row (D16-17): each named as its row would be,
 * joined by «, ».
 */
export function fraseDosCanaisForaDaLojaShopee(lista: readonly CanalForaDaLojaShopee[]): string {
  const nomes = lista.map((c) => rotuloDoCanalLogisticaShopee(c.logisticId, c.nome)).join(', ');
  return `Canais gravados que a loja não oferece mais (não vão na publicação e saem da lista ao salvar): ${nomes}.`;
}

/** The plan refuses a list with no channel ON (`logisticaInvalida: 'sem-canal-ligado'`). */
export const FRASE_NENHUM_CANAL_LIGADO_SHOPEE =
  'Ligue ao menos um canal — ou volte para «Automática».';

/** No ON row is available today — a warning, never a block (Lucas 2026-11-16, QC(a): no prediction of the publish). */
export const FRASE_NENHUM_CANAL_LIGADO_DISPONIVEL_SHOPEE =
  'Nenhum canal ligado aceita o pacote hoje.';

/* -------------------------------------------------------------------------- */
/*                                  The read                                   */
/* -------------------------------------------------------------------------- */

/**
 * «Escolher canais»'s read, narrowed (rule 6): a failure the client raises —
 * `ShopeeClientHttpError` (its `RespostaInvalida` subclass included),
 * `ShopeeClientNetworkError`, or the `FirebaseError` of `getAuthToken()`,
 * which the client deliberately leaves outside its try — answers `null`: the
 * same key's observer is already showing it. Anything else is a bug and is
 * rethrown.
 */
export async function lerParaEscolherCanaisShopee(
  buscar: () => Promise<RespostaCanaisShopee>,
): Promise<RespostaCanaisShopee | null> {
  try {
    return await buscar();
  } catch (err) {
    if (
      err instanceof ShopeeClientHttpError ||
      err instanceof ShopeeClientNetworkError ||
      err instanceof FirebaseError
    ) {
      return null;
    }
    throw err;
  }
}

function lerCanais(
  client: ShopeeClient | null,
  integracaoId: string | null,
  produtoId: string,
): Promise<RespostaCanaisShopee> {
  // `enabled` (and the click's own guard) keep a missing client or conta from
  // ever reaching here; this is the type's due.
  if (client === null || integracaoId === null) {
    throw new Error('cliente da Shopee indisponível');
  }
  return client.canais({ integracaoId, produtoId });
}

/** What the apply reads at ITS time — the last committed render's, never the click's. */
interface Atual {
  readonly valor: readonly Canal[] | null;
  readonly editavel: boolean;
  /** The read's key the section shows now — another stored revision, or conta, is another key. */
  readonly chave: readonly unknown[];
  readonly onMudar: (valor: readonly Canal[] | null) => void;
}

/* -------------------------------------------------------------------------- */
/*                                 The section                                 */
/* -------------------------------------------------------------------------- */

/**
 * The draft's «Logística (canais de envio)» (#1911 P16): «Automática» (the
 * publish picks the channels; `logistic_info: null`) or «Escolher canais» —
 * one row per channel the shop can send, each with «Ligado» and its own free
 * shipping. It writes NOTHING: every change goes up through `onMudar` into the
 * draft form, and the draft's own «Salvar rascunho» sends it (P15's edit).
 *
 * States, in priority order:
 * 1. **No conta that can answer** (`contaId: null`) — «Automática»'s sentence,
 *    or one read-only line per stored channel; no control, no read.
 * 2. **A new draft** (`novo`) — «Automática»'s sentence and «Salve o
 *    rascunho…»; no control, no read (D-13).
 * 3. **«Automática»** — the mode picker, its sentence and, over a list the
 *    ERP never stamped, the previous system's banner. NO read on render.
 * 4. **Choosing** — «Escolher canais» was clicked with no held list: the read
 *    is on its way (or failed: its sentence and, when it may help, «Tentar de
 *    novo», which chooses again). It lasts only while that read is in flight
 *    or that failure shows: once the failure no longer shows (another produto
 *    revision), the section is back on «Automática» — the choosing state
 *    neither reads nor waits on data nobody will apply.
 * 5. **«Escolher canais»** — the channels read on render; the rows; the
 *    measures, basis, stale-channels, zero-ON and nothing-available sentences.
 *
 * - **Every channel verdict is the DTO's** (#1369): the rows, the locks, the
 *   prefill and every rebuild come from `@/lib/shopee/logisticaRascunho`, and
 *   the zero-ON sentence from the PLAN's verdict (`logisticaInvalida`). A
 *   change the rows refuse answers the same value, and nothing is sent up.
 * - **The ONE asynchronous edit of the draft form** (D16-11). «Escolher
 *   canais» over a held list puts it back at once (D16-2). Otherwise it reads
 *   (the query's own fetch — the observer, enabled while choosing, shares it:
 *   one call) and applies the prefill ONLY when nothing moved meanwhile: the
 *   same click (a generation; «Automática» clicked, a hide or an unmount bump
 *   it), the CURRENT value still `null` (another tab's list that landed
 *   during the read wins — the section shows it, nothing is dirty), the block
 *   still editable, and the read's key still the section's
 *   (`mesmaChaveCanaisShopee`: a stored produto that moved during the read, or
 *   another conta, is another key, whose answer — or failure — is never the
 *   prefill; the observer's own read of the new key, made while the choose was
 *   reading, is never applied either, and nothing reads again for the
 *   prefill: the next «Escolher canais» reads the new key) — each read at
 *   apply time from the last committed render, through that render's
 *   `onMudar`. The generation answers first: a superseded click's read never
 *   ends the newer choose, whatever its key. A dropped apply clears the
 *   choosing state. Never an effect that writes the form when data lands.
 * - **`<Activity>`** hides the produto's Shopee tab by running every effect
 *   cleanup: the cleanup bumps the generation and clears the choosing state,
 *   so the tab comes back on «Automática», never on a loader nothing ends.
 * - **Disabled, never removed** (D16-12): while `!editavel` every control
 *   stays on screen, disabled.
 * - **No free-shipping change on a channel the row cannot switch on** (Lucas
 *   2026-11-16, Q-F1 (b)): an OFF unavailable row's «Frete grátis…» is
 *   disabled like its «Ligado», still showing the value it holds (carried as
 *   it is — inert while OFF, movable again once the channel fits); Q-F1 (b)
 *   adds no lock to an ON unavailable row. The two locks are
 *   `interruptorTravadoShopee` and `freteGratisTravadoShopee`;
 *   `comCanalShopee` refuses the same moves, by direction (its docblock).
 * - **Enter** in the switch, the checkbox or the mode picker never submits the
 *   produto's form ({@link semEnviarOFormularioDoProduto}).
 *
 * Contract: the root `data-testid="shopee-rascunho-logistica-<linkDocId>"`;
 * each row `data-testid="shopee-logistica-<linkDocId>-<logisticId>"`; the
 * field id `idDoCampoRascunhoShopee(linkDocId, 'logistic_info')` — the refusal
 * row's focus target — on the rows' container while some row has a control
 * that can move (read through the SAME two locks that disable the controls,
 * `editavel` aside), else on the root (D16-13). One element at a time. The
 * focus takes that element's first ENABLED control. In the rows, in DTO
 * order: a row's «Ligado», or, where that switch is locked ON (compulsory),
 * the row's «Frete grátis…»; an unavailable OFF row has neither, so the focus
 * goes on to the next row — never to a dead row's checkbox. On the root (no
 * row can move): the «Automática» radio, the way out of such a list.
 */
export function LogisticaRascunhoShopee({
  linkDocId,
  contaId,
  produtoId,
  revisaoDoProduto,
  valor,
  guardada,
  novo,
  logisticaDoSistemaAnterior,
  logisticaInvalida,
  editavel,
  onMudar,
}: LogisticaRascunhoShopeeProps) {
  const client = useShopeeClient();
  const queryClient = useQueryClient();
  const idDoTitulo = useId();
  const [escolhendo, setEscolhendo] = useState(false);
  // «Escolher canais»'s OWN read is in flight — set by the click, cleared by
  // every exit of that read, by «Automática» and by the cleanup: the only
  // time a choose reads or shows a loader.
  const [lendo, setLendo] = useState(false);
  const geracao = useRef(0);
  const chave = chaveCanaisShopee(contaId ?? '', produtoId, revisaoDoProduto);
  const atual = useRef<Atual>({ valor, editavel, chave, onMudar });
  useLayoutEffect(() => {
    atual.current = { valor, editavel, chave, onMudar };
  });
  useEffect(() => {
    const g = geracao;
    return () => {
      // An unmount, or `<Activity>` hiding the tab: no apply lands after it,
      // and the tab never comes back on a loader nothing ends.
      g.current += 1;
      setEscolhendo(false);
      setLendo(false);
    };
  }, []);

  const consulta = useQuery({
    queryKey: chave,
    queryFn: () => lerCanais(client, contaId, produtoId),
    enabled: client !== null && contaId !== null && !novo && (valor !== null || lendo),
    staleTime: 0,
    retry: shopeeQueryRetry,
  });

  const raiz = `shopee-rascunho-logistica-${linkDocId}`;
  const idDoCampo = idDoCampoRascunhoShopee(linkDocId, CAMPO_RASCUNHO_SHOPEE.logisticInfo);
  const titulo = (
    <Text size="sm" fw={500} id={idDoTitulo}>
      {ROTULO_LOGISTICA_RASCUNHO_SHOPEE}
    </Text>
  );

  if (contaId === null) {
    return (
      <Stack gap={4} id={idDoCampo} data-testid={raiz}>
        {titulo}
        {valor === null ? (
          <Text size="sm" c="dimmed">
            {FRASE_LOGISTICA_RASCUNHO_SHOPEE}
          </Text>
        ) : (
          valor.map((canal, i) => (
            <Text key={`${String(i)}-${String(canal.logistic_id)}`} size="sm">
              {linhaDoCanalSomenteLeituraShopee(canal)}
            </Text>
          ))
        )}
      </Stack>
    );
  }

  if (novo) {
    return (
      <Stack gap={4} id={idDoCampo} data-testid={raiz}>
        {titulo}
        <Text size="sm" c="dimmed">
          {FRASE_LOGISTICA_RASCUNHO_SHOPEE}
        </Text>
        <Text size="sm" c="dimmed">
          {FRASE_SALVE_PARA_ESCOLHER_CANAIS_SHOPEE}
        </Text>
      </Stack>
    );
  }

  const escolherCanais = async (): Promise<void> => {
    const restaurada = escolhaAoEscolherCanaisShopee(guardada, null);
    if (restaurada !== null) {
      onMudar(restaurada);
      return;
    }
    if (client === null) return;
    geracao.current += 1;
    const minha = geracao.current;
    setEscolhendo(true);
    setLendo(true);
    const resposta = await lerParaEscolherCanaisShopee(() =>
      queryClient.fetchQuery({
        queryKey: chave,
        queryFn: () => lerCanais(client, contaId, produtoId),
        staleTime: 0,
        retry: shopeeQueryRetry,
      }),
    );
    if (geracao.current !== minha) return;
    setLendo(false);
    const agora = atual.current;
    if (agora.valor !== null || !agora.editavel) {
      setEscolhendo(false);
      return;
    }
    // The stored produto moved during the read, or the conta changed (another
    // key): its answer — or its failure — is of a key nobody shows. Dropped,
    // never re-read here; the value stays `null`, «Escolher canais» reads anew.
    if (!mesmaChaveCanaisShopee(chave, agora.chave)) {
      setEscolhendo(false);
      return;
    }
    // A failure: the observer shows it, and «Tentar de novo» chooses again.
    if (resposta === null) return;
    setEscolhendo(false);
    agora.onMudar(escolhaAoEscolherCanaisShopee(null, resposta));
  };

  const mudarModo = (modo: string) => {
    if (modo === MODO_LOGISTICA_SHOPEE.automatica) {
      geracao.current += 1;
      setEscolhendo(false);
      setLendo(false);
      if (valor !== null) onMudar(null);
    } else if (modo === MODO_LOGISTICA_SHOPEE.escolhida) {
      void escolherCanais();
    }
  };

  const falhou = consulta.isError && !consulta.isFetching;
  // A choose stays open only while its read is in flight or its failure
  // shows. A failure that no longer shows (another produto revision; another
  // tab's list, come and gone) ends it: back on «Automática», never on a
  // loader no read will end — and nothing applied from that later data.
  const escolhaAberta = escolhendo && (lendo || falhou);
  const modo = escolhaAberta ? MODO_LOGISTICA_SHOPEE.escolhida : modoDaLogisticaShopee(valor);
  const seletor = (
    <SegmentedControl
      aria-labelledby={idDoTitulo}
      w="fit-content"
      size="xs"
      value={modo}
      onChange={mudarModo}
      disabled={!editavel}
      // Lands on the radiogroup root: an Enter on a segment bubbles to it.
      onKeyDown={semEnviarOFormularioDoProduto}
      data={[
        { value: MODO_LOGISTICA_SHOPEE.automatica, label: ROTULO_LOGISTICA_AUTOMATICA_SHOPEE },
        { value: MODO_LOGISTICA_SHOPEE.escolhida, label: ROTULO_ESCOLHER_CANAIS_SHOPEE },
      ]}
    />
  );

  if (valor === null && !escolhaAberta) {
    return (
      <Stack gap="xs" id={idDoCampo} data-testid={raiz}>
        {titulo}
        {seletor}
        <Text size="sm" c="dimmed">
          {FRASE_LOGISTICA_RASCUNHO_SHOPEE}
        </Text>
        {logisticaDoSistemaAnterior && (
          <Alert color="yellow" variant="light">
            {FRASE_LOGISTICA_DO_SISTEMA_ANTERIOR_SHOPEE}
          </Alert>
        )}
      </Stack>
    );
  }

  const { mensagem, repetivel } = descreverFalhaShopee(consulta.error, {
    desconhecido: FRASE_FALHA_CANAIS_SHOPEE,
  });
  const falha: ReactNode = falhou && (
    <Alert color="red" variant="light" data-testid={`${raiz}-falha`}>
      <Stack gap="xs">
        <Text size="sm">{mensagem}</Text>
        {repetivel && (
          <Button
            type="button"
            size="xs"
            variant="light"
            w="fit-content"
            // Choosing: choose again (read, then apply); with a list: read again.
            onClick={() => {
              if (valor === null) void escolherCanais();
              else void consulta.refetch();
            }}
          >
            {ROTULO_TENTAR_DE_NOVO_CANAIS_SHOPEE}
          </Button>
        )}
      </Stack>
    </Alert>
  );
  const carregando = (
    <Group gap="xs" data-testid={`${raiz}-carregando`}>
      <Loader size="xs" />
      <Text size="sm" c="dimmed">
        {FRASE_LENDO_CANAIS_SHOPEE}
      </Text>
    </Group>
  );

  if (valor === null) {
    // Choosing: no list in the form yet — the read decides the prefill.
    return (
      <Stack gap="xs" id={idDoCampo} data-testid={raiz}>
        {titulo}
        {seletor}
        {falhou ? falha : carregando}
      </Stack>
    );
  }

  const resposta = falhou ? undefined : consulta.data;
  const linhas = resposta === undefined ? [] : linhasDaLogisticaShopee(valor, resposta);
  const fora = resposta === undefined ? [] : canaisGravadosForaDaLojaShopee(valor, resposta);
  // The field id goes on the rows only when some row has a control that can
  // move (the controls' own two locks, `editavel` aside); else on the root,
  // whose first enabled control is «Automática».
  const idNasLinhas = linhas.some(
    (linha) => !interruptorTravadoShopee(linha) || !freteGratisTravadoShopee(linha),
  );
  const mudar = (logisticId: number, mudanca: MudancaDoCanalShopee) => {
    if (resposta === undefined) return;
    const proximo = comCanalShopee(valor, resposta, logisticId, mudanca);
    // A change the row refuses answers the value itself: nothing to send up.
    if (proximo !== valor) onMudar(proximo);
  };

  return (
    <Stack gap="xs" id={idNasLinhas ? undefined : idDoCampo} data-testid={raiz}>
      {titulo}
      {seletor}
      <Text size="sm" c="dimmed">
        {FRASE_CANAIS_ESCOLHIDOS_SHOPEE}
      </Text>
      {falha}
      {!falhou && resposta === undefined && carregando}
      {resposta !== undefined && !resposta.medidasCompletas && (
        <Text size="sm" c="orange">
          {FRASE_MEDIDAS_INCOMPLETAS_CANAIS_SHOPEE}
        </Text>
      )}
      {resposta !== undefined && linhas.length === 0 && (
        <Text size="sm" c="dimmed">
          {FRASE_SEM_CANAL_SELECIONAVEL_SHOPEE}
        </Text>
      )}
      {linhas.length > 0 && (
        <Stack gap="sm" id={idNasLinhas ? idDoCampo : undefined}>
          {linhas.map((linha) => (
            <LinhaDoCanal
              key={linha.logisticId}
              linkDocId={linkDocId}
              linha={linha}
              editavel={editavel}
              onMudar={mudar}
            />
          ))}
        </Stack>
      )}
      {resposta !== undefined && (
        <Text size="xs" c="dimmed">
          {FRASE_BASE_DA_CONFERENCIA_CANAIS_SHOPEE}
        </Text>
      )}
      {fora.length > 0 && (
        <Text size="sm" c="orange" data-testid={`${raiz}-fora-da-loja`}>
          {fraseDosCanaisForaDaLojaShopee(fora)}
        </Text>
      )}
      {logisticaInvalida === MOTIVO_DA_LOGISTICA_INVALIDA_SHOPEE.semCanalLigado && (
        <Text size="sm" c="red">
          {FRASE_NENHUM_CANAL_LIGADO_SHOPEE}
        </Text>
      )}
      {/* With no row at all, the shop's own sentence already says it (D16-18). */}
      {resposta !== undefined &&
        linhas.length > 0 &&
        !algumLigadoDisponivelShopee(valor, resposta) && (
          <Alert color="yellow" variant="light">
            {FRASE_NENHUM_CANAL_LIGADO_DISPONIVEL_SHOPEE}
          </Alert>
        )}
    </Stack>
  );
}

/** What the switch says about its row: the lock, and why an ON or OFF channel does not go. */
function frasesDoInterruptor(linha: LinhaLogisticaShopee): readonly string[] {
  const frases: string[] = [];
  if (linha.obrigatorio) frases.push(FRASE_CANAL_OBRIGATORIO_SHOPEE);
  if (linha.indisponivel !== null) {
    const motivo = FRASE_INDISPONIVEL_CANAL_SHOPEE[linha.indisponivel];
    frases.push(linha.ligado ? `${PREFIXO_LIGADO_INDISPONIVEL_SHOPEE}${motivo}` : motivo);
  }
  return frases;
}

/** One selectable channel: a `group` named by the channel, its «Ligado» and its free shipping. */
function LinhaDoCanal({
  linkDocId,
  linha,
  editavel,
  onMudar,
}: {
  linkDocId: string;
  linha: LinhaLogisticaShopee;
  editavel: boolean;
  onMudar: (logisticId: number, mudanca: MudancaDoCanalShopee) => void;
}) {
  const idDoRotulo = useId();
  const frases = frasesDoInterruptor(linha);
  return (
    <Stack
      gap={4}
      role="group"
      aria-labelledby={idDoRotulo}
      data-testid={`shopee-logistica-${linkDocId}-${String(linha.logisticId)}`}
    >
      <Text size="sm" id={idDoRotulo}>
        <Text span fw={500} inherit>
          {rotuloDoCanalLogisticaShopee(linha.logisticId, linha.nome)}
        </Text>{' '}
        <Text span size="xs" c="dimmed">
          {`(${String(linha.logisticId)})`}
        </Text>
      </Text>
      <Switch
        label={ROTULO_CANAL_LIGADO_SHOPEE}
        checked={linha.ligado}
        disabled={!editavel || interruptorTravadoShopee(linha)}
        description={
          frases.length > 0 ? (
            <>
              {frases.map((f) => (
                <span key={f} style={{ display: 'block' }}>
                  {f}
                </span>
              ))}
            </>
          ) : undefined
        }
        onKeyDown={semEnviarOFormularioDoProduto}
        onChange={(e) => onMudar(linha.logisticId, { ligado: e.currentTarget.checked })}
      />
      <Checkbox
        label={ROTULO_FRETE_GRATIS_CANAL_SHOPEE}
        checked={linha.freteGratis}
        // Blocked by the shop, or a channel this row cannot send (Q-F1 (b)).
        disabled={!editavel || freteGratisTravadoShopee(linha)}
        description={linha.bloqueiaFreteGratis ? FRASE_FRETE_GRATIS_BLOQUEADO_SHOPEE : undefined}
        onKeyDown={semEnviarOFormularioDoProduto}
        onChange={(e) => onMudar(linha.logisticId, { freteGratis: e.currentTarget.checked })}
      />
    </Stack>
  );
}
