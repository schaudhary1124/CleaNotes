export interface Env {
  TURN_KEY_ID: string;
  TURN_KEY_API_TOKEN: string;
}

// Origins that can actually need real CleaNotes TURN credentials - the desktop app's Tauri
// webview on macOS/Linux, its webview on Windows, the Vite dev server used by `npm run dev`, the
// deployed browser-guest page (see vite.browser-guest.config.ts/docs/edit/), and that page's own
// `vite dev` origin. Anything else gets no CORS headers, which stops the fetch from a stray
// browser tab (the API token itself never leaves this Worker either way, but there's no reason
// to hand out free TURN credentials to arbitrary web pages that happen to find this URL).
const ALLOWED_ORIGINS = new Set([
  "tauri://localhost",
  "https://tauri.localhost",
  "http://localhost:1420",
  "https://schaudhary1124.github.io",
  "http://localhost:5173",
]);

// Comfortably covers a note-sharing session without forcing a re-fetch every few minutes; well
// under Cloudflare's max TTL.
const CREDENTIAL_TTL_SECONDS = 6 * 60 * 60;

function corsHeaders(origin: string | null): HeadersInit {
  const allowOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : "null";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("Origin");
    const headers = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers });
    }

    const upstream = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl: CREDENTIAL_TTL_SECONDS }),
      },
    );

    if (!upstream.ok) {
      return new Response("Failed to generate TURN credentials", { status: 502, headers });
    }

    const data = await upstream.json();
    return new Response(JSON.stringify({ ...data, ttl: CREDENTIAL_TTL_SECONDS }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...headers },
    });
  },
};
