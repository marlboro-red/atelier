import { ApiError } from "./api";

type Preview = { html: string };
// Keep parsed responses in a bounded LRU, but validate saved data on every open.
export function createPreviewLoader(
  fetcher: typeof fetch = fetch,
  budget = 32 * 1024 * 1024,
) {
  const cache = new Map<
    string,
    { etag: string; value: Preview; size: number }
  >();
  let bytes = 0;
  const remove = (path: string) => {
    const entry = cache.get(path);
    if (entry) bytes -= entry.size;
    cache.delete(path);
  };
  return async (path: string): Promise<Preview> => {
    const cached = cache.get(path);
    const response = await fetcher("/api" + path, {
      cache: "no-store",
      headers: cached ? { "If-None-Match": cached.etag } : {},
    });
    if (response.status === 304 && cached) {
      // Another request may have evicted this entry while validation was in flight.
      if (cache.get(path) === cached) {
        cache.delete(path);
        cache.set(path, cached);
      }
      return cached.value;
    }
    remove(path);
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new ApiError(response.status, error.error ?? response.statusText);
    }
    const value = (await response.json()) as Preview;
    const etag = response.headers.get("etag");
    const size = value.html.length * 2;
    if (etag && size <= budget) {
      cache.set(path, { etag, value, size });
      bytes += size;
      while (bytes > budget) remove(cache.keys().next().value!);
    }
    return value;
  };
}
export const loadPreview = createPreviewLoader();
