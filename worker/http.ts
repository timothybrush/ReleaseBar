export const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type",
};

export const workerFetch: typeof fetch = (input, init) => fetch(input, init);

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=60, stale-while-revalidate=300",
      ...corsHeaders,
      ...headers,
    },
  });
}

export function redirectResponse(
  location: string,
  headers: Record<string, string | string[]> = {},
): Response {
  const responseHeaders = new Headers({
    location,
    "cache-control": "no-store",
  });
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        responseHeaders.append(key, item);
      }
    } else {
      responseHeaders.set(key, value);
    }
  }
  return new Response(null, {
    status: 302,
    headers: responseHeaders,
  });
}
