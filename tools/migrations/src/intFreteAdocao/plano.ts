import type {
  DisposicaoIntFrete,
  IntFreteEncontrado,
  PlanoIntFrete,
  SyncIntFreteConta,
} from '@delfrance/data/admin/frete';
import { idFromRef, toOuterRefOrNull } from '@delfrance/schemas';

/**
 * The PURE half of every `int_frete` window adoption pass — one copy, bound per channel by
 * {@link adocaoIntFrete}. Shopee (#1528) and Loja Integrada (#1826) each bind it in their own dated
 * folder (`2026-10-shopee-int-frete/transform.ts`, `2026-10-li-int-frete/transform.ts`), with the
 * SAME zero-option `intFreteContaSync` binding their trigger runs; the I/O is `executar.ts` beside
 * this file. Runbooks: `tools/migrations/<channel>-int-frete.README.md`.
 *
 * ## No decision of its own
 *
 * Every create / patch / deactivate verdict here comes from the shared core's OWN pure planner
 * and chooser — `planejarIntFreteDaConta` and `escolherIntFreteDaConta` of
 * `@delfrance/data/admin/frete` — through the bound {@link SyncIntFreteConta}. The `--apply` leg
 * then hands each executable conta id, verbatim, to that binding's `reconciliarIntFreteDaConta`,
 * which re-reads the conta and the doc itself. So the dry run and the apply decide alike by
 * construction (the core's T54 pins the chooser against its lookup), and nothing here can disagree
 * with the trigger that takes over after the window (#1369: one core, never a second copy of the
 * planner — and one pass, never a second copy of its STOP verdict). This module only:
 *
 *  - picks the conta ids to plan (every scanned conta of the channel, plus every conta id a scanned
 *    doc's back-ref names — an orphan's conta);
 *  - refuses to plan a conta whose docs all carry a NON-canonical back-ref while no
 *    `<prefixoDocId>-<id>` doc exists (`bloqueado-nao-canonico`): the binding has no tolerant scan,
 *    so its reconcile would CREATE `<prefixoDocId>-<id>` beside that legacy doc. The doc AT
 *    `<prefixoDocId>-<id>` is never that case — the core's deterministic-id fallback chooses it
 *    whatever its back-ref, so the pass chooses it too (a live conta's plan then rewrites the ref;
 *    an orphan's deactivation leaves it as stored — {@link LinhaConta.naoCanonicos});
 *  - labels each line FROM the plan, never before it (K2-F1);
 *  - flags two lines that target ONE doc (`compartilhadoCom`), which no single plan can see.
 *
 * ## No clock
 *
 * Nothing in the pass reads the time. The core stamps `ultimaModificacao` with its own conta
 * read's `readTime`; the plan's labels, the JSONL and the verdicts below are clock-free, which is
 * what makes a second pass reproduce the first one's verdicts. `plano.test.ts` scans every source
 * file of this folder for a clock read.
 *
 * ## ⛔ STOP verdicts
 *
 * A conta with `duplicados` (more than one doc carries its canonical back-ref), with a
 * non-canonical back-ref on any doc but the chosen one (`naoCanonicos`; every
 * `bloqueado-nao-canonico` line has one), or whose line targets the same doc as another conta's
 * (`compartilhadoCom`) STOPS the pass: `--apply` refuses before its first write
 * ({@link paradasDoPlano}). Which legacy twin migrated pedidos keep pointing at, and which conta a
 * shared doc belongs to, is a human call, and the channel's functions deploy waits for a dry run
 * with zero of all three.
 */

/** One scanned `integracao` doc: its id and its raw body (`tipo` + the mirrored fields). */
export interface ContaEscaneada {
  id: string;
  data: Record<string, unknown>;
}

/**
 * What one conta line says. `bloqueado-nao-canonico` is the only label not derived from a plan
 * (the planner is never asked); every other one is a function of the planner's output.
 */
export type RotuloConta =
  | 'criar'
  | 'adotar'
  | 'atualizar'
  | 'desativar-orfao'
  | 'inalterado'
  | 'orfao-inativo'
  | 'incompleto'
  | 'bloqueado-nao-canonico';

