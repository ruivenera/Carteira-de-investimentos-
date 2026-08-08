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
    // no-cache: o browser guarda, mas pergunta sempre se mudou. Com max-age,
    // uma versão nova podia demorar uma hora a chegar ao telemóvel.
    headers: { 'Content-Type': tipo, 'Cache-Control': 'no-cache' },
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
    // previousClose é o fecho da sessão anterior. chartPreviousClose é o fecho
    // anterior ao início do período pedido — serve para o gráfico, não para a
    // variação do dia. Trocá-los faz um mês passar por um dia.
    anterior: isFinite(meta.previousClose) ? meta.previousClose * k
      : (isFinite(meta.regularMarketPreviousClose) ? meta.regularMarketPreviousClose * k : null),
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
    // se a Yahoo não disser, o penúltimo fecho da série serve
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
