/**
 * Compare a live Mercado Livre body's shape against the committed corpus.
 *
 * Used by `scripts/verify-wire-live.ts` — the human-triggered check that asks
 * "does ML still send what `__wire__/` says it sends?". It is the one piece of
 * the #1087 CI work that touches the real API, and it is deliberately NOT in any
 * lane: it needs the seller credential, and the run measured why an automated
 * live lane fails (blocked test users, a rotating credential, ML's own clock).
 *
 * ⚠️ **The live body must be REDACTED before it is digested.** The committed
 * corpus is redacted, so comparing a raw live body against it would report every
 * personal field as a difference — dozens of false positives that would bury the
 * one real one. This is the payoff of `redact.ts` being TYPE-PRESERVING: a
 * redacted body has the same shape as the raw one, so the two digests are
 * directly comparable.
 */
import type { WireShape, WireTypeName } from './wireDigest';

export type DeltaKind = 'removido' | 'novo' | 'tipo-mudou';

export interface ShapeDelta {
  readonly path: string;
  readonly kind: DeltaKind;
  /** Types in the committed corpus, or `''` when the path is new. */
  readonly antes: string;
  /** Types ML sent now, or `''` when the path is gone. */
  readonly depois: string;
}

function join(types: ReadonlySet<WireTypeName> | undefined): string {
  return types === undefined ? '' : [...types].sort().join('|');
}

/**
 * Every path where the live shape disagrees with the baseline.
 *
 * ⚠️ **`novo` is reported, not ignored.** A field ML started sending is the
 * cheap half of this signal — it is where a new capability shows up, and it is
 * also how a rename presents (`removido` + `novo` on the same run). Filtering
 * additions out would have hidden the `date_last_modified` / `date_last_updated`
 * split that the corpus exposed.
 */
export function diffShapes(baseline: WireShape, live: WireShape): ShapeDelta[] {
  const deltas: ShapeDelta[] = [];

  for (const [path, tiposBase] of baseline) {
    const tiposLive = live.get(path);
    if (tiposLive === undefined) {
      deltas.push({ path, kind: 'removido', antes: join(tiposBase), depois: '' });
      continue;
    }
    const antes = join(tiposBase);
    const depois = join(tiposLive);
    if (antes !== depois) deltas.push({ path, kind: 'tipo-mudou', antes, depois });
  }

  for (const [path, tiposLive] of live) {
    if (!baseline.has(path)) {
      deltas.push({ path, kind: 'novo', antes: '', depois: join(tiposLive) });
    }
  }

  return deltas.sort((a, b) => a.path.localeCompare(b.path));
}

/** ⚠️ A removal or a type change is a breakage; an addition is information. */
export function ehQuebra(delta: ShapeDelta): boolean {
  return delta.kind !== 'novo';
}

const MARCA: Readonly<Record<DeltaKind, string>> = {
  removido: '⛔',
  'tipo-mudou': '⚠️',
  novo: 'ⓘ',
};

/** One line per delta, prefixed by severity. */
export function renderShapeDiff(file: string, deltas: readonly ShapeDelta[]): string {
  if (deltas.length === 0) return `✅ ${file}`;
  const linhas = deltas.map((d) => {
    const detalhe =
      d.kind === 'novo'
        ? `${d.path}: ${d.depois}`
        : d.kind === 'removido'
          ? `${d.path}: ${d.antes} → AUSENTE`
          : `${d.path}: ${d.antes} → ${d.depois}`;
    return `   ${MARCA[d.kind]} ${detalhe}`;
  });
  const quebras = deltas.filter(ehQuebra).length;
  return [`${quebras > 0 ? '⛔' : 'ⓘ'} ${file}`, ...linhas].join('\n');
}