export const ROTULOS_CONTA = [
  'criar',
  'adotar',
  'atualizar',
  'desativar-orfao',
  'inalterado',
  'orfao-inativo',
  'incompleto',
  'bloqueado-nao-canonico',
] as const satisfies ReadonlyArray<RotuloConta>;

/** The plan actions that stage a write — the only ones the `--apply` leg hands to the core. */
const ACOES_QUE_ESCREVEM = ['criar', 'atualizar', 'desativar'] as const;
type AcaoQueEscreve = (typeof ACOES_QUE_ESCREVEM)[number];

/** The disposition the core reports when it applies each writing action. */
const DISPOSICAO_ESPERADA: Record<AcaoQueEscreve, DisposicaoIntFrete['action']> = {
  criar: 'criado',
  atualizar: 'atualizado',
  desativar: 'desativado',
};

function escreve(acao: PlanoIntFrete['acao']): acao is AcaoQueEscreve {
  return (ACOES_QUE_ESCREVEM as ReadonlyArray<string>).includes(acao);
}

/** One conta of the pass. */
export interface LinhaConta {
  integracaoId: string;
  rotulo: RotuloConta;
  /** True only for a `criar` / `atualizar` / `desativar` plan on a line that is not blocked. */
  executar: boolean;
  /** The doc the plan targets (`<prefixoDocId>-<id>` on a create); null when there is none. */
  intFreteId: string | null;
  /** The core planner's output, verbatim; null on a `bloqueado-nao-canonico` line. */
  plano: PlanoIntFrete | null;
  /** The OTHER docs carrying this conta's canonical back-ref — reported, never written. */
  duplicados: string[];
  /**
   * Docs other than the chosen one whose back-ref resolves to this conta only through
   * `toOuterRefOrNull` — never written. The chosen doc is never listed: a `<prefixoDocId>-<id>`
   * doc with such a ref is chosen by the core's deterministic-id fallback. A LIVE conta's plan then
   * rewrites the ref to canonical; an orphan's deactivation writes only `ativo` and leaves the ref
   * as stored, reported nowhere — acceptable, since no conta remains to own it.
   */
  naoCanonicos: string[];
  /**
   * The OTHER contas whose line targets this line's `intFreteId` — empty when the line targets no
   * doc. Non-empty only on tampered or rehearsal data (every writer stamps its own canonical ref at
   * its own deterministic id), e.g. `<prefixoDocId>-<a>` carrying conta b's canonical ref while
   * conta a has no canonical doc: a's deterministic-id fallback and b's canonical match both claim
   * it.
   */
  compartilhadoCom: string[];
  /** The stored values of the fields the plan writes (null on a create, or when nothing is written). */
  de: Record<string, unknown> | null;
  /** The values the plan writes (null when nothing is written). */
  para: Record<string, unknown> | null;
}

/** A scanned doc whose back-ref names no conta at all, and that no line claims. Report only. */
export interface RefIlegivel {
  intFreteId: string;
  ref: unknown;
}

export interface PlanoDaPassagem {
  linhas: LinhaConta[];
  refsIlegiveis: RefIlegivel[];
}

/** The contas that STOP the pass, by reason. */
export interface ParadasDoPlano {
  duplicados: string[];
  naoCanonicos: string[];
  /** Every conta whose line targets a doc another conta's line also targets. */
  compartilhados: string[];
}

