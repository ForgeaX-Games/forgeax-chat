import { isLedgerBlob, LEDGER_BLOB_KEY, type LedgerBlob } from '@forgeax/types';
import type { StoredEvent } from './types';

export type LedgerBlobResolver = (blob: LedgerBlob) => Promise<Uint8Array>;

export interface LedgerBlobHydrationOptions {
  onError?: (blob: LedgerBlob, error: unknown) => void;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function decodeBlob(blob: LedgerBlob, bytes: Uint8Array): string {
  return blob.enc === 'base64'
    ? bytesToBase64(bytes)
    : new TextDecoder().decode(bytes);
}

/** Hydrate every valid ledger sentinel before events enter the replay pipeline. */
export async function hydrateLedgerBlobs(
  events: StoredEvent[],
  resolveBlob: LedgerBlobResolver,
  options: LedgerBlobHydrationOptions = {},
): Promise<void> {
  const cache = new Map<string, Promise<Uint8Array>>();

  // Resolve one slot: a valid sentinel is replaced with its decoded content;
  // anything else is recursed into — except a sentinel-shaped-but-invalid object,
  // which we must not descend into as if it were a plain container.
  const hydrateSlot = async (value: unknown, assign: (decoded: string) => void): Promise<void> => {
    if (isLedgerBlob(value)) {
      try {
        let resolved = cache.get(value.sha256);
        if (!resolved) {
          resolved = resolveBlob(value);
          cache.set(value.sha256, resolved);
        }
        assign(decodeBlob(value, await resolved));
      } catch (error) {
        options.onError?.(value, error);
      }
    } else if ((value as Record<string, unknown> | null)?.[LEDGER_BLOB_KEY] !== true) {
      await hydrate(value);
    }
  };

  const hydrate = async (node: unknown): Promise<void> => {
    if (!node || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        await hydrateSlot(node[i], (decoded) => {
          node[i] = decoded;
        });
      }
      return;
    }

    const object = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(object)) {
      await hydrateSlot(value, (decoded) => {
        object[key] = decoded;
      });
    }
  };

  await hydrate(events);
}
