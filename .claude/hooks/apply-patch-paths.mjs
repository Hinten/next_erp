// Extract only path-bearing headers from Codex's apply_patch payload. Scanning
// the whole patch would treat documentation or test content that merely names a
// protected directory as a filesystem access.
export function applyPatchPaths(patch) {
  const paths = [];
  for (const line of String(patch).split(/\r?\n/)) {
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

/**
 * Extract patch targets when a shell command feeds a heredoc or PowerShell
 * here-string to `apply_patch`. Heredoc bodies are otherwise prose/data and
 * must stay out of generic path scans, but an apply_patch body is executable
 * filesystem intent and its path headers must be inspected.
 */
export function shellApplyPatchPaths(command) {
  const script = String(command).replace(/\r\n/g, '\n');
  const paths = [];
  const lines = script.split('\n');
  let delimiter = null;
  let capturesPatch = false;
  let body = [];

  const flush = () => {
    if (capturesPatch) paths.push(...applyPatchPaths(body.join('\n')));
    delimiter = null;
    capturesPatch = false;
    body = [];
  };

  for (const line of lines) {
    if (delimiter !== null) {
      if (line.trim() === delimiter) flush();
      else if (capturesPatch) body.push(line);
      continue;
    }

    const heredoc = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (!heredoc) continue;
    delimiter = heredoc[2];
    capturesPatch = /(?:^|&&|\|\||[;|])\s*(?:command\s+)?apply_patch(?:\.exe)?(?:\s|$)/.test(
      line,
    );
  }
  if (delimiter !== null) flush();

  const hereString = /@(['"])\n([\s\S]*?)\n\1@\s*\|\s*(?:&\s*)?apply_patch(?:\.exe)?\b/g;
  let match;
  while ((match = hereString.exec(script)) !== null) {
    paths.push(...applyPatchPaths(match[2]));
  }

  return paths;
}
