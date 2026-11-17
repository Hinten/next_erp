import { Activity } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FirebaseError } from 'firebase/app';
import {
  CAMPO_RASCUNHO_SHOPEE,
  MOTIVO_INDISPONIVEL_CANAL_SHOPEE,
  respostaCanaisShopeeSchema,
  type CanalDaLojaShopeeDto,
  type CanalLogisticaRascunhoShopee,
  type RespostaCanaisShopee,
} from '@delfrance/schemas';

import { MantineTestProvider } from '@/lib/testing/mantine';
import { QUERY_DEFAULT_OPTIONS } from '@/lib/query/QueryProvider';

/**
 * The draft's «Logística (canais de envio)» section (#1911 P16): what it reads
 * and when, «Escolher canais»'s asynchronous apply and every way it must NOT
 * land, the rows and their locks, and the field id — over a doubled client
 * (`canais` only), the app's query defaults. Channel ids and names are
 * fixtures (design-P16 §5): A 90003 and B 90005 selectable with an automatic
 * entry; C 90007 not selectable; D 90009 the package does not fit; E 90011
 * compulsory; F 90013 seller-paid free shipping blocked; G 90015 compulsory
 * and the package does not fit.
 *
 * Each rule has a pair and a near miss: a test that the rule APPLIES cannot
 * show where it STOPS (#1372).
 */

const h = vi.hoisted(() => ({ canais: vi.fn() }));

// The REAL error classes stay: the section and `erros.ts` narrow on them.
vi.mock('@/lib/shopee/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/shopee/client')>();
  return { ...actual, useShopeeClient: () => ({ canais: h.canais }) };
});

const {
  FRASE_BASE_DA_CONFERENCIA_CANAIS_SHOPEE,
  FRASE_CANAIS_ESCOLHIDOS_SHOPEE,
  FRASE_CANAL_OBRIGATORIO_SHOPEE,
  FRASE_FALHA_CANAIS_SHOPEE,
  FRASE_FRETE_GRATIS_BLOQUEADO_SHOPEE,
  FRASE_INDISPONIVEL_CANAL_SHOPEE,
  FRASE_LENDO_CANAIS_SHOPEE,
  FRASE_LOGISTICA_DO_SISTEMA_ANTERIOR_SHOPEE,
  FRASE_MEDIDAS_INCOMPLETAS_CANAIS_SHOPEE,
  FRASE_NENHUM_CANAL_LIGADO_DISPONIVEL_SHOPEE,
  FRASE_NENHUM_CANAL_LIGADO_SHOPEE,
  FRASE_SALVE_PARA_ESCOLHER_CANAIS_SHOPEE,
  FRASE_SEM_CANAL_SELECIONAVEL_SHOPEE,
  LogisticaRascunhoShopee,
  PREFIXO_LIGADO_INDISPONIVEL_SHOPEE,
  ROTULO_CANAL_LIGADO_SHOPEE,
  ROTULO_ESCOLHER_CANAIS_SHOPEE,
  ROTULO_FRETE_GRATIS_CANAL_SHOPEE,
  ROTULO_LOGISTICA_AUTOMATICA_SHOPEE,
  ROTULO_LOGISTICA_RASCUNHO_SHOPEE,
  ROTULO_TENTAR_DE_NOVO_CANAIS_SHOPEE,
  fraseDosCanaisForaDaLojaShopee,
  lerParaEscolherCanaisShopee,
  rotuloDoCanalLogisticaShopee,
} = await import('./LogisticaRascunhoShopee');
const { idDoCampoRascunhoShopee } = await import('./DesfechoAcaoShopee');
const { ShopeeClientHttpError, ShopeeClientNetworkError, ShopeeClientRespostaInvalidaError } =
  await import('@/lib/shopee/client');
const { FRASE_LOGISTICA_RASCUNHO_SHOPEE, linhaDoCanalSomenteLeituraShopee } =
  await import('@/lib/shopee/anuncioProduto');
const { MOTIVO_DA_LOGISTICA_INVALIDA_SHOPEE, comCanalShopee, escolhaInicialShopee } =
  await import('@/lib/shopee/logisticaRascunho');
type MotivoDaLogisticaInvalidaShopee =
  import('@/lib/shopee/logisticaRascunho').MotivoDaLogisticaInvalidaShopee;

/* -------------------------------------------------------------------------- */
/*                                  Fixtures                                   */
/* -------------------------------------------------------------------------- */

type Canal = CanalLogisticaRascunhoShopee;

const CONTA = 'int-1';
const PRODUTO = 'prod-1';
const LINK = 'rasc00000000000000001';
const RAIZ = `shopee-rascunho-logistica-${LINK}`;

const A = 90003;
const B = 90005;
const C = 90007;
const D = 90009;
const E = 90011;
const F = 90013;
const G = 90015;
/** An id the answer never lists. */
const AUSENTE = 90099;

const LETRAS: Readonly<Record<number, string>> = {
  [A]: 'A',
  [B]: 'B',
  [C]: 'C',
  [D]: 'D',
  [E]: 'E',
  [F]: 'F',
  [G]: 'G',
};

const canal = (
  logisticsChannelId: number,
  p: Partial<CanalDaLojaShopeeDto> = {},
): CanalDaLojaShopeeDto => ({
  logisticsChannelId,
  nome: `Entrega ${LETRAS[logisticsChannelId] ?? String(logisticsChannelId)}`,
  selecionavel: true,
  obrigatorio: false,
  bloqueiaFreteGratisDoVendedor: false,
  indisponivel: null,
  automatica: { isFree: false },
  ...p,
});

/** Through the SHARED schema: a fixture the route could never send fails here. */
const resposta = (
  canais: readonly CanalDaLojaShopeeDto[],
  medidasCompletas = true,
): RespostaCanaisShopee => respostaCanaisShopeeSchema.parse({ medidasCompletas, canais });

const NAO_CABE = MOTIVO_INDISPONIVEL_CANAL_SHOPEE.naoCabe;

/** The whole shop, in a NON-sorted `get_channel_list` order (B before A). */
const LOJA = resposta([
  canal(B),
  canal(A),
  canal(C, { selecionavel: false, automatica: null }),
  canal(D, { indisponivel: NAO_CABE, automatica: null }),
  canal(E, { obrigatorio: true }),
  canal(F, { bloqueiaFreteGratisDoVendedor: true }),
  canal(G, { obrigatorio: true, indisponivel: NAO_CABE, automatica: null }),
]);

/** Two plain selectable channels, B listed first. Its prefill: both ON, no free shipping. */
const LOJA_AB = resposta([canal(B), canal(A)]);

const on = (logistic_id: number, is_free: boolean | null = false): Canal => ({
  logistic_id,
  enabled: true,
  is_free,
});
const off = (logistic_id: number, is_free: boolean | null = false): Canal => ({
  logistic_id,
  enabled: false,
  is_free,
});

