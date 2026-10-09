/**
 * Where captures may live: OUTSIDE every git checkout.
 *
 * A tracked ignore file exists only on the branches that contain it. Git deletes
 * it when another branch is checked out and leaves the untracked captures behind,
 * no longer ignored — one `git add -A` from a commit of real production data. Out
 * of every checkout, no branch switch, worktree or `git add -A` can reach them.
 * So the sanitizer refuses an input folder that has a `.git` entry (a directory,
 * or the `.git` FILE of a worktree) in it or in any ancestor.
 *
 * Pure: the existence check is injected (`existsSync` in the script).
 */

/** The folder itself, then each ancestor up to the root. Accepts `\` and `/`. */
export function ancestraisDe(caminhoAbsoluto: string): string[] {
  let atual = caminhoAbsoluto.replaceAll('\\', '/');
  while (atual.length > 1 && atual.endsWith('/')) atual = atual.slice(0, -1);
  const saida: string[] = [];
  for (;;) {
    saida.push(atual);
    const corte = atual.lastIndexOf('/');
    if (corte < 0) break;
    if (corte === 0) {
      if (atual !== '/') saida.push('/');
      break;
    }
    atual = atual.slice(0, corte);
  }
  return saida;
}

/** `true` when `caminhoAbsoluto` or any ancestor holds a `.git` entry. */
export function dentroDeCheckout(
  caminhoAbsoluto: string,
  existe: (caminho: string) => boolean,
): boolean {
  return ancestraisDe(caminhoAbsoluto).some((pasta) =>
    existe(pasta === '/' ? '/.git' : `${pasta}/.git`),
  );
}
