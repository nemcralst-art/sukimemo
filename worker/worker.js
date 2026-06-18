export default {
  async fetch(request) {
    const ALLOWED_ORIGIN = 'https://nemcralst-art.github.io';

    const corsHeaders = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.searchParams.get('path');

    if (!path || !path.startsWith('/api/')) {
      return new Response(
        JSON.stringify({ error: 'path must start with /api/' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    try {
      const noteRes = await fetch('https://note.com' + path, {
        headers: { 'User-Agent': 'sukimemo/1.0' },
      });

      const body = await noteRes.text();

      return new Response(body, {
        status: noteRes.status,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json; charset=utf-8',
        },
      });
    } catch (e) {
      return new Response(
        JSON.stringify({ error: 'proxy fetch failed', detail: e.message }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  },
};
