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
const VERSAO = 'v2';       // muda quando a fonte muda, para largar o que está em cache

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

    return json(out, 200, { ...cors, 'Cache-Control': guardarPor(out, CACHE_SECONDS) });
  },
};

/* Uma resposta com erros não pode ser guardada: se ficasse em cache, o telemóvel
   continuaria a mostrar a falha muito depois de ela estar resolvida. */
function guardarPor(out, segundos) {
  const houveErro = Object.values(out).some(v => v && v.error);
  return houveErro ? 'no-store' : `public, max-age=${segundos}`;
}

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
    const key = new Request(`https://cache.local/${VERSAO}/h/${sym}/${from}/${weekly ? 'w' : 'd'}`);
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

  return json(out, 200, { ...cors, 'Cache-Control': guardarPor(out, 43200) });
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
  const key = new Request(`https://cache.local/${VERSAO}/q/${sym}`);
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