interface Adiada<T> {
  readonly promise: Promise<T>;
  readonly resolve: (v: T) => void;
  readonly reject: (e: unknown) => void;
}
function adiada<T>(): Adiada<T> {
  let resolve: (v: T) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Opcoes {
  contaId?: string | null;
  valor?: readonly Canal[] | null;
  guardada?: readonly Canal[] | null;
  novo?: boolean;
  /** `bloco.logisticaDoSistemaAnterior`. */
  legado?: boolean;
  logisticaInvalida?: MotivoDaLogisticaInvalidaShopee | null;
  editavel?: boolean;
  revisao?: number | null;
  onMudar?: (valor: readonly Canal[] | null) => void;
  /** Under `<Activity mode="hidden">` — the produto page hiding the Shopee tab. */
  oculta?: boolean;
}

const novoQueryClient = () => new QueryClient({ defaultOptions: QUERY_DEFAULT_OPTIONS });

function show(inicial: Opcoes = {}, qc: QueryClient = novoQueryClient()) {
  const onMudar = vi.fn<(valor: readonly Canal[] | null) => void>();
  const ui = (p: Opcoes) => (
    <MantineTestProvider>
      <QueryClientProvider client={qc}>
        <Activity mode={p.oculta === true ? 'hidden' : 'visible'}>
          <LogisticaRascunhoShopee
            linkDocId={LINK}
            contaId={p.contaId === undefined ? CONTA : p.contaId}
            produtoId={PRODUTO}
            revisaoDoProduto={p.revisao === undefined ? 1 : p.revisao}
            valor={p.valor ?? null}
            guardada={p.guardada ?? null}
            novo={p.novo ?? false}
            logisticaDoSistemaAnterior={p.legado ?? false}
            logisticaInvalida={p.logisticaInvalida ?? null}
            editavel={p.editavel ?? true}
            onMudar={p.onMudar ?? onMudar}
          />
        </Activity>
      </QueryClientProvider>
    </MantineTestProvider>
  );
  const r = render(ui(inicial));
  return { ...r, onMudar, qc, rerenderCom: (p: Opcoes) => r.rerender(ui(p)) };
}

const secao = () => screen.getByTestId(RAIZ);
const idDaLinha = (id: number) => `shopee-logistica-${LINK}-${String(id)}`;
const linhaDo = (id: number) => screen.getByTestId(idDaLinha(id));
const interruptor = (id: number) => within(linhaDo(id)).getByRole('switch') as HTMLInputElement;
const freteGratis = (id: number) =>
  within(linhaDo(id)).getByRole('checkbox', {
    name: ROTULO_FRETE_GRATIS_CANAL_SHOPEE,
  }) as HTMLInputElement;
const radio = (nome: string) => screen.getByRole('radio', { name: nome }) as HTMLInputElement;
const escolher = () => fireEvent.click(radio(ROTULO_ESCOLHER_CANAIS_SHOPEE));
const automatica = () => fireEvent.click(radio(ROTULO_LOGISTICA_AUTOMATICA_SHOPEE));
/** Lets every settled promise and the renders it causes run. */
const assentar = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

beforeEach(() => {
  h.canais.mockReset();
  h.canais.mockResolvedValue(LOJA);
});

/* -------------------------------------------------------------------------- */
/*                           What is read, and when                            */
/* -------------------------------------------------------------------------- */

describe('LogisticaRascunhoShopee — o que é lido, e quando (#1911 P16)', () => {
  it('Automática (`valor` null): `canais` NÃO é chamado, a FRASE aparece ⟷ escolhida: chamado UMA vez na renderização', async () => {
    const { unmount } = show();
    expect(secao().textContent).toContain(FRASE_LOGISTICA_RASCUNHO_SHOPEE);
    expect(radio(ROTULO_LOGISTICA_AUTOMATICA_SHOPEE).checked).toBe(true);
    await assentar();
    expect(h.canais).not.toHaveBeenCalled();
    unmount();

    show({ valor: [on(A)] });
    await screen.findByTestId(idDaLinha(A));
    await assentar();
    expect(h.canais).toHaveBeenCalledTimes(1);
    expect(h.canais).toHaveBeenCalledWith({ integracaoId: CONTA, produtoId: PRODUTO });
    expect(radio(ROTULO_ESCOLHER_CANAIS_SHOPEE).checked).toBe(true);
    expect(secao().textContent).toContain(FRASE_CANAIS_ESCOLHIDOS_SHOPEE);
    expect(secao().textContent).not.toContain(FRASE_LOGISTICA_RASCUNHO_SHOPEE);
  });

  it('legado: o aviso do sistema anterior, sem chamada ⟷ carimbada: sem aviso', async () => {
    const { unmount } = show({ legado: true });
    expect(secao().textContent).toContain(FRASE_LOGISTICA_DO_SISTEMA_ANTERIOR_SHOPEE);
    expect(secao().textContent).toContain(FRASE_LOGISTICA_RASCUNHO_SHOPEE);
    await assentar();
    expect(h.canais).not.toHaveBeenCalled();
    unmount();

    // QUASE-PAR: «Automática» over no legacy list — the sentence, no banner.
    const automaticaSemLegado = show();
    expect(secao().textContent).toContain(FRASE_LOGISTICA_RASCUNHO_SHOPEE);
    expect(secao().textContent).not.toContain(FRASE_LOGISTICA_DO_SISTEMA_ANTERIOR_SHOPEE);
    automaticaSemLegado.unmount();

    show({ valor: [on(A)] });
    await screen.findByTestId(idDaLinha(A));
    expect(secao().textContent).not.toContain(FRASE_LOGISTICA_DO_SISTEMA_ANTERIOR_SHOPEE);
  });

  it('rascunho novo: «Salve o rascunho…», sem radiogroup, sem chamada', async () => {
    show({ novo: true });
    expect(secao().textContent).toContain(FRASE_SALVE_PARA_ESCOLHER_CANAIS_SHOPEE);
    expect(secao().textContent).toContain(FRASE_LOGISTICA_RASCUNHO_SHOPEE);
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
    await assentar();
    expect(h.canais).not.toHaveBeenCalled();
  });

  it('sem conta: as linhas `Canal {id}: …`, sem chamada', async () => {
    const valor = [on(A, true), off(B)];
    const { unmount } = show({ contaId: null, valor });
    const texto = secao().textContent;
    expect(texto).toContain(linhaDoCanalSomenteLeituraShopee(on(A, true)));
    expect(texto).toContain('Canal 90003: ligado, frete grátis');
    expect(texto).toContain('Canal 90005: desligado');
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    await assentar();
    expect(h.canais).not.toHaveBeenCalled();
    unmount();

    // QUASE-PAR: Automática sem conta — a frase, nenhuma linha.
    show({ contaId: null });
    expect(secao().textContent).toContain(FRASE_LOGISTICA_RASCUNHO_SHOPEE);
    expect(secao().textContent).not.toContain('Canal ');
    await assentar();
    expect(h.canais).not.toHaveBeenCalled();
  });

  it('F5: outra `revisaoDoProduto` ⇒ mais uma chamada ⟷ a mesma ⇒ nenhuma', async () => {
    const { rerenderCom } = show({ valor: [on(A)], revisao: 1 });
    await waitFor(() => expect(h.canais).toHaveBeenCalledTimes(1));
    rerenderCom({ valor: [on(A)], revisao: 2 });
    await waitFor(() => expect(h.canais).toHaveBeenCalledTimes(2));
    // Another render with the SAME revision (another prop moved): no read.
    rerenderCom({ valor: [on(A)], revisao: 2, editavel: false });
    await assentar();
    expect(h.canais).toHaveBeenCalledTimes(2);
  });

  it('`staleTime: 0`: a seção remontada (o mesmo QueryClient, a mesma revisão) lê de novo ⟷ QUASE-PAR: a mesma montagem renderizada de novo (F5, acima) não', async () => {
    const qc = novoQueryClient();
    const primeira = show({ valor: [on(A)] }, qc);
    await screen.findByTestId(idDaLinha(A));
    expect(h.canais).toHaveBeenCalledTimes(1);
    primeira.unmount();
    // «Desfazer alterações» (the section's `key`) or the tab shown again: the
    // app's 30 s default would serve the cached answer; this read never does.
    show({ valor: [on(A)] }, qc);
    await waitFor(() => expect(h.canais).toHaveBeenCalledTimes(2));
  });
});

/* -------------------------------------------------------------------------- */
/*                              «Escolher canais»                              */
/* -------------------------------------------------------------------------- */

describe('LogisticaRascunhoShopee — «Escolher canais»: o prefill e quando ele NÃO entra', () => {
  it('⭐ «Escolher canais» ⇒ UMA chamada e `onMudar(escolhaInicialShopee(resposta))` uma vez ⟷ com `guardada` ⇒ `onMudar(guardada)` na hora, sem chamada antes da nova renderização', async () => {
    const { onMudar, unmount } = show();
    escolher();
    expect(radio(ROTULO_ESCOLHER_CANAIS_SHOPEE).checked).toBe(true);
    await waitFor(() => expect(onMudar).toHaveBeenCalledTimes(1));
    expect(onMudar).toHaveBeenCalledWith(escolhaInicialShopee(LOJA));
    await assentar();
    // The click's read and the observer it enabled share ONE call.
    expect(h.canais).toHaveBeenCalledTimes(1);
    expect(onMudar).toHaveBeenCalledTimes(1);
    unmount();

    h.canais.mockClear();
    const guardada = [on(A), off(B)];
    const outro = show({ guardada });
    escolher();
    expect(outro.onMudar).toHaveBeenCalledTimes(1);
    expect(outro.onMudar.mock.calls[0]?.[0]).toBe(guardada);
    await assentar();
    expect(h.canais).not.toHaveBeenCalled();
    expect(outro.onMudar).toHaveBeenCalledTimes(1);
  });

  it('⭐ geração: resposta adiada e «Automática» clicada antes ⇒ nada aplicado ⟷ sem clique ⇒ aplicada uma vez', async () => {
    const lida = adiada<RespostaCanaisShopee>();
    h.canais.mockReturnValueOnce(lida.promise);
    const { onMudar, unmount } = show();
    escolher();
    expect(screen.getByTestId(`${RAIZ}-carregando`).textContent).toContain(
      FRASE_LENDO_CANAIS_SHOPEE,
    );
    automatica();
    expect(radio(ROTULO_LOGISTICA_AUTOMATICA_SHOPEE).checked).toBe(true);
    await act(async () => {
      lida.resolve(LOJA_AB);
      await lida.promise;
    });
    await assentar();
    expect(onMudar).not.toHaveBeenCalled();
    expect(radio(ROTULO_LOGISTICA_AUTOMATICA_SHOPEE).checked).toBe(true);
    unmount();

    const outra = adiada<RespostaCanaisShopee>();
    h.canais.mockReturnValueOnce(outra.promise);
    const segundo = show();
    escolher();
    await act(async () => {
      outra.resolve(LOJA_AB);
      await outra.promise;
    });
    await waitFor(() => expect(segundo.onMudar).toHaveBeenCalledTimes(1));
    expect(segundo.onMudar).toHaveBeenCalledWith(escolhaInicialShopee(LOJA_AB));
  });

  it('⭐ F1: `valor` passa de null a uma lista (outra aba) com a leitura em voo ⇒ `onMudar` nunca chamado, a lista aparece ⟷ ⛔ só outro campo mudou (`valor` ainda null) ⇒ o prefill aplica', async () => {
    // The other tab's list: A on, B OFF — the prefill would turn B on.
    const daOutraAba = [on(A), off(B)];
    const lida = adiada<RespostaCanaisShopee>();
    h.canais.mockReturnValueOnce(lida.promise);
    const { onMudar, rerenderCom, unmount } = show();
    escolher();
    rerenderCom({ valor: daOutraAba });
    await act(async () => {
      lida.resolve(LOJA_AB);
      await lida.promise;
    });
    await screen.findByTestId(idDaLinha(B));
    await assentar();
    expect(onMudar).not.toHaveBeenCalled();
    expect(interruptor(A).checked).toBe(true);
    expect(interruptor(B).checked).toBe(false);
    expect(h.canais).toHaveBeenCalledTimes(1);
    unmount();

    const outra = adiada<RespostaCanaisShopee>();
    h.canais.mockReturnValueOnce(outra.promise);
    const segundo = show();
    escolher();
    // Another field of the form changed: a new render, a new handler, the
    // logistics still `null`.
    const atual = vi.fn<(valor: readonly Canal[] | null) => void>();
    segundo.rerenderCom({ onMudar: atual });
    await act(async () => {
      outra.resolve(LOJA_AB);
      await outra.promise;
    });
    await waitFor(() => expect(atual).toHaveBeenCalledTimes(1));
    expect(atual).toHaveBeenCalledWith(escolhaInicialShopee(LOJA_AB));
    expect(segundo.onMudar).not.toHaveBeenCalled();
  });

  it('⭐ revisão: outra `revisaoDoProduto` com a leitura em voo ⇒ a resposta da revisão ANTIGA não entra — nenhum `onMudar`, de volta a «Automática», sem carregando nem leitura nova ⟷ QUASE-PAR: só outro campo mudou (a mesma chave) ⇒ aplicada uma vez', async () => {
    // The stored produto moves during the read (another tab flips «Oferece
    // frete grátis», the weight, the measures): the old answer's fit verdicts
    // and `automatica.isFree` are no longer this produto's.
    const lida = adiada<RespostaCanaisShopee>();
    h.canais.mockReturnValueOnce(lida.promise);
    const { onMudar, rerenderCom, unmount } = show({ revisao: 1 });
    escolher();
    rerenderCom({ revisao: 2 });
    await assentar();
    // Still the click's read in flight: the choose is open.
    expect(screen.getByTestId(`${RAIZ}-carregando`)).toBeTruthy();
    await act(async () => {
      lida.resolve(LOJA_AB);
      await lida.promise;
    });
    await assentar();
    expect(onMudar).not.toHaveBeenCalled();
    expect(radio(ROTULO_LOGISTICA_AUTOMATICA_SHOPEE).checked).toBe(true);
    expect(screen.queryByTestId(`${RAIZ}-carregando`)).toBeNull();
    expect(secao().textContent).toContain(FRASE_LOGISTICA_RASCUNHO_SHOPEE);
    // The click's read + the observer's read of the new key while the choose
    // was reading — and NO read after the drop (never an automatic re-read).
    expect(h.canais).toHaveBeenCalledTimes(2);
    // The choose is over: yet another revision reads nothing for it.
    rerenderCom({ revisao: 3 });
    await assentar();
    expect(h.canais).toHaveBeenCalledTimes(2);
    expect(onMudar).not.toHaveBeenCalled();
    unmount();

    // QUASE-PAR: the same revision, another prop of the section moved.
    const outra = adiada<RespostaCanaisShopee>();
    h.canais.mockReturnValueOnce(outra.promise);
    const segundo = show({ revisao: 1 });
    escolher();
    segundo.rerenderCom({ revisao: 1, legado: true });
    await act(async () => {
      outra.resolve(LOJA_AB);
      await outra.promise;
    });
    await waitFor(() => expect(segundo.onMudar).toHaveBeenCalledTimes(1));
    expect(segundo.onMudar).toHaveBeenCalledWith(escolhaInicialShopee(LOJA_AB));
    await assentar();
    expect(segundo.onMudar).toHaveBeenCalledTimes(1);
  });

  it('revisão A→B→A durante a leitura ⇒ a chave volta a ser a da seção (a resposta é da revisão mostrada) ⇒ aplicada uma vez', async () => {
    const lida = adiada<RespostaCanaisShopee>();
    h.canais.mockReturnValueOnce(lida.promise);
    const { onMudar, rerenderCom } = show({ revisao: 1 });
    escolher();
    rerenderCom({ revisao: 2 });
    await assentar();
    rerenderCom({ revisao: 1 });
    await assentar();
    await act(async () => {
      lida.resolve(LOJA_AB);
      await lida.promise;
    });
    await waitFor(() => expect(onMudar).toHaveBeenCalledTimes(1));
    expect(onMudar).toHaveBeenCalledWith(escolhaInicialShopee(LOJA_AB));
    await assentar();
    expect(onMudar).toHaveBeenCalledTimes(1);
  });

  it('depois de uma escolha largada pela revisão, «Escolher canais» de novo lê a chave NOVA e aplica a resposta DELA, uma vez — nunca a da revisão antiga', async () => {
    // The new revision's answer: A only, with free shipping.
    const daRevisaoNova = resposta([canal(A, { automatica: { isFree: true } })]);
    h.canais.mockResolvedValue(daRevisaoNova);
    const lida = adiada<RespostaCanaisShopee>();
    h.canais.mockReturnValueOnce(lida.promise);
    const { onMudar, rerenderCom } = show({ revisao: 1 });
    escolher();
    rerenderCom({ revisao: 2 });
    await assentar();
    await act(async () => {
      lida.resolve(LOJA_AB);
      await lida.promise;
    });
    await assentar();
    expect(onMudar).not.toHaveBeenCalled();
    expect(radio(ROTULO_LOGISTICA_AUTOMATICA_SHOPEE).checked).toBe(true);

    escolher();
    await waitFor(() => expect(onMudar).toHaveBeenCalledTimes(1));
    expect(onMudar).toHaveBeenCalledWith(escolhaInicialShopee(daRevisaoNova));
    expect(onMudar).not.toHaveBeenCalledWith(escolhaInicialShopee(LOJA_AB));
    await assentar();
    expect(onMudar).toHaveBeenCalledTimes(1);
    // The dropped click's read, the observer's read of the new key, the new click's read.
    expect(h.canais).toHaveBeenCalledTimes(3);
  });

  it('⛔ QUASE: a geração ANTES da revisão — a leitura de um clique ANTERIOR, de uma revisão que já mudou, termina com o clique NOVO ainda lendo ⇒ nada muda: o carregando do clique novo continua, «Escolher canais» marcada, nenhum `onMudar` ⟷ a resposta do clique novo aplica uma vez', async () => {
    const primeira = adiada<RespostaCanaisShopee>();
    const segunda = adiada<RespostaCanaisShopee>();
    // 1: the first click's read (revision 1); 2: the observer's read of
    // revision 2 while that choose was reading; 3: the second click's read.
    h.canais
      .mockReturnValueOnce(primeira.promise)
      .mockResolvedValueOnce(LOJA)
      .mockReturnValueOnce(segunda.promise);
    const { onMudar, rerenderCom } = show({ revisao: 1 });
    escolher();
    rerenderCom({ revisao: 2 });
    await assentar();
    // «Automática», then «Escolher canais» again on revision 2: a NEWER click
    // (another generation) whose own read is in flight.
    automatica();
    escolher();
    await assentar();
    expect(h.canais).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId(`${RAIZ}-carregando`)).toBeTruthy();
    // The FIRST click's read ends: another click's, and of a key gone by. The
    // generation answers first — that read ends nothing of the NEWER choose.
    await act(async () => {
      primeira.resolve(LOJA_AB);
      await primeira.promise;
    });
    await assentar();
    expect(screen.getByTestId(`${RAIZ}-carregando`)).toBeTruthy();
    expect(radio(ROTULO_ESCOLHER_CANAIS_SHOPEE).checked).toBe(true);
    expect(onMudar).not.toHaveBeenCalled();
    await act(async () => {
      segunda.resolve(LOJA);
      await segunda.promise;
    });
    await waitFor(() => expect(onMudar).toHaveBeenCalledTimes(1));
    expect(onMudar).toHaveBeenCalledWith(escolhaInicialShopee(LOJA));
    await assentar();
    expect(onMudar).toHaveBeenCalledTimes(1);
    expect(h.canais).toHaveBeenCalledTimes(3);
  });

  it('a conta muda com a leitura em voo (some: `contaId` null; ou outra conta) ⇒ a resposta da conta ANTIGA não entra — nenhum `onMudar`, de volta a «Automática», sem carregando ⟷ QUASE-PAR: a mesma conta (outro campo mudou) ⇒ aplicada uma vez', async () => {
    const lida = adiada<RespostaCanaisShopee>();
    h.canais.mockReturnValueOnce(lida.promise);
    const { onMudar, rerenderCom, unmount } = show({ revisao: 1 });
    escolher();
    // The draft's tab names no conta that can answer any more.
    rerenderCom({ revisao: 1, contaId: null });
    await assentar();
    await act(async () => {
      lida.resolve(LOJA_AB);
      await lida.promise;
    });
    await assentar();
    expect(onMudar).not.toHaveBeenCalled();
    expect(secao().textContent).toContain(FRASE_LOGISTICA_RASCUNHO_SHOPEE);
    // The conta back: the choose is over, nothing was applied, nothing reads.
    rerenderCom({ revisao: 1 });
    await assentar();
    expect(onMudar).not.toHaveBeenCalled();
    expect(radio(ROTULO_LOGISTICA_AUTOMATICA_SHOPEE).checked).toBe(true);
    expect(screen.queryByTestId(`${RAIZ}-carregando`)).toBeNull();
    expect(h.canais).toHaveBeenCalledTimes(1);
    unmount();

    // Another conta: its own read runs (the observer, while choosing), and
    // the old conta's answer never becomes its prefill.
    const daOutra = adiada<RespostaCanaisShopee>();
    h.canais.mockReturnValueOnce(daOutra.promise);
    const outra = show({ revisao: 1 });
    escolher();
    outra.rerenderCom({ revisao: 1, contaId: 'int-12' });
    await assentar();
    await act(async () => {
      daOutra.resolve(LOJA_AB);
      await daOutra.promise;
    });
    await assentar();
    expect(outra.onMudar).not.toHaveBeenCalled();
    expect(radio(ROTULO_LOGISTICA_AUTOMATICA_SHOPEE).checked).toBe(true);
    expect(screen.queryByTestId(`${RAIZ}-carregando`)).toBeNull();
    outra.unmount();

    // QUASE-PAR: the same conta, another prop moved.
    const mesma = adiada<RespostaCanaisShopee>();
    h.canais.mockReturnValueOnce(mesma.promise);
    const terceiro = show({ revisao: 1 });
    escolher();
    terceiro.rerenderCom({ revisao: 1, legado: true });
    await act(async () => {
      mesma.resolve(LOJA_AB);
      await mesma.promise;
    });
    await waitFor(() => expect(terceiro.onMudar).toHaveBeenCalledTimes(1));
    expect(terceiro.onMudar).toHaveBeenCalledWith(escolhaInicialShopee(LOJA_AB));
  });

  it('⭐ F3: escondida por `<Activity mode="hidden">` com a leitura em voo ⇒ nada aplicado e, ao voltar, «Automática» marcada, sem carregando preso ⟷ sem esconder ⇒ aplicada uma vez', async () => {
    const lida = adiada<RespostaCanaisShopee>();
    h.canais.mockReturnValueOnce(lida.promise);
    const { onMudar, rerenderCom, unmount } = show();
    escolher();
    expect(screen.getByTestId(`${RAIZ}-carregando`)).toBeTruthy();
    rerenderCom({ oculta: true });
    await act(async () => {
      lida.resolve(LOJA_AB);
      await lida.promise;
    });
    await assentar();
    rerenderCom({});
    await assentar();
    expect(onMudar).not.toHaveBeenCalled();
    expect(radio(ROTULO_LOGISTICA_AUTOMATICA_SHOPEE).checked).toBe(true);
    expect(screen.queryByTestId(`${RAIZ}-carregando`)).toBeNull();
    expect(secao().textContent).toContain(FRASE_LOGISTICA_RASCUNHO_SHOPEE);
    unmount();

    const outra = adiada<RespostaCanaisShopee>();
    h.canais.mockReturnValueOnce(outra.promise);
    const segundo = show();
    escolher();
    segundo.rerenderCom({});
    await act(async () => {
      outra.resolve(LOJA_AB);
      await outra.promise;
    });
    await waitFor(() => expect(segundo.onMudar).toHaveBeenCalledTimes(1));
    expect(segundo.onMudar).toHaveBeenCalledWith(escolhaInicialShopee(LOJA_AB));
  });

  it('⛔ F3 QUASE: a leitura FALHA com a aba escondida ⇒ ao voltar, «Automática» — sem a falha nem carregando, e a escolha acabou: outra `revisaoDoProduto` não lê', async () => {
    const lida = adiada<RespostaCanaisShopee>();
    h.canais.mockReturnValueOnce(lida.promise);
    const { onMudar, rerenderCom } = show();
    escolher();
    rerenderCom({ oculta: true });
    await act(async () => {
      lida.reject(new ShopeeClientHttpError('Shopee caiu.', 500, null));
      await lida.promise.catch(() => undefined);
    });
    await assentar();
    // The re-shown observer resubscribes with the options of the last VISIBLE
    // commit, so the re-show itself may read once — and that read fails too:
    // a failure on screen must still never reopen a choose the hide ended.
    h.canais.mockRejectedValue(new ShopeeClientHttpError('Shopee caiu.', 500, null));
    rerenderCom({});
    await assentar();
    expect(radio(ROTULO_LOGISTICA_AUTOMATICA_SHOPEE).checked).toBe(true);
    expect(screen.queryByTestId(`${RAIZ}-falha`)).toBeNull();
    expect(screen.queryByTestId(`${RAIZ}-carregando`)).toBeNull();
    expect(onMudar).not.toHaveBeenCalled();
    // After the re-show, nothing reads for the ended choose.
    const depois = h.canais.mock.calls.length;
    rerenderCom({ revisao: 2 });
    await assentar();
    expect(h.canais.mock.calls.length).toBe(depois);
    expect(onMudar).not.toHaveBeenCalled();
  });

  it('⭐ F9: com uma resposta A em cache e uma nova B ⇒ aplica B, nunca A', async () => {
    const respostaA = resposta([canal(A)]);
    const respostaB = resposta([canal(B)]);
    h.canais.mockResolvedValueOnce(respostaA);
    const { onMudar, rerenderCom } = show({ valor: [on(A)] });
    await screen.findByTestId(idDaLinha(A));
    // The operator went back to «Automática» (no held list): A stays cached.
    rerenderCom({ valor: null });
    h.canais.mockResolvedValueOnce(respostaB);
    escolher();
    await waitFor(() => expect(onMudar).toHaveBeenCalledTimes(1));
    expect(onMudar).toHaveBeenCalledWith(escolhaInicialShopee(respostaB));
    expect(onMudar).not.toHaveBeenCalledWith(escolhaInicialShopee(respostaA));
    await assentar();
    expect(onMudar).toHaveBeenCalledTimes(1);
    expect(h.canais).toHaveBeenCalledTimes(2);
  });

  it('`editavel` vira false antes da resposta ⇒ nada aplicado ⟷ ainda editável ⇒ aplicado', async () => {
    const lida = adiada<RespostaCanaisShopee>();
    h.canais.mockReturnValueOnce(lida.promise);
    const { onMudar, rerenderCom, unmount } = show();
    escolher();
    // A save in flight, the reading turned `em-andamento`, …
    rerenderCom({ editavel: false });
    await act(async () => {
      lida.resolve(LOJA_AB);
      await lida.promise;
    });
    await assentar();
    expect(onMudar).not.toHaveBeenCalled();
    // The segment is back on «Automática» — never a loader nothing ends.
    expect(radio(ROTULO_LOGISTICA_AUTOMATICA_SHOPEE).checked).toBe(true);
    expect(screen.queryByTestId(`${RAIZ}-carregando`)).toBeNull();
    unmount();

    const outra = adiada<RespostaCanaisShopee>();
    h.canais.mockReturnValueOnce(outra.promise);
    const segundo = show();
    escolher();
    const atual = vi.fn<(valor: readonly Canal[] | null) => void>();
    segundo.rerenderCom({ editavel: true, onMudar: atual });
    await act(async () => {
      outra.resolve(LOJA_AB);
      await outra.promise;
    });
    await waitFor(() => expect(atual).toHaveBeenCalledTimes(1));
    expect(segundo.onMudar).not.toHaveBeenCalled();
  });

  it('⛔ QUASE: a leitura FALHA depois que `editavel` virou false ⇒ a escolha largada acaba — «Automática», sem a falha nem «Tentar de novo», também quando volta a ser editável', async () => {
    const lida = adiada<RespostaCanaisShopee>();
    h.canais.mockReturnValueOnce(lida.promise);
    const { onMudar, rerenderCom } = show();
    escolher();
    rerenderCom({ editavel: false });
    await act(async () => {
      lida.reject(new ShopeeClientHttpError('Shopee caiu.', 500, null));
      await lida.promise.catch(() => undefined);
    });
    await assentar();
    expect(radio(ROTULO_LOGISTICA_AUTOMATICA_SHOPEE).checked).toBe(true);
    expect(screen.queryByTestId(`${RAIZ}-falha`)).toBeNull();
    rerenderCom({ editavel: true });
    await assentar();
    expect(radio(ROTULO_LOGISTICA_AUTOMATICA_SHOPEE).checked).toBe(true);
    expect(screen.queryByTestId(`${RAIZ}-falha`)).toBeNull();
    expect(h.canais).toHaveBeenCalledTimes(1);
    expect(onMudar).not.toHaveBeenCalled();
  });

  it('desmontada antes da resposta ⇒ nada aplicado', async () => {
    const lida = adiada<RespostaCanaisShopee>();
    h.canais.mockReturnValueOnce(lida.promise);
    const { onMudar, unmount } = show();
    escolher();
    // «Desfazer alterações» remounts the section (its `key`).
    unmount();
    await act(async () => {
      lida.resolve(LOJA_AB);
      await lida.promise;
    });
    await assentar();
    expect(onMudar).not.toHaveBeenCalled();
  });

  it('escolhida ⇒ «Automática» ⇒ `onMudar(null)` uma vez ⟷ QUASE-PAR: «Automática» durante a leitura (o valor já é null) ⇒ nenhum `onMudar`', async () => {
    const { onMudar, unmount } = show({ valor: [on(A)] });
    await screen.findByTestId(idDaLinha(A));
    automatica();
    expect(onMudar).toHaveBeenCalledTimes(1);
    expect(onMudar).toHaveBeenCalledWith(null);
    unmount();

    const lida = adiada<RespostaCanaisShopee>();
    h.canais.mockReturnValueOnce(lida.promise);
    const segundo = show();
    escolher();
    automatica();
    expect(segundo.onMudar).not.toHaveBeenCalled();
    await act(async () => {
      lida.resolve(LOJA_AB);
      await lida.promise;
    });
  });

  it('«Automática» durante a leitura encerra a escolha: outra `revisaoDoProduto` depois NÃO lê ⟷ QUASE-PAR: com uma lista no formulário, a revisão nova lê (F5)', async () => {
    const lida = adiada<RespostaCanaisShopee>();
    h.canais.mockReturnValueOnce(lida.promise);
    const { onMudar, rerenderCom } = show();
    escolher();
    automatica();
    await act(async () => {
      lida.resolve(LOJA_AB);
      await lida.promise;
    });
    rerenderCom({ revisao: 2 });
    await assentar();
    expect(h.canais).toHaveBeenCalledTimes(1);
    expect(onMudar).not.toHaveBeenCalled();

    rerenderCom({ valor: [on(A)], revisao: 2 });
    await waitFor(() => expect(h.canais).toHaveBeenCalledTimes(2));
  });
});