/** One channel's pass: the binding it plans through, and the functions that need it. */
export interface AdocaoIntFrete {
  /**
   * The binding — the trigger's own, zero options. `executar.ts` calls its
   * `reconciliarIntFreteDaConta` through THIS object at apply time (never a copy taken at bind
   * time), so a test that spies on the binding sees every reconcile.
   */
  readonly sync: SyncIntFreteConta;
  /** The runbook the STOP message names (a file beside `tools/migrations/README.md`). */
  readonly runbook: string;
  /**
   * The conta id a back-ref names, in ANY form `toOuterRefOrNull` resolves
   * (`documents/integracao/x`, bare `integracao/x`, stray slashes) — or null when it names no
   * `integracao` doc at all.
   *
   * ⚠️ A FOLD, and scoped tight: it equates the stored forms of ONE conta's ref, never two contas,
   * and never a deeper path — `documents/integracao/x/sub/y` and `documents/filiais/x` are null,
   * because the canonical ref the core builds for the extracted id must equal the resolved one.
   */
  contaIdDoRef(ref: unknown): string | null;
  /**
   * The whole pass, from the two scans: `integracao where tipo == tipoConta` (`contas`) and
   * `int_frete where tipo == tipoFrete` (`docs`). A doc of another `tipo` is outside the pass and
   * is dropped here exactly as the scan's own filter drops it.
   *
   * ⚠️ That includes a `<prefixoDocId>-<id>` doc whose `tipo` was altered. The pass plans `criar`
   * for its conta, while the reconcile reads `<prefixoDocId>-<id>` by id and patches it (`tipo`
   * included), so the apply logs a `divergente` row — with the right outcome: one doc, patched,
   * and the second dry run sees it as `inalterado`. Accepted rather than read `<prefixoDocId>-<id>`
   * per conta: only tampered or rehearsal data reaches this shape.
   *
   * Plan order: the scanned contas in scan order, then each orphan conta id in the order its first
   * doc appears.
   */
  planejarPassagem(entrada: {
    contas: ReadonlyArray<ContaEscaneada>;
    docs: ReadonlyArray<IntFreteEncontrado>;
  }): PlanoDaPassagem;
  /** The `--apply` refusal, naming every conta a human has to resolve first, and the runbook. */
  mensagemDeParada(paradas: ParadasDoPlano): string;
}

/**
 * Binds the pass to one channel's sync. `sync` must be the channel trigger's own binding — zero
 * options, so no tolerant scan — and its row must carry a `prefixoDocId`: the pass's whole
 * reading of a non-canonical back-ref rests on the core's deterministic-id fallback, and on the
 * create landing at `<prefixoDocId>-<id>` (a row without one creates at a random id, so every
 * applied `criar` would read as a divergence). A row without one throws here, at bind time.
 */
