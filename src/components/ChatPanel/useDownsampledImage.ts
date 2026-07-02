import { useEffect, useState } from 'react';

// iter-96: pre-bake a high-quality downsample of an image once per
// (src, sizePx, dpr). The browser's per-paint downsample from a 1024px source
// to a 20-CSS-px target on a 2-3x display can look soft. createImageBitmap
// with {resizeQuality:'high'} resolves to a Lanczos-grade resize in modern
// engines, giving sharper detail than the live <img> downscale path.
//
// Cache the resulting blob URL at module scope so every ForgeCard mount reuses
// the same baked bitmap — ForgeCard is rendered once per agent turn, dozens
// per session. Cache key includes target size + ceiled DPR.
const CACHE = new Map<string, string | Promise<string>>();

export function useDownsampledImage(src: string, sizePx: number): string {
  const [url, setUrl] = useState<string>(src);
  useEffect(() => {
    const dpr = Math.min(3, Math.max(1, Math.ceil(window.devicePixelRatio || 1)));
    const target = sizePx * dpr;
    const key = `${src}@${target}`;
    const cached = CACHE.get(key);
    if (typeof cached === 'string') { setUrl(cached); return; }
    if (typeof window.createImageBitmap !== 'function') return;
    const run = cached ?? (async () => {
      const blob = await fetch(src).then((r) => r.blob());
      const bitmap = await createImageBitmap(blob, {
        resizeWidth: target,
        resizeHeight: target,
        resizeQuality: 'high',
      });
      const canvas = document.createElement('canvas');
      canvas.width = target;
      canvas.height = target;
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
      const out: Blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png')!);
      const u = URL.createObjectURL(out);
      CACHE.set(key, u);
      return u;
    })();
    if (!CACHE.has(key)) CACHE.set(key, run as Promise<string>);
    let cancel = false;
    (run as Promise<string>).then((u) => { if (!cancel) setUrl(u); }).catch(() => {});
    return () => { cancel = true; };
  }, [src, sizePx]);
  return url;
}
