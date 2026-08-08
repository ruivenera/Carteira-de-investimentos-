/* Carteira — app + cotações num único Worker.
 * Gerado automaticamente. Para atualizar, volte a gerar; não edite à mão.
 * Os ficheiros da app vão comprimidos no fim do ficheiro. */

const TIPOS = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8',
  png: 'image/png',
};

let FICHEIROS = null;
async function abrir() {
  if (FICHEIROS) return FICHEIROS;
  const bytes = Uint8Array.from(atob(PACOTE), c => c.charCodeAt(0));
  const fluxo = new Response(bytes).body.pipeThrough(new DecompressionStream('gzip'));
  FICHEIROS = JSON.parse(await new Response(fluxo).text());
  return FICHEIROS;
}

async function servir(caminho) {
  const ficheiros = await abrir();
  const nome = caminho === '/' ? 'index.html' : caminho.replace(/^\//, '');
  const f = ficheiros[nome];
  if (!f) return new Response('Não encontrado', { status: 404 });
  const tipo = TIPOS[nome.split('.').pop()] || 'application/octet-stream';
  const corpo = f.t != null ? f.t : Uint8Array.from(atob(f.b), c => c.charCodeAt(0));
  return new Response(corpo, {
    headers: { 'Content-Type': tipo, 'Cache-Control': nome === 'index.html' ? 'no-cache' : 'public, max-age=3600' },
  });
}

const MAX_SYMBOLS = 40;
const DAYS = 60;          // histórico pedido, para o sparkline e a variação do dia
const CACHE_SECONDS = 600; // 10 min

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    // tudo o que não for a API são os ficheiros da app
    if (!['/quote', '/history', '/health', '/debug'].includes(url.pathname)) return servir(url.pathname);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return json({ error: 'Só GET é aceite.' }, 405, cors);

    if (url.pathname === '/health') return json({ ok: true, time: new Date().toISOString() }, 200, cors);
    if (url.pathname === '/history') return history(url, ctx, cors);
    if (url.pathname === '/debug') {
      const sym = (url.searchParams.get('s') || 'vwce.de').toLowerCase();
      const saida = { simbolo: sym, yahoo: paraYahoo(sym) };
      try { const y = await yahoo(sym, { range: '5d', interval: '1d' });
        saida.viaYahoo = { moeda: y.moeda, preco: y.atual, pontos: y.pontos.length };
      } catch (e) { saida.viaYahoo = 'erro: ' + e.message; }
      try { const c = await get(`https://stooq.com/q/l/?s=${encodeURIComponent(sym)}&f=sd2t2ohlcv&h&e=csv`);
        saida.viaStooq = c.trim().split('\n').slice(0, 2);
      } catch (e) { saida.viaStooq = 'erro: ' + e.message; }
      return json(saida, 200, cors);
    }

    const raw = (url.searchParams.get('s') || '').trim();
    if (!raw) return json({ error: 'Falta o parâmetro s com os símbolos.' }, 400, cors);

    const symbols = parseSymbols(raw);
    if (!symbols.length) return json({ error: 'Nenhum símbolo válido.' }, 400, cors);

    const out = {};
    await Promise.all(symbols.map(async sym => {
      try { out[sym] = await quote(sym, ctx); }
      catch (e) { out[sym] = { error: String(e && e.message || e) }; }
    }));

    return json(out, 200, { ...cors, 'Cache-Control': `public, max-age=${CACHE_SECONDS}` });
  },
};