export function adocaoIntFrete(
  sync: SyncIntFreteConta,
  opcoes: { readonly runbook: string },
): AdocaoIntFrete {
  const { campoBackRef, tipoFrete, prefixoDocId } = sync.vinculo;
  if (prefixoDocId == null) {
    throw new Error(
      `adocaoIntFrete: a linha ${sync.vinculo.rotuloLog} não tem prefixoDocId — a passagem de ` +
        'adoção só serve a vínculos que criam no id determinístico.',
    );
  }
  const { runbook } = opcoes;

  const contaIdDoRef = (ref: unknown): string | null => {
    const canonico = toOuterRefOrNull(ref);
    if (canonico == null) return null;
    const id = idFromRef(canonico);
    return sync.refCanonicalDaConta(id) === canonico ? id : null;
  };

  const rotuloDoPlano = (
    plano: Exclude<PlanoIntFrete, { acao: 'nao-encontrado' }>,
    escolhido: IntFreteEncontrado | null,
    conta: Record<string, unknown> | null,
  ): RotuloConta => {
    switch (plano.acao) {
      case 'criar':
        return 'criar';
      case 'incompleto':
        return 'incompleto';
      case 'atualizar':
        // A LABEL only: the core stamps `ultimaModificacao` on every write, and an imported legacy
        // freight doc carries none, so a patch on a doc without it is that doc's adoption. A
        // legacy doc already equal to its conta is `inalterado` like any other.
        return escolhido?.data.ultimaModificacao == null ? 'adotar' : 'atualizar';
      case 'desativar':
        return 'desativar-orfao';
      case 'inalterado':
        return sync.ehConta(conta) ? 'inalterado' : 'orfao-inativo';
    }
  };

  const planejarConta = (
    integracaoId: string,
    conta: Record<string, unknown> | null,
    docs: ReadonlyArray<IntFreteEncontrado>,
  ): LinhaDaConta | null => {
    const canonico = sync.refCanonicalDaConta(integracaoId);
    const daConta = docs.filter((d) => sync.ehDocDaConta(d.data, integracaoId));
    // Chosen FIRST, exactly as the reconcile looks it up: a canonical match, else the doc at
    // `<prefixoDocId>-<id>` whatever its back-ref (the core's deterministic-id fallback). That
    // chosen doc is this conta's, so it is never counted as non-canonical. A LIVE conta's plan
    // rewrites its ref; an orphan's is a deactivation, which writes only `ativo` and leaves a
    // non-canonical ref as stored, reported nowhere (acceptable: no conta remains to own it). Any
    // OTHER doc whose ref resolves to this conta is a real twin and still STOPs the pass.
    const escolhido = sync.escolherIntFreteDaConta(docs, integracaoId);
    const naoCanonicos = docs
      .filter(
        (d) =>
          d.id !== escolhido?.id &&
          !sync.ehDocDaConta(d.data, integracaoId) &&
          toOuterRefOrNull(d.data[campoBackRef]) === canonico,
      )
      .map((d) => d.id);

    if (escolhido == null && naoCanonicos.length > 0) {
      // Never plan beside it: with no tolerant scan and no `<prefixoDocId>-<id>` doc, the core
      // would CREATE `<prefixoDocId>-<id>` next to a legacy doc that migrated pedidos may point at.
      return {
        integracaoId,
        rotulo: 'bloqueado-nao-canonico',
        executar: false,
        intFreteId: null,
        plano: null,
        duplicados: [],
        naoCanonicos,
        de: null,
        para: null,
      };
    }

    const plano = sync.planejarIntFreteDaConta(integracaoId, conta, escolhido);
    if (plano.acao === 'nao-encontrado') return null;

    return {
      integracaoId,
      rotulo: rotuloDoPlano(plano, escolhido, conta),
      executar: escreve(plano.acao),
      intFreteId: plano.acao === 'incompleto' ? null : (plano.id ?? null),
      plano,
      duplicados: daConta.filter((d) => d.id !== escolhido?.id).map((d) => d.id),
      naoCanonicos,
      ...deParaDoPlano(plano, escolhido),
    };
  };

  const planejarPassagem: AdocaoIntFrete['planejarPassagem'] = (entrada) => {
    const docs = entrada.docs.filter((d) => d.data.tipo === tipoFrete);
    const contaPorId = new Map(entrada.contas.map((c) => [c.id, c.data]));

    const ids = new Set(entrada.contas.map((c) => c.id));
    for (const doc of docs) {
      const id = contaIdDoRef(doc.data[campoBackRef]);
      if (id != null) ids.add(id);
    }

    const porConta: LinhaDaConta[] = [];
    for (const id of ids) {
      const linha = planejarConta(id, contaPorId.get(id) ?? null, docs);
      if (linha != null) porConta.push(linha);
    }

    // Each plan sees one conta, so only the pass can see two lines naming ONE doc. Applied, the
    // outcome would depend on the order (one rewrites the ref, then the other creates its own doc —
    // or the other patches it first and is overwritten), so both lines carry it and the pass STOPs.
    // A line that writes nothing still counts (an orphan's already-inactive doc is still its
    // target); a line with no target (`incompleto`, `bloqueado-nao-canonico`) never does.
    const contasPorDoc = new Map<string, string[]>();
    for (const l of porConta) {
      if (l.intFreteId == null) continue;
      contasPorDoc.set(l.intFreteId, [...(contasPorDoc.get(l.intFreteId) ?? []), l.integracaoId]);
    }
    const linhas: LinhaConta[] = porConta.map((l) => ({
      ...l,
      compartilhadoCom:
        l.intFreteId == null
          ? []
          : (contasPorDoc.get(l.intFreteId) ?? []).filter((id) => id !== l.integracaoId),
    }));

    const reivindicados = new Set(linhas.map((l) => l.intFreteId));
    const refsIlegiveis = docs
      .filter((d) => contaIdDoRef(d.data[campoBackRef]) == null && !reivindicados.has(d.id))
      .map((d) => ({ intFreteId: d.id, ref: lido(d.data, campoBackRef) }));

    return { linhas, refsIlegiveis };
  };

  const mensagemDeParada = (paradas: ParadasDoPlano): string => {
    const partes: string[] = [];
    if (paradas.duplicados.length > 0) {
      partes.push(
        `duplicados em ${paradas.duplicados.length} conta(s): ${paradas.duplicados.join(', ')}`,
      );
    }
    if (paradas.naoCanonicos.length > 0) {
      partes.push(
        `back-ref não canônico em ${paradas.naoCanonicos.length} conta(s): ` +
          paradas.naoCanonicos.join(', '),
      );
    }
    if (paradas.compartilhados.length > 0) {
      partes.push(
        `doc compartilhado com outra conta em ${paradas.compartilhados.length} conta(s): ` +
          paradas.compartilhados.join(', '),
      );
    }
    return (
      `⛔ STOP — --apply recusado antes de qualquer escrita: ${partes.join('; ')}. ` +
      'Qual doc os pedidos migrados mantêm, e de qual conta é um doc compartilhado, é decisão ' +
      'humana: resolva cada um, rode o dry-run de novo (deve reportar zero dos três) e só então ' +
      `--apply. Veja ${runbook}.`
    );
  };

  return { sync, runbook, contaIdDoRef, planejarPassagem, mensagemDeParada };
}

