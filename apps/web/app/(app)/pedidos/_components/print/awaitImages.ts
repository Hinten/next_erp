'use client';

/**
 * Wait for every `<img>` inside `node` to finish loading/decoding before
 * printing — this is what guarantees "all images load to separate the order".
 * A per-image `.catch` swallows a broken/missing photo so one failure can't
 * block the whole batch (the sheet just shows that image's placeholder).
 */
export async function awaitImages(node: HTMLElement | null): Promise<void> {
  if (!node) return;
  const imgs = Array.from(node.querySelectorAll('img'));
  await Promise.all(
    imgs.map((img) => {
      if (img.complete && img.naturalWidth > 0) return Promise.resolve();
      return img.decode().catch(() => undefined);
    }),
  );
}