/** Séries longas para reconstruir o histórico da carteira. step=w devolve um ponto por semana. */
async function history(url, ctx, cors) {
  const from = (url.searchParams.get('from') || '').replace(/-/g, '');
  if (!/^\d{8}$/.test(from)) return json({ error: 'Parâmetro from em falta (AAAA-MM-DD).' }, 400, cors);
  const weekly = url.searchParams.get('step') === 'w';
  const symbols = parseSymbols(url.searchParams.get('s') || '');
  if (!symbols.length) return json({ error: 'Nenhum símbolo válido.' }, 400, cors);

  const out = {};
  await Promise.all(symbols.map(async sym => {
    const cache = caches.default;
    const key = new Request(`https://cache.local/h/${sym}/${from}/${weekly ? 'w' : 'd'}`);
    const hit = await cache.match(key);
    if (hit) { out[sym] = await hit.json(); return; }
    try {
      try {
        const y = await yahoo(sym, {
          period1: Math.floor(Date.parse(from.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')) / 1000),
          period2: Math.floor(Date.now() / 1000),
          interval: weekly ? '1wk' : '1d',
        });
        if (y.pontos.length) {
          const body = { p: y.pontos, moeda: y.moeda, source: 'yahoo' };
          out[sym] = body;
          const res = json(body, 200, { 'Cache-Control': 'public, max-age=43200' });
          ctx.waitUntil(cache.put(key, res.clone()));
          return;
        }
      } catch (e) { /* segue para a Stooq */ }

      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const csv = await get(`https://stooq.com/q/d/l/?s=${encodeURIComponent(sym)}&d1=${from}&d2=${today}&i=d`);
      const rows = csv.trim().split('\n').map(r => r.split(','));
      if (rows.length < 2 || !/date/i.test(rows[0][0])) throw new Error('sem histórico na Stooq');
      let pts = rows.slice(1).map(r => [r[0], parseFloat(r[4])]).filter(p => p[0] && isFinite(p[1]));
      if (weekly) {
        const semana = new Map();          // fica o último fecho de cada semana
        for (const p of pts) semana.set(chaveSemana(p[0]), p);
        pts = [...semana.values()];
      }
      const body = { p: pts };
      out[sym] = body;
      const res = json(body, 200, { 'Cache-Control': 'public, max-age=43200' });
      ctx.waitUntil(cache.put(key, res.clone()));
    } catch (e) { out[sym] = { error: String(e && e.message || e) }; }
  }));

  return json(out, 200, { ...cors, 'Cache-Control': 'public, max-age=43200' });
}

function chaveSemana(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  const dia = (d.getUTCDay() + 6) % 7;                 // segunda = 0
  d.setUTCDate(d.getUTCDate() - dia);
  return d.toISOString().slice(0, 10);
}

function parseSymbols(raw) {
  return [...new Set(raw.toLowerCase().split(',').map(s => s.trim()).filter(Boolean))]
    .filter(s => /^[a-z0-9._^-]{1,20}$/.test(s))
    .slice(0, MAX_SYMBOLS);
}

/* A Stooq só deixa descarregar séries de uma parte dos mercados: serve ações
   americanas e recusa muitos ETF europeus. A Yahoo cobre Xetra, Lisboa, Madrid,
   Paris e Londres, e ainda diz a moeda de cada título. Fica como fonte principal. */

const MERCADOS = {
  US: '', DE: '.DE', UK: '.L', FR: '.PA', NL: '.AS', IT: '.MI', ES: '.MC', PT: '.LS',
  CH: '.SW', PL: '.WA', SE: '.ST', NO: '.OL', DK: '.CO', FI: '.HE', AT: '.VI',
  BE: '.BR', IE: '.IR', CZ: '.PR', HU: '.BD',
};

/** nvda.us -> NVDA · vwce.de -> VWCE.DE · cspx.uk -> CSPX.L */
function paraYahoo(sym) {
  const s = String(sym).toUpperCase();
  const m = s.match(/^(.+)\.([A-Z]{2,3})$/);
  if (!m) return s;
  const sufixo = MERCADOS[m[2]];
  return sufixo === undefined ? s : m[1] + sufixo;
}

async function yahoo(sym, params) {
  const q = new URLSearchParams(params).toString();
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(paraYahoo(sym))}?${q}`, {
    cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36', 'Accept': 'application/json' },
  });
  if (!r.ok) throw new Error(`Yahoo respondeu ${r.status}`);
  const j = await r.json();
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  if (!res) {
    const erro = j && j.chart && j.chart.error && j.chart.error.description;
    throw new Error(erro || 'Yahoo não conhece este símbolo');
  }
  const meta = res.meta || {};
  // Londres cota em pence: normalizar para libras
  const pence = meta.currency === 'GBp';
  const k = pence ? 0.01 : 1;
  const ts = res.timestamp || [];
  const fechos = (res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close) || [];
  const pontos = ts.map((t, i) => [new Date(t * 1000).toISOString().slice(0, 10), fechos[i] * k])
    .filter(p => isFinite(p[1]));
  return {
    pontos,
    moeda: pence ? 'GBP' : (meta.currency || null),
    atual: isFinite(meta.regularMarketPrice) ? meta.regularMarketPrice * k : null,
    anterior: isFinite(meta.chartPreviousClose) ? meta.chartPreviousClose * k : null,
  };
}

async function quote(sym, ctx) {
  const cache = caches.default;
  const key = new Request(`https://cache.local/q/${sym}`);
  const hit = await cache.match(key);
  if (hit) return hit.json();

  const now = new Date();
  const from = new Date(now.getTime() - DAYS * 86400000);
  const d = x => x.toISOString().slice(0, 10).replace(/-/g, '');
  const histUrl = `https://stooq.com/q/d/l/?s=${encodeURIComponent(sym)}&d1=${d(from)}&d2=${d(now)}&i=d`;

  let data = null;
  try {
    const y = await yahoo(sym, { range: '1mo', interval: '1d' });
    const ult = y.pontos[y.pontos.length - 1];
    const preco = y.atual != null ? y.atual : (ult && ult[1]);
    const ant = y.anterior != null ? y.anterior
      : (y.pontos.length > 1 ? y.pontos[y.pontos.length - 2][1] : null);
    if (isFinite(preco)) {
      data = {
        price: preco, prev: ant,
        changePct: ant ? ((preco - ant) / ant) * 100 : null,
        date: ult ? ult[0] : null,
        series: y.pontos.slice(-40).map(p => p[1]),
        currency: y.moeda,
        source: 'yahoo',
      };
    }
  } catch (e) { /* segue para a Stooq */ }

  if (data) {
    const res = json(data, 200, { 'Cache-Control': `public, max-age=${CACHE_SECONDS}` });
    ctx.waitUntil(cache.put(key, res.clone()));
    return data;
  }

  const csv = await get(histUrl);
  const rows = csv.trim().split('\n').map(r => r.split(','));
  if (rows.length > 1 && /date/i.test(rows[0][0])) {
    const closes = rows.slice(1)
      .map(r => ({ date: r[0], close: parseFloat(r[4]) }))
      .filter(r => isFinite(r.close));
    if (closes.length) {
      const last = closes[closes.length - 1];
      const prev = closes.length > 1 ? closes[closes.length - 2].close : null;
      data = {
        price: last.close,
        prev,
        changePct: prev ? ((last.close - prev) / prev) * 100 : null,
        date: last.date,
        series: closes.slice(-40).map(c => c.close),
        source: 'stooq/d',
      };
    }
  }

  if (!data) {
    // segunda tentativa: só a última cotação
    const csv2 = await get(`https://stooq.com/q/l/?s=${encodeURIComponent(sym)}&f=sd2t2ohlcv&h&e=csv`);
    const r = csv2.trim().split('\n').map(x => x.split(','));
    const close = r[1] && parseFloat(r[1][6]);
    if (!isFinite(close)) throw new Error('Símbolo sem cotação na Stooq');
    data = { price: close, prev: null, changePct: null, date: r[1][1], series: [], source: 'stooq/l' };
  }

  const res = json(data, 200, { 'Cache-Control': `public, max-age=${CACHE_SECONDS}` });
  ctx.waitUntil(cache.put(key, res.clone()));
  return data;
}

async function get(u) {
  const r = await fetch(u, {
    cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
    headers: { 'User-Agent': 'carteira-pwa/1.0' },
  });
  if (!r.ok) throw new Error(`Stooq respondeu ${r.status}`);
  return r.text();
}

function corsHeaders(request, env) {
  const allowed = env && env.ORIGIN;
  const origin = request.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': allowed ? (origin === allowed ? origin : allowed) : '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}



const PACOTE = "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";