/** Absent ⇒ null, so a JSONL value never silently drops a key. */
function lido(data: Record<string, unknown>, campo: string): unknown {
  return data[campo] === undefined ? null : data[campo];
}

function deParaDoPlano(
  plano: PlanoIntFrete,
  escolhido: IntFreteEncontrado | null,
): Pick<LinhaConta, 'de' | 'para'> {
  switch (plano.acao) {
    case 'criar':
      return { de: null, para: { ...plano.campos } };
    case 'atualizar':
      return {
        de: Object.fromEntries(
          Object.keys(plano.patch).map((campo) => [campo, lido(escolhido?.data ?? {}, campo)]),
        ),
        para: { ...plano.patch },
      };
    case 'desativar':
      return { de: { ativo: lido(escolhido?.data ?? {}, 'ativo') }, para: { ativo: false } };
    case 'inalterado':
    case 'incompleto':
    case 'nao-encontrado':
      return { de: null, para: null };
  }
}

/** One conta's line before the pass compares it with the others (`compartilhadoCom`). */
type LinhaDaConta = Omit<LinhaConta, 'compartilhadoCom'>;

/* ------------------------- channel-free, over a plan ------------------------ */

/** The conta ids the `--apply` leg reconciles: the executable lines', de-duplicated, in plan order. */
export function idsAExecutar(linhas: ReadonlyArray<LinhaConta>): string[] {
  return [...new Set(linhas.filter((l) => l.executar).map((l) => l.integracaoId))];
}

export function paradasDoPlano(plano: PlanoDaPassagem): ParadasDoPlano {
  return {
    duplicados: plano.linhas.filter((l) => l.duplicados.length > 0).map((l) => l.integracaoId),
    naoCanonicos: plano.linhas.filter((l) => l.naoCanonicos.length > 0).map((l) => l.integracaoId),
    compartilhados: plano.linhas
      .filter((l) => l.compartilhadoCom.length > 0)
      .map((l) => l.integracaoId),
  };
}

export function bloqueiaAplicacao(paradas: ParadasDoPlano): boolean {
  return (
    paradas.duplicados.length > 0 ||
    paradas.naoCanonicos.length > 0 ||
    paradas.compartilhados.length > 0
  );
}

/** Counts per label, plus the report-only rows and how many lines would write. */
export type ResumoDaPassagem = Record<RotuloConta | 'ref-ilegivel', number> & {
  executaveis: number;
};

