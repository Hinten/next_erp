/**
 * Trigger a browser download of a complete Blob via a transient object URL.
 *
 * This is the primitive that replaces the old Flutter data-URL download
 * (`data:...;base64,<HUGE>`), whose per-browser length cap silently truncated
 * large archives (#11). An object URL has no size cap, and the Blob is fully
 * built before the download starts.
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
