export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch("/api" + path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new ApiError(response.status, result.error ?? response.statusText);
  }
  return response.json();
}
export const post = (body: unknown) => ({
  method: "POST",
  body: JSON.stringify(body),
});