export function resumirPassagem(plano: PlanoDaPassagem): ResumoDaPassagem {
  const resumo = Object.fromEntries(ROTULOS_CONTA.map((r) => [r, 0])) as Record<
    RotuloConta,
    number
  >;
  for (const linha of plano.linhas) resumo[linha.rotulo] += 1;
  return {
    ...resumo,
    'ref-ilegivel': plano.refsIlegiveis.length,
    executaveis: idsAExecutar(plano.linhas).length,
  };
}

/**
 * True when the core did something other than what the line planned — expected only when the
 * conta or the doc was written after the scan (the core re-reads both, so it is the one that is
 * right). Logged as its own `divergente` row.
 */
export function divergeDoPlano(linha: LinhaConta, disposicao: DisposicaoIntFrete): boolean {
  const acao = linha.plano?.acao;
  if (acao == null || !escreve(acao)) return true;
  return (
    disposicao.action !== DISPOSICAO_ESPERADA[acao] || disposicao.intFreteId !== linha.intFreteId
  );
}

/**
 * The summary's `docsChanged` on `--apply`: the dispositions that wrote. The runner's own
 * `writes` figure stays 0 by design — the core writes in its own transactions, never through
 * `BatchWriter`.
 */
export function contarDocsAlterados(disposicoes: ReadonlyArray<DisposicaoIntFrete>): number {
  return disposicoes.filter(
    (d) => d.action === 'criado' || d.action === 'atualizado' || d.action === 'desativado',
  ).length;
}

/** One JSONL row, in the runner's `ChangeSink` shape. */
export type RegistroJsonl =
  | { kind: 'change'; path: string; field: string; from: unknown; to: unknown }
  | { kind: 'skip'; path: string; field: string; value: unknown; reason: string };

/**
 * The plan as JSONL rows. Per conta, keyed `integracao/<id>`: ONE row named by its label — a
 * `change` (from the stored values to the planned ones) when executable, a `skip` otherwise —
 * then one `duplicados`, one `nao-canonico` and one `compartilhado` row when it has any, so the
 * STOP rows grep by name. Per unclaimed unreadable back-ref, one `ref-ilegivel` row keyed
 * `int_frete/<id>`.
 */
export function registrosDoPlano(plano: PlanoDaPassagem): RegistroJsonl[] {
  const registros: RegistroJsonl[] = [];
  for (const l of plano.linhas) {
    const path = `integracao/${l.integracaoId}`;
    if (l.executar) {
      registros.push({
        kind: 'change',
        path,
        field: l.rotulo,
        from: l.de == null ? null : { intFreteId: l.intFreteId, ...l.de },
        to: { intFreteId: l.intFreteId, ...l.para },
      });
    } else {
      registros.push({
        kind: 'skip',
        path,
        field: l.rotulo,
        value: {
          intFreteId: l.intFreteId,
          ...(l.plano?.acao === 'incompleto' ? { faltando: l.plano.faltando } : {}),
        },
        reason: l.rotulo,
      });
    }
    if (l.duplicados.length > 0) {
      registros.push({
        kind: 'skip',
        path,
        field: 'duplicados',
        value: { escolhido: l.intFreteId, duplicados: l.duplicados },
        reason: 'duplicados',
      });
    }
    if (l.naoCanonicos.length > 0) {
      registros.push({
        kind: 'skip',
        path,
        field: 'nao-canonico',
        value: { naoCanonicos: l.naoCanonicos },
        reason: 'nao-canonico',
      });
    }
    if (l.compartilhadoCom.length > 0) {
      registros.push({
        kind: 'skip',
        path,
        field: 'compartilhado',
        value: { intFreteId: l.intFreteId, compartilhadoCom: l.compartilhadoCom },
        reason: 'compartilhado',
      });
    }
  }
  for (const r of plano.refsIlegiveis) {
    registros.push({
      kind: 'skip',
      path: `int_frete/${r.intFreteId}`,
      field: 'ref-ilegivel',
      value: r.ref,
      reason: 'ref-ilegivel',
    });
  }
  return registros;
}
