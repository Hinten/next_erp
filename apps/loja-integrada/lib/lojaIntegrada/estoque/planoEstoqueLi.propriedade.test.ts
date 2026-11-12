/**
 * The PROPERTY behind the eager kit filter (`planoEstoqueLi.ts`, module header): over random
 * interleavings of commits, trigger events and kit tasks, the last quantity a kit task published
 * equals the kit's true quantity once everything has drained.
 *
 * The model, per seeded run:
 *  - one kit of 2–4 components, each with a quantity in the kit (fractional ones included) and
 *    one stock record at the conta's depósito (or none);
 *  - the kits map as the last reconcile built it: each component's record id then — it is NOT
 *    updated during the run, so a record deleted or re-created under a new id leaves a STALE id
 *    behind, which the filter reads as unknown;
 *  - commits: a kit sale (every component down by its quantity in ONE commit, which is where
 *    ties come from), independent movements, a delete, a re-creation under a new id (delete +
 *    create in one commit, two events);
 *  - every event is handled at a random later point, reading the siblings as they are THEN (by
 *    the map's ids); a flagged kit gets a task, coalesced with one still pending (the 60 s window
 *    name), which runs later still and publishes the TRUE quantity — the send run re-derives
 *    everything with real queries, through the channel's one quantity function and the cap;
 *  - the run drains: no commit, event or task left.
 *
 * The suite also proves the property DISCRIMINATES: the two rules the module header rejects — a
 * strict `<` and "K(before) ≠ K(after)" — each lose a change on some seed.
 *
 * Deterministic: a 32-bit seeded generator (mulberry32), no new dependency.
 */
import type { ComponentesKit } from '@delfrance/schemas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type CabecalhoKitsLi,
  type DisponivelDoEventoLi,
  irmaosParaLerLi,
  kitsSinalizadosLi,
} from './planoEstoqueLi';
import { caminhoEstoqueLi, membroEstoqueLi, quantidadeEstoqueLi } from './quantidadeEstoqueLi';