/* -------------------------------------------------------------------------- */
/*                              A read that fails                              */
/* -------------------------------------------------------------------------- */

describe('LogisticaRascunhoShopee — uma leitura que falha', () => {
  it('falha repetível (503) ⇒ a frase + «Tentar de novo» ⟷ ⛔ um 404 do produto ⇒ a frase, sem botão', async () => {
    // The 503 is retried by `shopeeQueryRetry` (as in the app); only the
    // backoff between attempts is shortened here.
    const qc = new QueryClient({
      defaultOptions: {
        ...QUERY_DEFAULT_OPTIONS,
        queries: { ...QUERY_DEFAULT_OPTIONS.queries, retryDelay: 0 },
      },
    });
    const indisponivel = 'A integração com a Shopee está indisponível no momento.';
    h.canais.mockRejectedValue(new ShopeeClientHttpError(indisponivel, 503, null));
    const { unmount } = show({ valor: [on(A)] }, qc);
    const falha = await screen.findByTestId(`${RAIZ}-falha`);
    expect(falha.textContent).toContain(indisponivel);
    const tentar = within(falha).getByRole('button', { name: ROTULO_TENTAR_DE_NOVO_CANAIS_SHOPEE });
    const antes = h.canais.mock.calls.length;
    h.canais.mockResolvedValue(LOJA_AB);
    fireEvent.click(tentar);
    await screen.findByTestId(idDaLinha(A));
    expect(h.canais.mock.calls.length).toBe(antes + 1);
    unmount();

    const naoEncontrado = 'Produto prod-1 não encontrado.';
    h.canais.mockRejectedValue(new ShopeeClientHttpError(naoEncontrado, 404, null));
    show({ valor: [on(A)] });
    const falha404 = await screen.findByTestId(`${RAIZ}-falha`);
    expect(falha404.textContent).toContain(naoEncontrado);
    expect(within(falha404).queryByRole('button')).toBeNull();
  });

  it('⭐ com uma lista GUARDADA, «Tentar de novo» numa falha repetível LÊ de novo — as linhas voltam ⟷ ⛔ nunca põe a guardada de volta sobre a edição do operador', async () => {
    const qc = new QueryClient({
      defaultOptions: {
        ...QUERY_DEFAULT_OPTIONS,
        queries: { ...QUERY_DEFAULT_OPTIONS.queries, retryDelay: 0 },
      },
    });
    h.canais.mockRejectedValue(new ShopeeClientHttpError('Shopee caiu.', 503, null));
    // A stored, stamped draft (`guardada` = the held list) the operator edited: B switched ON.
    const { onMudar } = show({ valor: [on(A), on(B)], guardada: [on(A)] }, qc);
    const falha = await screen.findByTestId(`${RAIZ}-falha`);
    const antes = h.canais.mock.calls.length;
    h.canais.mockResolvedValue(LOJA_AB);
    fireEvent.click(
      within(falha).getByRole('button', { name: ROTULO_TENTAR_DE_NOVO_CANAIS_SHOPEE }),
    );
    await screen.findByTestId(idDaLinha(A));
    expect(h.canais.mock.calls.length).toBe(antes + 1);
    expect(interruptor(B).checked).toBe(true);
    await assentar();
    // Never the held list put back over the edit: a retry only reads.
    expect(onMudar).not.toHaveBeenCalled();
  });

  it('escolhendo, uma falha repetível mostra a frase e «Tentar de novo», que escolhe de novo (lê e aplica) ⟷ QUASE-PAR: um erro que o cliente não descreve (FirebaseError do token) mostra `FRASE_FALHA_CANAIS_SHOPEE`, sem botão, e nada aplicado', async () => {
    h.canais.mockRejectedValueOnce(new ShopeeClientHttpError('Shopee caiu.', 500, null));
    const { onMudar, unmount } = show();
    escolher();
    const falha = await screen.findByTestId(`${RAIZ}-falha`);
    expect(falha.textContent).toContain('Shopee caiu.');
    expect(radio(ROTULO_ESCOLHER_CANAIS_SHOPEE).checked).toBe(true);
    expect(onMudar).not.toHaveBeenCalled();
    h.canais.mockResolvedValueOnce(LOJA_AB);
    fireEvent.click(
      within(falha).getByRole('button', { name: ROTULO_TENTAR_DE_NOVO_CANAIS_SHOPEE }),
    );
    await waitFor(() => expect(onMudar).toHaveBeenCalledTimes(1));
    expect(onMudar).toHaveBeenCalledWith(escolhaInicialShopee(LOJA_AB));
    unmount();

    h.canais.mockRejectedValueOnce(new FirebaseError('auth/network-request-failed', 'token'));
    const segundo = show();
    escolher();
    const falhaDoToken = await screen.findByTestId(`${RAIZ}-falha`);
    expect(falhaDoToken.textContent).toContain(FRASE_FALHA_CANAIS_SHOPEE);
    expect(within(falhaDoToken).queryByRole('button')).toBeNull();
    await assentar();
    expect(segundo.onMudar).not.toHaveBeenCalled();
  });

  it('⭐ uma escolha que FALHOU e depois outra `revisaoDoProduto` ⇒ de volta a «Automática» — sem carregando preso, sem leitura nova, nada aplicado ⟷ QUASE-PAR: «Escolher canais» de novo lê e aplica uma vez', async () => {
    h.canais.mockRejectedValueOnce(new ShopeeClientHttpError('Shopee caiu.', 500, null));
    const { onMudar, rerenderCom } = show();
    escolher();
    await screen.findByTestId(`${RAIZ}-falha`);
    expect(h.canais).toHaveBeenCalledTimes(1);
    // The produto is written meanwhile (a save; a sale's stamp): another key,
    // whose read would answer.
    h.canais.mockResolvedValue(LOJA_AB);
    rerenderCom({ revisao: 2 });
    await assentar();
    expect(screen.queryByTestId(`${RAIZ}-carregando`)).toBeNull();
    expect(screen.queryByTestId(`${RAIZ}-falha`)).toBeNull();
    expect(radio(ROTULO_LOGISTICA_AUTOMATICA_SHOPEE).checked).toBe(true);
    expect(secao().textContent).toContain(FRASE_LOGISTICA_RASCUNHO_SHOPEE);
    // The choose is over: nothing reads for it, nothing lands from later data.
    expect(h.canais).toHaveBeenCalledTimes(1);
    expect(onMudar).not.toHaveBeenCalled();

    // Never a dead end: «Escolher canais» again reads and applies once.
    escolher();
    await waitFor(() => expect(onMudar).toHaveBeenCalledTimes(1));
    expect(onMudar).toHaveBeenCalledWith(escolhaInicialShopee(LOJA_AB));
    expect(h.canais).toHaveBeenCalledTimes(2);
  });

  it('⛔ QUASE: a leitura de «Escolher canais» FALHA depois que a `revisaoDoProduto` mudou ⇒ a escolha acaba — «Automática», sem a frase da falha nem «Tentar de novo», mesmo com a leitura da revisão nova falhando também ⟷ QUASE-PAR: a mesma revisão (outro campo mudou) ⇒ a frase + «Tentar de novo»', async () => {
    const lida = adiada<RespostaCanaisShopee>();
    h.canais.mockReturnValueOnce(lida.promise);
    // Every later read fails too — the observer's read of the new key included.
    h.canais.mockRejectedValue(new ShopeeClientHttpError('Shopee caiu.', 500, null));
    const { onMudar, rerenderCom, unmount } = show({ revisao: 1 });
    escolher();
    rerenderCom({ revisao: 2 });
    await assentar();
    await act(async () => {
      lida.reject(new ShopeeClientHttpError('Shopee caiu.', 500, null));
      await lida.promise.catch(() => undefined);
    });
    await assentar();
    expect(radio(ROTULO_LOGISTICA_AUTOMATICA_SHOPEE).checked).toBe(true);
    expect(screen.queryByTestId(`${RAIZ}-falha`)).toBeNull();
    expect(screen.queryByRole('button', { name: ROTULO_TENTAR_DE_NOVO_CANAIS_SHOPEE })).toBeNull();
    expect(screen.queryByTestId(`${RAIZ}-carregando`)).toBeNull();
    expect(secao().textContent).toContain(FRASE_LOGISTICA_RASCUNHO_SHOPEE);
    expect(onMudar).not.toHaveBeenCalled();
    // The click's read + the observer's read of the new key; nothing after.
    expect(h.canais).toHaveBeenCalledTimes(2);
    unmount();

    // QUASE-PAR: the same revision, another prop moved — the failure shows.
    const outra = adiada<RespostaCanaisShopee>();
    h.canais.mockReturnValueOnce(outra.promise);
    const segundo = show({ revisao: 1 });
    escolher();
    segundo.rerenderCom({ revisao: 1, legado: true });
    await act(async () => {
      outra.reject(new ShopeeClientHttpError('Shopee caiu.', 500, null));
      await outra.promise.catch(() => undefined);
    });
    const falha = await screen.findByTestId(`${RAIZ}-falha`);
    expect(falha.textContent).toContain('Shopee caiu.');
    expect(
      within(falha).getByRole('button', { name: ROTULO_TENTAR_DE_NOVO_CANAIS_SHOPEE }),
    ).toBeTruthy();
    expect(radio(ROTULO_ESCOLHER_CANAIS_SHOPEE).checked).toBe(true);
    expect(segundo.onMudar).not.toHaveBeenCalled();
  });

  it('uma escolha que FALHOU, e a lista de outra aba que chega e volta a «Automática» ⇒ «Automática», sem carregando preso nem `onMudar`', async () => {
    h.canais.mockRejectedValueOnce(new ShopeeClientHttpError('Shopee caiu.', 500, null));
    const { onMudar, rerenderCom } = show();
    escolher();
    await screen.findByTestId(`${RAIZ}-falha`);
    h.canais.mockResolvedValue(LOJA_AB);
    // Another tab stores a list (this tab's entry is clean: the form follows) …
    rerenderCom({ valor: [on(A)] });
    await screen.findByTestId(idDaLinha(A));
    // … and later switches back to «Automática».
    rerenderCom({ valor: null });
    await assentar();
    expect(screen.queryByTestId(`${RAIZ}-carregando`)).toBeNull();
    expect(screen.queryByTestId(`${RAIZ}-falha`)).toBeNull();
    expect(radio(ROTULO_LOGISTICA_AUTOMATICA_SHOPEE).checked).toBe(true);
    expect(onMudar).not.toHaveBeenCalled();
  });

  it('`lerParaEscolherCanaisShopee`: `ShopeeClientHttpError`, `ShopeeClientNetworkError` e `FirebaseError` ⇒ null ⟷ ⛔ um `TypeError` ⇒ rejeita', async () => {
    const falhando = (err: unknown) => () => Promise.reject(err);
    await expect(
      lerParaEscolherCanaisShopee(falhando(new ShopeeClientHttpError('x', 502, null))),
    ).resolves.toBeNull();
    await expect(
      lerParaEscolherCanaisShopee(
        falhando(new ShopeeClientRespostaInvalidaError('x', 200, ['medidasCompletas'])),
      ),
    ).resolves.toBeNull();
    await expect(
      lerParaEscolherCanaisShopee(falhando(new ShopeeClientNetworkError('x'))),
    ).resolves.toBeNull();
    await expect(
      lerParaEscolherCanaisShopee(falhando(new FirebaseError('auth/internal-error', 'x'))),
    ).resolves.toBeNull();
    // A success passes through untouched.
    await expect(lerParaEscolherCanaisShopee(() => Promise.resolve(LOJA_AB))).resolves.toBe(
      LOJA_AB,
    );
    // Anything else is a bug: rethrown (rule 6).
    await expect(
      lerParaEscolherCanaisShopee(falhando(new TypeError('quebrou'))),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

/* -------------------------------------------------------------------------- */
/*                                  The rows                                   */
/* -------------------------------------------------------------------------- */

describe('LogisticaRascunhoShopee — as linhas', () => {
  it('obrigatório: switch marcado e desabilitado + a frase; bloqueado: checkbox desabilitado e desmarcado + a frase; indisponível desligado: switch desabilitado + o motivo ⟷ indisponível ligado: switch habilitado + «Ligado, mas não vai na publicação: » + o motivo', async () => {
    const motivo = FRASE_INDISPONIVEL_CANAL_SHOPEE[NAO_CABE];
    const { unmount } = show({ valor: [on(A), on(F, true)] });
    await screen.findByTestId(idDaLinha(E));

    // E: compulsory — ON although the value does not name it, locked.
    expect(interruptor(E).checked).toBe(true);
    expect(interruptor(E).disabled).toBe(true);
    expect(linhaDo(E).textContent).toContain(FRASE_CANAL_OBRIGATORIO_SHOPEE);
    // F: free shipping blocked — unchecked over a stored `true`, disabled.
    expect(freteGratis(F).checked).toBe(false);
    expect(freteGratis(F).disabled).toBe(true);
    expect(linhaDo(F).textContent).toContain(FRASE_FRETE_GRATIS_BLOQUEADO_SHOPEE);
    expect(interruptor(F).disabled).toBe(false);
    // D: unavailable and OFF — cannot be turned on; the reason, no prefix.
    expect(interruptor(D).checked).toBe(false);
    expect(interruptor(D).disabled).toBe(true);
    expect(linhaDo(D).textContent).toContain(motivo);
    expect(linhaDo(D).textContent).not.toContain(PREFIXO_LIGADO_INDISPONIVEL_SHOPEE);
    // G: compulsory AND unavailable — ON, locked, both sentences (D16-3).
    expect(interruptor(G).checked).toBe(true);
    expect(interruptor(G).disabled).toBe(true);
    expect(linhaDo(G).textContent).toContain(FRASE_CANAL_OBRIGATORIO_SHOPEE);
    expect(linhaDo(G).textContent).toContain(`${PREFIXO_LIGADO_INDISPONIVEL_SHOPEE}${motivo}`);
    // NEAR-MISS: a plain ON channel — enabled, no row sentence.
    expect(interruptor(A).checked).toBe(true);
    expect(interruptor(A).disabled).toBe(false);
    expect(freteGratis(A).disabled).toBe(false);
    expect(linhaDo(A).textContent).not.toContain(FRASE_CANAL_OBRIGATORIO_SHOPEE);
    expect(linhaDo(A).textContent).not.toContain(FRASE_FRETE_GRATIS_BLOQUEADO_SHOPEE);
    unmount();

    // QUASE-PAR: the same unavailable D, stored ON — it can be turned off.
    show({ valor: [on(D)] });
    await screen.findByTestId(idDaLinha(D));
    expect(interruptor(D).checked).toBe(true);
    expect(interruptor(D).disabled).toBe(false);
    expect(linhaDo(D).textContent).toContain(`${PREFIXO_LIGADO_INDISPONIVEL_SHOPEE}${motivo}`);
  });

  it('linhas na ordem da DTO; o não selecionável sem linha; a linha dos canais fora da loja', async () => {
    show({ valor: [on(A), on(C), on(AUSENTE)] });
    await screen.findByTestId(idDaLinha(A));
    const ordem = within(secao())
      .getAllByTestId(/^shopee-logistica-/)
      .map((el) => el.getAttribute('data-testid'));
    expect(ordem).toEqual([B, A, D, E, F, G].map(idDaLinha));
    expect(screen.queryByTestId(idDaLinha(C))).toBeNull();
    expect(screen.queryByTestId(idDaLinha(AUSENTE))).toBeNull();
    const fora = screen.getByTestId(`${RAIZ}-fora-da-loja`);
    expect(fora.textContent).toBe(
      fraseDosCanaisForaDaLojaShopee([
        { logisticId: C, nome: 'Entrega C' },
        { logisticId: AUSENTE, nome: null },
      ]),
    );
    expect(fora.textContent).toBe(
      'Canais gravados que a loja não oferece mais (não vão na publicação e saem da lista ao salvar): Entrega C, Canal 90099.',
    );
  });

  it('QUASE-PAR: nenhum canal fora da loja ⇒ sem a linha', async () => {
    show({ valor: [on(A), off(B)] });
    await screen.findByTestId(idDaLinha(A));
    expect(screen.queryByTestId(`${RAIZ}-fora-da-loja`)).toBeNull();
  });

  it('⭐ `editavel: false` ⇒ todos os controles DESABILITADOS e ainda renderizados ⟷ true ⇒ habilitados', async () => {
    const valor = [on(A), off(B)];
    const { rerenderCom } = show({ valor, editavel: false });
    await screen.findByTestId(idDaLinha(A));
    const interruptores = within(secao()).getAllByRole('switch') as HTMLInputElement[];
    const caixas = within(secao()).getAllByRole('checkbox') as HTMLInputElement[];
    const radios = within(secao()).getAllByRole('radio') as HTMLInputElement[];
    expect(interruptores).toHaveLength(6);
    expect(caixas).toHaveLength(6);
    expect(radios).toHaveLength(2);
    for (const c of [...interruptores, ...caixas, ...radios]) expect(c.disabled).toBe(true);

    rerenderCom({ valor, editavel: true });
    expect(interruptor(A).disabled).toBe(false);
    expect(interruptor(B).disabled).toBe(false);
    expect(freteGratis(A).disabled).toBe(false);
    expect(radio(ROTULO_LOGISTICA_AUTOMATICA_SHOPEE).disabled).toBe(false);
    expect(radio(ROTULO_ESCOLHER_CANAIS_SHOPEE).disabled).toBe(false);
  });

  it('⭐ as duas formas desligadas abrem sem `onMudar` (não sujo) ⟷ um toggle chama `onMudar` uma vez com `comCanalShopee(…)`', async () => {
    h.canais.mockResolvedValue(LOJA_AB);
    const explicito = show({ valor: [on(A), off(B)] });
    await screen.findByTestId(idDaLinha(B));
    await assentar();
    expect(interruptor(B).checked).toBe(false);
    expect(explicito.onMudar).not.toHaveBeenCalled();
    explicito.unmount();

    const valor = [on(A)];
    const ausente = show({ valor });
    await screen.findByTestId(idDaLinha(B));
    await assentar();
    expect(interruptor(B).checked).toBe(false);
    expect(ausente.onMudar).not.toHaveBeenCalled();

    fireEvent.click(interruptor(B));
    expect(ausente.onMudar).toHaveBeenCalledTimes(1);
    expect(ausente.onMudar).toHaveBeenLastCalledWith(
      comCanalShopee(valor, LOJA_AB, B, { ligado: true }),
    );
    fireEvent.click(freteGratis(A));
    expect(ausente.onMudar).toHaveBeenCalledTimes(2);
    expect(ausente.onMudar).toHaveBeenLastCalledWith(
      comCanalShopee(valor, LOJA_AB, A, { freteGratis: true }),
    );
  });

  it("a frase de zero-ligado vem de `logisticaInvalida` 'sem-canal-ligado' ⟷ ⛔ um valor sem ligado com `logisticaInvalida` null ⇒ sem frase", async () => {
    h.canais.mockResolvedValue(LOJA_AB);
    const valor = [off(A), off(B)];
    const { rerenderCom } = show({
      valor,
      logisticaInvalida: MOTIVO_DA_LOGISTICA_INVALIDA_SHOPEE.semCanalLigado,
    });
    await screen.findByTestId(idDaLinha(A));
    expect(secao().textContent).toContain(FRASE_NENHUM_CANAL_LIGADO_SHOPEE);
    // The same value, untouched by the plan (an untouched stored value is
    // never validated): no sentence — never re-derived from the value.
    rerenderCom({ valor, logisticaInvalida: null });
    expect(secao().textContent).not.toContain(FRASE_NENHUM_CANAL_LIGADO_SHOPEE);
    // Another verdict is not this sentence either.
    rerenderCom({ valor, logisticaInvalida: MOTIVO_DA_LOGISTICA_INVALIDA_SHOPEE.invalida });
    expect(secao().textContent).not.toContain(FRASE_NENHUM_CANAL_LIGADO_SHOPEE);
  });

  it('aviso nenhum-ligado-disponível: `[{D,on}]` ⇒ a frase ⟷ `[{A,on}]` ⇒ sem', async () => {
    // No compulsory channel here: an available one is always ON (D16-3).
    h.canais.mockResolvedValue(
      resposta([canal(A), canal(D, { indisponivel: NAO_CABE, automatica: null })]),
    );
    const { rerenderCom } = show({ valor: [on(D)] });
    await screen.findByTestId(idDaLinha(D));
    expect(secao().textContent).toContain(FRASE_NENHUM_CANAL_LIGADO_DISPONIVEL_SHOPEE);
    rerenderCom({ valor: [on(A)] });
    expect(secao().textContent).not.toContain(FRASE_NENHUM_CANAL_LIGADO_DISPONIVEL_SHOPEE);
  });

  it('`medidasCompletas: false` ⇒ a frase das medidas ⟷ true ⇒ não; a base da conferência sempre', async () => {
    h.canais.mockResolvedValue(resposta([canal(B), canal(A)], false));
    const { unmount } = show({ valor: [on(A)] });
    await screen.findByTestId(idDaLinha(A));
    expect(secao().textContent).toContain(FRASE_MEDIDAS_INCOMPLETAS_CANAIS_SHOPEE);
    expect(secao().textContent).toContain(FRASE_BASE_DA_CONFERENCIA_CANAIS_SHOPEE);
    unmount();

    h.canais.mockResolvedValue(resposta([canal(B), canal(A)], true));
    show({ valor: [on(A)] });
    await screen.findByTestId(idDaLinha(A));
    expect(secao().textContent).not.toContain(FRASE_MEDIDAS_INCOMPLETAS_CANAIS_SHOPEE);
    expect(secao().textContent).toContain(FRASE_BASE_DA_CONFERENCIA_CANAIS_SHOPEE);
  });

  it('nenhum selecionável ⇒ a frase da loja sem canal (D16-18: com a de zero-ligado, sem o aviso de nenhum disponível)', async () => {
    h.canais.mockResolvedValue(resposta([canal(C, { selecionavel: false, automatica: null })]));
    show({ valor: [], logisticaInvalida: MOTIVO_DA_LOGISTICA_INVALIDA_SHOPEE.semCanalLigado });
    await screen.findByText(FRASE_SEM_CANAL_SELECIONAVEL_SHOPEE);
    expect(screen.queryByRole('switch')).toBeNull();
    expect(secao().textContent).toContain(FRASE_NENHUM_CANAL_LIGADO_SHOPEE);
    expect(secao().textContent).not.toContain(FRASE_NENHUM_CANAL_LIGADO_DISPONIVEL_SHOPEE);
    expect(screen.queryByTestId(`${RAIZ}-fora-da-loja`)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                     Accessibility, the keyboard, the focus                  */
/* -------------------------------------------------------------------------- */

describe('LogisticaRascunhoShopee — acessibilidade, teclado e o id do campo', () => {
  it('cada linha é um `group` com o nome do canal, com switch «Ligado» e checkbox; radiogroup «Logística (canais de envio)»', async () => {
    h.canais.mockResolvedValue(resposta([canal(A), canal(B, { nome: null })]));
    show({ valor: [on(A)] });
    await screen.findByTestId(idDaLinha(A));
    expect(screen.getByRole('radiogroup', { name: ROTULO_LOGISTICA_RASCUNHO_SHOPEE })).toBeTruthy();
    const grupoA = screen.getByRole('group', { name: 'Entrega A (90003)' });
    expect(
      within(grupoA).getByRole('switch', {
        name: (n) => n.startsWith(ROTULO_CANAL_LIGADO_SHOPEE),
      }),
    ).toBeTruthy();
    expect(
      within(grupoA).getByRole('checkbox', { name: ROTULO_FRETE_GRATIS_CANAL_SHOPEE }),
    ).toBeTruthy();
    // A channel with no name is named by its id.
    expect(screen.getByRole('group', { name: 'Canal 90005 (90005)' })).toBeTruthy();
    expect(rotuloDoCanalLogisticaShopee(B, null)).toBe('Canal 90005');
    expect(rotuloDoCanalLogisticaShopee(B, 'Entrega B')).toBe('Entrega B');
  });

  it('Enter num switch, checkbox ou segmento ⇒ `defaultPrevented` ⟷ Espaço passa', async () => {
    h.canais.mockResolvedValue(LOJA_AB);
    show({ valor: [on(A)] });
    await screen.findByTestId(idDaLinha(A));
    const controles = [interruptor(A), freteGratis(A), radio(ROTULO_LOGISTICA_AUTOMATICA_SHOPEE)];
    for (const c of controles) {
      expect(fireEvent.keyDown(c, { key: 'Enter', code: 'Enter' })).toBe(false);
      expect(fireEvent.keyDown(c, { key: ' ', code: 'Space' })).toBe(true);
    }
  });

  it('o id do campo: no contêiner das linhas quando há linhas que se movem ⟷ na raiz da seção quando não há linhas', async () => {
    const id = idDoCampoRascunhoShopee(LINK, CAMPO_RASCUNHO_SHOPEE.logisticInfo);
    const lida = adiada<RespostaCanaisShopee>();
    h.canais.mockReturnValueOnce(lida.promise);
    const { unmount } = show({ valor: [on(A)] });
    // Still reading: no rows yet — the root carries it.
    expect(document.getElementById(id)).toBe(secao());
    await act(async () => {
      lida.resolve(LOJA_AB);
      await lida.promise;
    });
    await screen.findByTestId(idDaLinha(A));
    const alvo = document.getElementById(id);
    expect(alvo).not.toBeNull();
    expect(alvo).not.toBe(secao());
    expect(document.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
    // Its first enabled control is the first row's «Ligado» (DTO order: B).
    expect(alvo?.querySelector('input:not([disabled])')).toBe(interruptor(B));
    expect(alvo?.contains(radio(ROTULO_LOGISTICA_AUTOMATICA_SHOPEE))).toBe(false);
    unmount();

    // «Automática»: no rows — the root.
    show();
    expect(document.getElementById(id)).toBe(secao());
  });

  it('⭐ o primeiro controle HABILITADO das linhas, na ordem da DTO: uma primeira linha desligada e indisponível (os DOIS controles travados, Q-F1 b) dá o «Ligado» da linha SEGUINTE, nunca o «Frete grátis…» dela ⟷ QUASE-PAR: uma primeira linha disponível dá o seu «Ligado»; o mesmo D LIGADO dá o seu «Ligado»', async () => {
    const id = idDoCampoRascunhoShopee(LINK, CAMPO_RASCUNHO_SHOPEE.logisticInfo);
    const indisponivel = canal(D, { indisponivel: NAO_CABE, automatica: null });
    const primeiroHabilitado = () =>
      document.getElementById(id)?.querySelector('input:not([disabled])');
    h.canais.mockResolvedValue(resposta([indisponivel, canal(A)]));
    const morta = show({ valor: [on(A)] });
    await screen.findByTestId(idDaLinha(D));
    expect(interruptor(D).disabled).toBe(true);
    expect(freteGratis(D).disabled).toBe(true);
    expect(document.getElementById(id)).not.toBe(secao());
    expect(primeiroHabilitado()).toBe(interruptor(A));
    expect(primeiroHabilitado()).not.toBe(freteGratis(D));
    morta.unmount();

    // QUASE-PAR: the same unavailable D, stored ON — it can be switched off: its own «Ligado».
    const ligada = show({ valor: [on(A), on(D)] });
    await screen.findByTestId(idDaLinha(D));
    expect(primeiroHabilitado()).toBe(interruptor(D));
    ligada.unmount();

    // QUASE-PAR: an available first row gives its own «Ligado».
    h.canais.mockResolvedValue(resposta([canal(A), indisponivel]));
    show({ valor: [on(A)] });
    await screen.findByTestId(idDaLinha(D));
    expect(primeiroHabilitado()).toBe(interruptor(A));
  });

  it('⭐ Q-F1 (b): o «Frete grátis…» de uma linha DESLIGADA e indisponível fica DESABILITADO — ainda renderizado, mostrando o valor guardado — e o clique não chama `onMudar` ⟷ ⛔ QUASE: o mesmo D LIGADO, habilitado; um desligado DISPONÍVEL (B), habilitado', async () => {
    const loja = resposta([
      canal(B),
      canal(A),
      canal(D, { indisponivel: NAO_CABE, automatica: null }),
    ]);
    h.canais.mockResolvedValue(loja);
    const marcado = show({ valor: [on(A), off(B), off(D, true)] });
    await screen.findByTestId(idDaLinha(D));
    await assentar();
    expect(freteGratis(D).disabled).toBe(true);
    expect(freteGratis(D).checked).toBe(true);
    fireEvent.click(freteGratis(D));
    // jsdom still hands a click on a DISABLED checkbox to React's `onChange`
    // (measured), so this pins `comCanalShopee`'s refusal through the section;
    // in a browser the `disabled` above is the guard.
    expect(marcado.onMudar).not.toHaveBeenCalled();
    // No new copy: the switch's own reason speaks; the blocked sentence is F's alone.
    expect(linhaDo(D).textContent).toContain(FRASE_INDISPONIVEL_CANAL_SHOPEE[NAO_CABE]);
    expect(linhaDo(D).textContent).not.toContain(FRASE_FRETE_GRATIS_BLOQUEADO_SHOPEE);
    // ⛔ QUASE: an OFF but AVAILABLE row's checkbox is enabled, and a click sends.
    expect(freteGratis(B).disabled).toBe(false);
    fireEvent.click(freteGratis(B));
    expect(marcado.onMudar).toHaveBeenCalledTimes(1);
    expect(marcado.onMudar).toHaveBeenLastCalledWith(
      comCanalShopee([on(A), off(B), off(D, true)], loja, B, { freteGratis: true }),
    );
    marcado.unmount();

    // Unticked in the value: shown unticked, still disabled.
    const desmarcado = show({ valor: [on(A), off(D)] });
    await screen.findByTestId(idDaLinha(D));
    expect(freteGratis(D).checked).toBe(false);
    expect(freteGratis(D).disabled).toBe(true);
    desmarcado.unmount();

    // ⛔ QUASE: the same D stored ON («Ligado, mas não vai na publicação») — enabled, a click sends.
    const valor = [on(D)];
    const ligado = show({ valor });
    await screen.findByTestId(idDaLinha(D));
    expect(linhaDo(D).textContent).toContain(PREFIXO_LIGADO_INDISPONIVEL_SHOPEE);
    expect(freteGratis(D).disabled).toBe(false);
    fireEvent.click(freteGratis(D));
    expect(ligado.onMudar).toHaveBeenCalledTimes(1);
    expect(ligado.onMudar).toHaveBeenLastCalledWith(
      comCanalShopee(valor, loja, D, { freteGratis: true }),
    );
  });

  it('⭐ o id do campo vai para a RAIZ quando NENHUMA linha tem um controle que se move — todas desligadas e indisponíveis, ou um obrigatório ligado de frete bloqueado com uma indisponível desligada — e o primeiro habilitado é o rádio «Automática» (a saída) ⟷ QUASE-PAR: uma linha com um controle habilitado ⇒ no contêiner das linhas, também com `editavel: false`', async () => {
    const id = idDoCampoRascunhoShopee(LINK, CAMPO_RASCUNHO_SHOPEE.logisticInfo);
    const indisponivel = canal(D, { indisponivel: NAO_CABE, automatica: null });
    const comId = () => document.querySelectorAll(`[id="${id}"]`);
    const primeiroHabilitado = () =>
      document.getElementById(id)?.querySelector('input:not([disabled])');

    // Every row OFF and unavailable (the zero-ON refusal routes here).
    h.canais.mockResolvedValue(resposta([indisponivel]));
    const so = show({
      valor: [off(D)],
      logisticaInvalida: MOTIVO_DA_LOGISTICA_INVALIDA_SHOPEE.semCanalLigado,
    });
    await screen.findByTestId(idDaLinha(D));
    expect(document.getElementById(id)).toBe(secao());
    expect(comId()).toHaveLength(1);
    expect(primeiroHabilitado()).toBe(radio(ROTULO_LOGISTICA_AUTOMATICA_SHOPEE));
    so.unmount();

    // The mix: compulsory ON with its free shipping blocked, then an OFF unavailable row.
    h.canais.mockResolvedValue(
      resposta([
        canal(E, { obrigatorio: true, bloqueiaFreteGratisDoVendedor: true }),
        indisponivel,
      ]),
    );
    const misto = show({ valor: [on(E)] });
    await screen.findByTestId(idDaLinha(D));
    for (const c of [interruptor(E), freteGratis(E), interruptor(D), freteGratis(D)]) {
      expect(c.disabled).toBe(true);
    }
    expect(document.getElementById(id)).toBe(secao());
    expect(comId()).toHaveLength(1);
    expect(primeiroHabilitado()).toBe(radio(ROTULO_LOGISTICA_AUTOMATICA_SHOPEE));
    misto.unmount();

    // QUASE-PAR: the same mix, the compulsory's free shipping NOT blocked — the
    // rows' container, and the focus takes that checkbox (its switch is locked ON).
    h.canais.mockResolvedValue(resposta([canal(E, { obrigatorio: true }), indisponivel]));
    const livre = show({ valor: [on(E)] });
    await screen.findByTestId(idDaLinha(D));
    expect(document.getElementById(id)).not.toBe(secao());
    expect(document.getElementById(id)?.contains(linhaDo(E))).toBe(true);
    expect(comId()).toHaveLength(1);
    expect(primeiroHabilitado()).toBe(freteGratis(E));
    livre.unmount();

    // QUASE-PAR, the other half: an OFF available row whose free shipping is
    // blocked (F) — only its switch moves, and that is enough for the rows.
    h.canais.mockResolvedValue(
      resposta([canal(F, { bloqueiaFreteGratisDoVendedor: true }), indisponivel]),
    );
    const soInterruptor = show({ valor: [off(F)] });
    await screen.findByTestId(idDaLinha(D));
    expect(freteGratis(F).disabled).toBe(true);
    expect(document.getElementById(id)).not.toBe(secao());
    expect(comId()).toHaveLength(1);
    expect(primeiroHabilitado()).toBe(interruptor(F));
    soInterruptor.unmount();

    // QUASE-PAR: the all-dead row plus ONE OFF available row — the rows' container, its «Ligado».
    h.canais.mockResolvedValue(resposta([indisponivel, canal(A)]));
    const { rerenderCom } = show({ valor: [off(D), off(A)] });
    await screen.findByTestId(idDaLinha(A));
    expect(document.getElementById(id)).not.toBe(secao());
    expect(comId()).toHaveLength(1);
    expect(primeiroHabilitado()).toBe(interruptor(A));
    // `editavel: false` disables every control but never moves the id.
    rerenderCom({ valor: [off(D), off(A)], editavel: false });
    expect(interruptor(A).disabled).toBe(true);
    expect(document.getElementById(id)).not.toBe(secao());
    expect(document.getElementById(id)?.contains(linhaDo(A))).toBe(true);
    expect(comId()).toHaveLength(1);
  });

  it('⛔ QUASE-PAR do `editavel: false` acima: com TODAS as linhas mortas, `editavel: false` deixa o id na RAIZ, como no editável — a colocação lê só as duas travas, nunca `editavel`', async () => {
    const id = idDoCampoRascunhoShopee(LINK, CAMPO_RASCUNHO_SHOPEE.logisticInfo);
    h.canais.mockResolvedValue(resposta([canal(D, { indisponivel: NAO_CABE, automatica: null })]));
    const { rerenderCom } = show({ valor: [off(D)] });
    await screen.findByTestId(idDaLinha(D));
    expect(document.getElementById(id)).toBe(secao());
    rerenderCom({ valor: [off(D)], editavel: false });
    expect(interruptor(D).disabled).toBe(true);
    expect(document.getElementById(id)).toBe(secao());
    expect(document.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/*                                    Copy                                     */
/* -------------------------------------------------------------------------- */

describe('LogisticaRascunhoShopee — as frases (design-C-LOG §5.3; P16 §7)', () => {
  it('são as do LOG, byte a byte — QC(a) (Lucas 2026-11-16): o aviso de nenhum disponível sem «a publicação será recusada»', () => {
    expect(ROTULO_LOGISTICA_RASCUNHO_SHOPEE).toBe('Logística (canais de envio)');
    expect(ROTULO_LOGISTICA_AUTOMATICA_SHOPEE).toBe('Automática');
    expect(ROTULO_ESCOLHER_CANAIS_SHOPEE).toBe('Escolher canais');
    expect(FRASE_SALVE_PARA_ESCOLHER_CANAIS_SHOPEE).toBe(
      'Salve o rascunho para escolher os canais de envio.',
    );
    expect(FRASE_LOGISTICA_DO_SISTEMA_ANTERIOR_SHOPEE).toBe(
      'Este rascunho guarda canais de envio do sistema anterior, que nunca foram enviados à Shopee. A publicação não os usa — vale a escolha automática. Para escolher os canais deste anúncio, use «Escolher canais» e salve o rascunho.',
    );
    expect(FRASE_CANAIS_ESCOLHIDOS_SHOPEE).toBe(
      'Só os canais ligados abaixo vão na publicação. O frete grátis vale por canal: a opção «Oferece frete grátis» do produto não vale para este anúncio.',
    );
    expect(FRASE_BASE_DA_CONFERENCIA_CANAIS_SHOPEE).toBe(
      'Conferido com o peso e as medidas salvos do produto.',
    );
    expect(FRASE_MEDIDAS_INCOMPLETAS_CANAIS_SHOPEE).toBe(
      'Cadastre o peso e as três medidas do produto e salve-o para o ERP conferir em quais canais o pacote cabe.',
    );
    expect(FRASE_LENDO_CANAIS_SHOPEE).toBe('Lendo os canais de envio da loja na Shopee…');
    expect(FRASE_FALHA_CANAIS_SHOPEE).toBe(
      'Não foi possível ler os canais de envio da loja na Shopee.',
    );
    expect(ROTULO_TENTAR_DE_NOVO_CANAIS_SHOPEE).toBe('Tentar de novo');
    expect(FRASE_SEM_CANAL_SELECIONAVEL_SHOPEE).toBe(
      'A loja não tem nenhum canal de envio ativo na Shopee. Ative um canal no Seller Centre.',
    );
    expect(ROTULO_CANAL_LIGADO_SHOPEE).toBe('Ligado');
    expect(ROTULO_FRETE_GRATIS_CANAL_SHOPEE).toBe(
      'Frete grátis para o comprador (pago pelo vendedor)',
    );
    expect(FRASE_FRETE_GRATIS_BLOQUEADO_SHOPEE).toBe(
      'A loja não permite frete grátis pago pelo vendedor neste canal.',
    );
    expect(FRASE_CANAL_OBRIGATORIO_SHOPEE).toBe('Obrigatório nesta loja: fica sempre ligado.');
    expect(FRASE_INDISPONIVEL_CANAL_SHOPEE).toEqual({
      'nao-cabe': 'O pacote do produto não cabe neste canal (peso ou medidas).',
      'limite-ilegivel':
        'A Shopee informou os limites deste canal numa unidade que o ERP não conhece: ele não vai na publicação.',
      'exige-valor-do-seller-centre':
        'Este canal pede um tamanho ou uma tarifa que só o Seller Centre define: o ERP não o envia.',
    });
    expect(PREFIXO_LIGADO_INDISPONIVEL_SHOPEE).toBe('Ligado, mas não vai na publicação: ');
    expect(FRASE_NENHUM_CANAL_LIGADO_SHOPEE).toBe(
      'Ligue ao menos um canal — ou volte para «Automática».',
    );
    expect(FRASE_NENHUM_CANAL_LIGADO_DISPONIVEL_SHOPEE).toBe(
      'Nenhum canal ligado aceita o pacote hoje.',
    );
    expect(FRASE_NENHUM_CANAL_LIGADO_DISPONIVEL_SHOPEE).not.toContain('recusada');
  });
});
