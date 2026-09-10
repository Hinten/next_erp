// Extract only path-bearing headers from Codex's apply_patch payload. Scanning
// the whole patch would treat documentation or test content that merely names a
// protected directory as a filesystem access.
export function applyPatchPaths(patch) {
  const paths = [];
  for (const line of String(patch).split('\n')) {
    const file = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
    if (file) {
      paths.push(file[1].trim());
      continue;
    }

    const move = line.match(/^\*\*\* Move to: (.+)$/);
    if (move) paths.push(move[1].trim());
  }
  return paths;
}
