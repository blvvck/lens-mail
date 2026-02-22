import type { ApiResponse } from '../types';

export function ok<T>(data: T, status = 200): Response {
  const body: ApiResponse<T> = { ok: true, data };
  return Response.json(body, { status });
}

export function err(error: string, code: number, status: number): Response {
  const body: ApiResponse = { ok: false, error, code };
  return Response.json(body, { status });
}

export const notFound = (msg = 'Not found') => err(msg, 1, 404);
export const unauthorized = () => err('Unauthorized', 2, 401);
export const forbidden = (msg = 'Forbidden') => err(msg, 6, 403);
export const networkError = (msg: string) => err(msg, 3, 502);
export const rateLimited = (retryAfter: number) => {
  const res = err('Rate limited', 4, 429);
  // Clone to add header (Response.json returns immutable)
  return new Response(res.body, {
    status: 429,
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': String(retryAfter),
    },
  });
};
export const validationError = (msg: string) => err(msg, 5, 400);