// Per file: nothing here may reach the global `fetch` (the module is pure; no client exists).
beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('planoEstoqueLi.propriedade.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** mulberry32: a deterministic generator in [0, 1). */
function gerador(semente: number): () => number {
  let s = semente >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

const NOMES = ['blank', 'print', 'tag', 'laco'] as const;
const QUANTIDADES = [1, 1, 1, 2, 3, 0.5, 1.5];
const TETOS = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, 2, 4, 7];
const KIT = 'kit';
const SEMENTES = 3000;

interface Registro {
  readonly id: string;
  readonly d: number;
}

interface Evento {
  readonly componente: string;
  readonly antes: DisponivelDoEventoLi;
  readonly depois: DisponivelDoEventoLi;
}

/** What a trigger does with one event: does it enqueue the kit's task? */
type Filtro = (args: {
  readonly cabecalho: CabecalhoKitsLi;
  readonly componenteId: string;
  readonly antes: DisponivelDoEventoLi;
  readonly depois: DisponivelDoEventoLi;
  readonly cap: number;
  /**
   * A sibling's available quantity NOW: the record at `produtos/{componenteId}/estoques/{estoqueId}`,
   * or `undefined` (gone, or re-created under another id).
   */
  readonly ler: (componenteId: string, estoqueId: string) => number | undefined;
}) => boolean;

/** The module's rule, through its two phases exactly as the trigger will call them. */
const regraDoModulo: Filtro = ({ cabecalho, componenteId, antes, depois, cap, ler }) => {
  const leituras = new Map<string, number>();
  for (const caminho of irmaosParaLerLi({ cabecalho, componenteId, antes, depois, cap })) {
    // A point read by PATH, as the trigger makes it.
    const partes = caminhoEstoqueLi(caminho);
    if (partes === null) throw new RangeError(`caminho inválido: ${caminho}`);
    const d = ler(partes.produtoId, partes.estoqueId);
    if (d !== undefined) leituras.set(caminho, d);
  }
  return kitsSinalizadosLi({ cabecalho, componenteId, antes, depois, cap, leituras }).includes(KIT);
};

/** The two quotient sides of the moved component, and the siblings' bound (with the cap). */
function quocientes(a: Parameters<Filtro>[0]): { b: number; d: number; limite: number } | null {
  const q = a.cabecalho.kits?.[KIT]?.q ?? {};
  const qp = q[a.componenteId] ?? 1;
  let limite = a.cap;
  for (const [c, qc] of Object.entries(q)) {
    if (c === a.componenteId) continue;
    const id = a.cabecalho.comps[c];
    const disponivel = typeof id === 'string' ? a.ler(c, id) : undefined;
    if (disponivel === undefined) return null;
    limite = Math.min(limite, Math.floor(disponivel / qc));
  }
  return {
    b: Math.floor((a.antes ?? 0) / qp),
    d: Math.floor((a.depois ?? 0) / qp),
    limite,
  };
}

/** REJECTED: ties do not count. */
const regraEstrita: Filtro = (a) => {
  const r = quocientes(a);
  return r === null || Math.min(r.b, r.d) < r.limite;
};

/** REJECTED: "the kit's quantity changed", as this event alone sees it. */
const regraKMudou: Filtro = (a) => {
  const r = quocientes(a);
  return (
    r === null || Math.max(0, Math.min(r.b, r.limite)) !== Math.max(0, Math.min(r.d, r.limite))
  );
};

interface Resultado {
  readonly correto: boolean;
  readonly recriou: boolean;
  readonly leuIdObsoleto: boolean;
  readonly kitMudou: boolean;
  readonly naoSinalizados: number;
}

function simular(semente: number, filtro: Filtro): Resultado {
  const rnd = gerador(semente);
  const escolher = <T>(xs: readonly T[]): T => {
    const x = xs[Math.floor(rnd() * xs.length)];
    if (x === undefined) throw new RangeError('escolher: lista vazia');
    return x;
  };

  const nomes = NOMES.slice(0, 2 + Math.floor(rnd() * 3));
  const q: Record<string, number> = Object.fromEntries(
    nomes.map((c) => [c, escolher(QUANTIDADES)]),
  );
  const cap = escolher(TETOS);
  const valor = () => Math.floor(rnd() * 11) - 2 + (rnd() < 0.15 ? 0.5 : 0);

  let serial = 0;
  const estado = new Map<string, Registro | null>();
  for (const c of nomes) {
    estado.set(c, rnd() < 0.1 ? null : { id: `e-${c}-${String(serial++)}`, d: valor() });
  }

  // The kits map, as the last reconcile built it — never updated during the run.
  const comps: Record<string, string | null> = Object.fromEntries(
    nomes.map((c) => [c, estado.get(c)?.id ?? null]),
  );
  const cabecalhos = new Map<string, CabecalhoKitsLi>(
    nomes.map((c) => [c, { qMax: q[c] ?? 1, comps, kits: { [KIT]: { i: '123456789', q } } }]),
  );
  const componentesKit: ComponentesKit = Object.fromEntries(
    nomes.map((c) => [c, { quantidade: q[c] ?? 1, limitarEstoque: true, timestamp: null }]),
  );

  /** What a send run computes for the kit right now: the ONE quantity function, then the cap. */
  const kitVerdadeiro = () =>
    Math.min(
      cap,
      quantidadeEstoqueLi(
        membroEstoqueLi({
          produtoId: KIT,
          produto: { ehKit: true, componentesKit },
          estoque: null,
          componentes: [...estado].flatMap(([c, r]) =>
            r === null
              ? []
              : [{ caminho: `produtos/${c}/estoques/${r.id}`, dados: { quantidade: r.d } }],
          ),
        }),
      ),
    );
  const ler = (componenteId: string, estoqueId: string): number | undefined => {
    const r = estado.get(componenteId);
    return r?.id === estoqueId ? r.d : undefined;
  };

  const inicial = kitVerdadeiro();
  let publicado = inicial;
  let commits = 3 + Math.floor(rnd() * 10);
  const eventos: Evento[] = [];
  let tarefaPendente = false;
  let recriou = false;
  let leuIdObsoleto = false;
  let naoSinalizados = 0;

  const mudar = (c: string, depois: Registro | null) => {
    const antes = estado.get(c) ?? null;
    if (antes !== null && depois !== null && antes.id === depois.id) {
      if (antes.d !== depois.d) eventos.push({ componente: c, antes: antes.d, depois: depois.d });
    } else {
      if (antes !== null) eventos.push({ componente: c, antes: antes.d, depois: null });
      if (depois !== null) eventos.push({ componente: c, antes: null, depois: depois.d });
    }
    estado.set(c, depois);
  };

  const commit = () => {
    const tipo = rnd();
    if (tipo < 0.4) {
      // A kit sale: every component with a record goes down by its quantity, in ONE commit.
      for (const c of nomes) {
        const r = estado.get(c);
        if (r) mudar(c, { id: r.id, d: r.d - (q[c] ?? 1) });
      }
    } else if (tipo < 0.75) {
      for (const c of nomes) {
        const r = estado.get(c);
        if (r && rnd() < 0.5) mudar(c, { id: r.id, d: valor() });
      }
    } else if (tipo < 0.87) {
      const c = escolher(nomes);
      if (estado.get(c)) mudar(c, null);
    } else {
      // Re-created under a NEW id: the map still names the old one.
      const c = escolher(nomes);
      mudar(c, { id: `e-${c}-${String(serial++)}`, d: valor() });
      recriou = true;
    }
    commits--;
  };

  const processarEvento = () => {
    const [e] = eventos.splice(Math.floor(rnd() * eventos.length), 1);
    if (e === undefined) throw new RangeError('processarEvento: nenhum evento');
    const cabecalho = cabecalhos.get(e.componente);
    if (cabecalho === undefined) throw new RangeError('processarEvento: sem cabeçalho');
    if (
      Object.entries(comps).some(
        ([c, id]) => c !== e.componente && id !== null && ler(c, id) === undefined,
      )
    ) {
      leuIdObsoleto = true;
    }
    const sinalizado = filtro({
      cabecalho,
      componenteId: e.componente,
      antes: e.antes,
      depois: e.depois,
      cap,
      ler,
    });
    if (sinalizado) tarefaPendente = true;
    else naoSinalizados++;
  };

  const rodarTarefa = () => {
    publicado = kitVerdadeiro();
    tarefaPendente = false;
  };

  while (commits > 0 || eventos.length > 0 || tarefaPendente) {
    const passos: (() => void)[] = [];
    if (commits > 0) passos.push(commit);
    if (eventos.length > 0) passos.push(processarEvento);
    if (tarefaPendente) passos.push(rodarTarefa);
    escolher(passos)();
  }

  const final = kitVerdadeiro();
  return {
    correto: publicado === final,
    recriou,
    leuIdObsoleto,
    kitMudou: final !== inicial,
    naoSinalizados,
  };
}

function rodar(filtro: Filtro) {
  const falhas: number[] = [];
  let recriacoes = 0;
  let obsoletos = 0;
  let mudancas = 0;
  let naoSinalizados = 0;
  for (let semente = 1; semente <= SEMENTES; semente++) {
    const r = simular(semente, filtro);
    if (!r.correto) falhas.push(semente);
    if (r.recriou) recriacoes++;
    if (r.leuIdObsoleto) obsoletos++;
    if (r.kitMudou) mudancas++;
    naoSinalizados += r.naoSinalizados;
  }
  return { falhas, recriacoes, obsoletos, mudancas, naoSinalizados };
}

describe('the eager kit filter, as a property over random interleavings', () => {
  it(`after quiescence the last published quantity is the true one (${String(SEMENTES)} seeds)`, () => {
    const r = rodar(regraDoModulo);
    expect(r.falhas).toEqual([]);
    // Anti-vacuity: the corpus exercised what the property is about.
    expect(r.mudancas).toBeGreaterThan(SEMENTES / 5); // kits whose quantity really moved
    expect(r.recriacoes).toBeGreaterThan(SEMENTES / 4); // a record re-created under a new id
    expect(r.obsoletos).toBeGreaterThan(SEMENTES / 10); // a sibling read by a stale map id
    expect(r.naoSinalizados).toBeGreaterThan(SEMENTES); // the filter really filters
  });

  it('⚠️ it DISCRIMINATES: the strict `<` rule loses a change on some seed', () => {
    expect(rodar(regraEstrita).falhas.length).toBeGreaterThan(0);
  });

  it('⚠️ it DISCRIMINATES: the rejected "K(before) ≠ K(after)" rule loses a change on some seed', () => {
    expect(rodar(regraKMudou).falhas.length).toBeGreaterThan(0);
  });
});
