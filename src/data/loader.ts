import type { DataBundle } from './types';

let pending: Promise<DataBundle> | null = null;

/** Load the bundle produced by `npm run data:build` (served from public/data). Fetched once per page load. */
export function loadBundle(): Promise<DataBundle> {
  pending ??= (async () => {
    const res = await fetch(`${import.meta.env.BASE_URL}data/bundle.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`Could not load player data (HTTP ${res.status}). Run "npm run data" to build it.`);
    return (await res.json()) as DataBundle;
  })();
  return pending;
}

/** Accent-insensitive search key: "Dončić" matches "doncic". */
export const searchKey = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
