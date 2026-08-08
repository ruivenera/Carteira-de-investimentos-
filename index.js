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
    if (!['/quote', '/history', '/health'].includes(url.pathname)) return servir(url.pathname);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return json({ error: 'Só GET é aceite.' }, 405, cors);

    if (url.pathname === '/health') return json({ ok: true, time: new Date().toISOString() }, 200, cors);
    if (url.pathname === '/history') return history(url, ctx, cors);

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


const PACOTE = "H4sIAAAAAAACA+29XXPbSJYg+ldgllsFWCBIypLLBgVpJVkuu8pfZdnV1SVyrCSQJGGBSBhIUpIpREzMw8be142JuK87dyJ2ozdmnjomJmIfx/+kf8ndczITSICgLFf3TkzEvR3VFpHIL2SePN/n5LIVxgG9dKZ8FrXcZYu33Nbuncevjt7+4fWxAaV7u/CvEZF44g1aCW+/fjto7e1OKQn2dmeUE8OfkjSj3Bu05nzcfghvecgjundEUk7DlOx2xLOoHpMZ9QatRUgvEpbyQcvwWcxpDB1chAGfegFdhD5t44MdxiEPSdTOfBJRr2erdu1xyD2fLWgKA+o98ymd0bbPIpZWOv+m+6S33TuoVydJEtH2jI3CiLYv6KhNkqTtk4SMIlppf0Wzetvf1qpxRFyiSku1fLdqnnHC51l7RNJ2xq9qPY0i4p+3eUriLJr7NObQZRTG50ZKI/gMEodjmsFeTFM69gYtp6PKnAs6Kt9XmomJcDb3p+3QZ7HeHJ7bvYddJ4kntWaNVXd6Ww1Vk5T6LI6pr01tynmSuZ3OmMU8cyaMTSJKkjBzfDb7+uawbqEv2hp+yrKMpeEkjGU/txiz42fZ1v6YzMLoynt2+GLzdUQvN1+wmLkXkyn/T9vdbn+n2+0/6HY36rVOSJzdrtbmEYsDGmc0EPVV3SDMkohcedkFSQYt+d0IAdmUUtyxzE/DhBtZ6mtf4gfxh8zxIzYPxhFJKX4J+UAuO1E4yjqXUXbZ6Tq9h84O/nbG8yhyZmHsfEBw7ohO93ZxqD03ZYwv2+3RxJWnrN9uJySmkftN70Hv8daOet5yv+kdbm1vPe6321EYU/ebrftbx/cf9tttTi+5+83xd8eHx8f9dns25zRwv3m482jn4H6/3R6lJMvcbw4fPXq4A93PE/ebnSeH3YfwELCL2P3m8aMHj7af9NvtcUS4+832wc7DBw+gK9iMb58dvjBgPQ3Ym2/teYjlWUJ8an978kQWv6BxxOziTb/dzmCTytawG9/abQH82VXG6cwWf9rz0IbK7Yym4bjfbvssDmotjWIfv7Xrfa7pJSGB23uYXOb3liN22c7CT2E8cUcsDWjaHrHLfMSCKxuw9HJG0kkYu93+iPjnk5TN48BdkNSEnbH6iBLlMyy2hS2XANRtAXPyJQxv9QG3nIe8je+zGWN8CgOTGPBxSDIa9BMSBFA2I5dmbyu5tGm8MDMypm2SUtIO44zyNmeJZRlNb9JwMuWW4ZPIN797mFwam43VRoxzNlvTR0TH3OoDHcj8lEVRe0SnZBGytH3lAgYkYYyf6UTMP6fBEmqOI3bhTsMgoHHuXKQkWc7IpaA37s6DbnLZVwtpkDlnxWd2DbE+CQms3EEAXeqLiiVW7syTSvE8sXIHILRSCgVW7gCoNnUymnPOYtwcN4ynNA253ED1pO1x1+j2BUC43b4/TzOWugkLY07T3B0zf561F2EWjiK6ZHOO524ruTQyFoWB/CY8XlZfvm6z8TijHGrJjtspCcJ55t5PLnOHXtFRyi4aQAdA3upj+QWF7XUfdLviOQs/UbfXSy77EeWcpm04YLCsTm+bzvoAkYJGjVk6c+dJQlOfZLTftMKcJUu5KwBfbq8L0+IsGZF0KXGiO47oZf/DPOPh+KotqaGLp7o9ovyC0rhPonASt0NOZ5k7IhmFb+9PSLVDQ32vkSWkuoli1aAiJ1HDcgAeqS7HTmU5/IjMEvP+dnJp97qLC3t7O7m06uvTdrpbdCZaLUgakpi34/mMpqHvcjKaRySF50xB7YPk0ugasHW4lVMxcM/p7uROQCNObp6o2Kf7yeWXR5T9GU5GqyAPA1vlKQLs9Q1NU4mgii3TB9xydpLL/soJUeAH53wFaEUNBQhYRW4cSWgVDmBTYUnkamw9KE95TyzYtmpohMsqzAPMImSGPGSxy2Bf+JXh3M9Eg4iMvgbobjw1YjG6uBgr5+Rrj8k0zLgiCltb+JXw3ZWTs10ecXyuLTHuZO5kCUnPnYswoEuBJ3vd7u/UYgLU9tUCjADR5o4/TxekoS4i1ErdvgYUuAfY1HBoeMmW4zCKKh91i9V71LB03Yc3rF3+DSzUS8bp8hZ702vcmy7gsBUKq3/bw5UDuZM7gMAT/VgAYObOBOSrvxiRqX0WBBQnULANWNJrJAK5M8nms9sgidUzq2/SzZgD6MfNsxFIRBFfwEjGCnWDbhyW0Hi5wvIgv6khIWQzSgJ+r92rdV6+qy6TkCVdBJyEpDTmuZPOSBj/dSjNFmx4ml3dasV3FNLUyMkquejRGXQ5H90Gnreat1CDSaT5KXJrSzxD+DEuFvTh292YxTR30sWXiGDtI74AIf50cpvuxIGszvc2/V+QNL79gV+lTNqIeGgDykkYVWhcA3INSDaljSAuqmyVXRkC7TZh3G4d46rZqLOkdxNEBaRO0jDowz9tTmdJRDhqSuazOHN749TojdOC/TF6Go3slp3x5b8fAVNjBrdlWRSxQ1rXvSUeokHIV7btlifnqwhNf5V3vBVGrmNysbnMP18mTDIl4/CSBn1kgbp9PJkgBorq3f6nNur53K2KaJhORsTs7dhbXXvrge082rLwbZCypD0OI05TdxTNU7OHXOmXmIQSmXYryFQgXiy8Wb4Tn2Q4YRzT9Asi2Qpv91AtiaEkJ8BLvXJSABIPiuO45hNqfF/3lnDQzBE8ugkS1pCryje4xOfhgq4hbVvVys45vVIEtQHMGqSWb7CbOgjhnmggc38VZB7ZvS2798B2HljVjdCJHBS0aRzIYU6FvD0sMJEgGailWku7NcQH4CCR36OtxbRfyPEIDrV9eyCxl1EKxoK5uvF0iXZ1wN3a/iLg9m+EVfmRfwlHBzpbmtZRPDLLRd/GdOs2SPJBAwNR4HixVUcRyyQnjG22VkTJYsVgbR428g+5Mw5pVH5xI5HCL8B6QrSuVr4Naf7LiUxtTg/KKYVxMue2mh+NqM91Unw7HdvX4JuHpWyGn2YghbkdQ5U7/pT656tCLyKxWwFThZau4exBpoz58jYyQE3WKQ9F1xAbDz0ZPgvorUSN2iBKVAEmbsQul79BTdBvUMcBxmVxtmyiLzrDhwpZVXsdybm/oj27LUW5/9UibDEXJ0nDGUmvVpFqhRJ809vuPewFdVXdaj9uEGZg1QqWUu/hOvd3tGqTKcv48iYoz50k1CBTsKCFjg3eqQWsnn/trGlSB2xfBWN/FUVHheZacqrNpaC96yiqqv1FpLUCytvOzlokrM7jdrE06xDjzacvdzI6aQDjkqUvTj5CMtReB8bAuW1/3To/+gsY6AdfKyRoc3dY/FU80A2wwC9YAzJFzptfsL17aplmYSxpf1e8WcPpLMCcc7WsLf6Df3dJ49b7V9l/xNjfIIl5Nf8C1m44KxwwiJOkdFGhoMVORSTJqKt+KFKxjRzcbYkgHgVtJINP/90k1RUEVT/dX6PpQsa18iGBMna4O6gEu01vXxZ9KyO4MeOmOw7TjLf9aRgFll1ZytX3K6ogMIOQjDfKpDuAxIulFK4IhNNfzPZO93eWURT8AfltS0muyIE//LJpcO05vhXQ4wzv12rME6vGjO2skPNHNaYJkasSBWZhbD7aWlzYO1td+CQlUG13+4qSdvtSj9mmCxrzDFFFo6lhK7OL5YMnudZONmUXBWHu3XKJu5ZqPiKBzjm1Vzmi/zSjQUgMM0npmKZZO6XB3KdBe8ZwguLRWt5barOGr7gTzsBNh8Q8z3c7wk1gtyPchsAeu7cbhAvDj0iWgeNPShKDswR8C/RyYYCrl0pz3KBVuBgZu0Am9/7tX3c7+MP45e2hsWn8mJJzGu92gnCxpgcjDMBh4ir2D8BZIqMzIyABy2Sb1ZZo6VPt5MPen//27xuqom1MVZUPjV2ShBY94u91tSIyQo8O+MSEZswIqOGTgBhw5D7/j8//yOT3iyo+Sw3PQByAL42AGUFIVB0xRiIGpil4SwnStbfbSaqDg31ETRF+/z5FdxNV/YalhdpvhW/T3s8kYqkREMMvPMOKzywqV7++KAbrTPlK/xc08RVAUkNHqjeosbcbE21rmH9ehypUO0GhYCVEHyMev6HjlGZT8A+SNc/p1aC1d8DnJAo/kXS3I1rsGfWmz2bCxW3vIAj9kMU31T2hnIfxBNxrHtNxGMN+/gvNigbqm2OiLw2iuTU7UXgArRTCMUQvvi2tF7VLu53pVnURSq3AoGUANLUjMkJPoycUvP/+90H8/H/XJ1qd4iELrpq3r3q4SAln8kHVQ2nc4FcJ+MCNw6g4MvI38X2agLeb42cL2wGvJfzXdvgl11ZIukPJjmYsmGNz4R7ldEiS1H2cOgJfddAdspXbLVFH+UsKRLdMwAvy6ORng2QGteP5DH5wO6Cc+vyEzVOfQgmzx2EcPKUkoOkbdgFFxObs1egD9XkGj7F9jmjrKYuA+GBZZk/mNMtekCQJ4wmUhPYlH+lVUvuXt4fvnzw7fv74BJ590eRonqY09q+gKLI5O+GMfYSHwA6zX/joDYXZQ8Eceiwfk3ycglec08EvSzNclr7P4owbM880LW9vGVFuUG+Z29y7A9Tnahkxn0QnnKVkQp2M8meczsxB6/37JGUjOmjZg1Zv0LLsSr2UztiC1qta0Gs39wn3pya1ljBGnlI+T+NlQtMszFBtxu0J5SazibWECYgJxh7frwwxkVNhlktP2bAv+jHieRR5XrxP3B9OXr108FPN2CoHlfVInttZ0zDYLONpGE/C8ZVJrH5tYLUGzI7F0F5c9p7neW6Zlj31Bi2FFB1A5j4Dv1F7rJf7LB6Hk0HLXuilBNSIWPlKLwacydLQZ4OWPdFfzEhCyYzGHN6M9DdhAL1cVIfkRE7lXC+nlzwlnEH53Up9MN0PWvaRV3CBmTuDxTen9unQsv3xxBWw7pAsCyexuUxSdnnlDlqDlu1PfqTy5zQM6BHJpu6dXm6LHsb2Mrcsmy1kjwt4trOYJGqMKxwjIwsavCCJLJzYsMmWnSJoq6rn2BjmS2XJXVnPnzwLVK0R1vo4Z5yqogsockTR9fUyt8eXlTfjy+vr5fG7N24vtwVfUXlN+PU1jGOD0drFX6N5duXe6dk0TVmKX5/bHz3q7Z3dXVInQ9SRu/j7ajZiUX5mX3p4/GYAXebUPnKK1bZsUTi2jxx/PFGPC/vIYQv1NIKX8JlWbh97JrW55e3F9MJ4FvPIeTmfjWj6hKUzws3C59tezsI4nM1nT1Kh+3kcTkKeudSekcuGcp5b9gl8BXzjHY9ubITZE/Dmpia19o/NLXvLcsZiEGptDlrGn//unwYtd9D689/+/aBlP7+hbdfu3tj27dq2Jt3zuvuD1qao/V/+66BlbVYn84LwqUNGmUkt7Pp3Wscf/podV+d8AF1rVfa8Hn7ptvalLhQ81ArsF2pCnkf3ZVfuSi/VtXah4IHeyyH0EjB/DngBgPU4ovDz8OpZAO+fwfsTRHImtZyUJhHxqdk53djdG7SGnYlNvT1zOWht4AdtkFnSR1S/K54jLh73xOMEH78dtL6FJzhK/UErP6VDy+qP5zFCkfHKtCSSpZ4G34C/TOrtyXfc+wgTZB6A9ykf4okkntgi5nzkV/v4r0vhXzsu3pDF5IhlfL/45VL1y848kzm+f3V9DX7RGVc09Pp60Dp+92bQshzO3oE64Ihk1LTs0DuSGOGUD0GXYKReuB+CCtWneMj7Ytx0Y4M5CY19urFhph2v1+1akqQC++GnVwngZc/zqHMexsF+zz1yxpen2XB/H3FF5BUdiR/+PrmX3vNdQMLApJZNyT2zaNu1BKoJvFA1DFGy35fT2RePnV6364qfosFcjhfo4wX3fPE2kW8j9Xa+H7Xn4t1Mvov1lrFqOa23nO1H7Zl4N5bvphsbs/1pp4DmmXUPpofLKdkAx3GofU6vXG7DJhNbbWZs+/6Vm9liB1J7QaI5dSM7IFcHo8xN4Mdrn7uwS/6UxBMKTzg87Lg7s5MIKk7tJII3YxvcsWmGDeRPrJ1xElH3TmjHjFM33NgIHcTj+/Kvyxx4A6CDBO5Z4Erce6rw+VBQhDwHhgeYIRCpTYmV6abJHZz99XXXsrsA6411xJepSsTjbWbHzVXhC1XFzKOOsPWbJWrDGmpnqBjeWumJO7hGdtdS3BQFnHJMgLfx9qgj9F8e3zdp+Qkd7nYte5myC6AdKEG7XO0LU/tC9lmHFNst9iS2kwi2FDck3s86cVEhzwnQWqPAHk9MaxmOzSMHiKslptcXT96drn0kNsfDTaHUVIewimrKdRm06Md5yK+08wWbta7yyjmGXTt1HAdo7AnlJvxuQGqmiWgMUBpiMutrsJA1tIbaLOjGhqx3x/MoQMTpsE8uSMiN1ymbhRl1SBSZp69NZjmSIfX2iJPMs6k5aB19/n9mo5C5xqC1SZ0ZzTIyoZZlUyei8YRP998BJVhtdyDE1no7sY1cNX5q8sZBQeBijW2HVrFpxPnAwtgctIx/+1cDxIQjRzBa3mPCqROzCxPKxF73JMtzYS8lG6dQNTBugCBtwl3VQ27ZCoQU+VkKEKW598q0+uHYvEMVPCkSZMK2wtiwI89OXklKaTlZFPrU7Nq9riBRyKvqe+QEdzwP4hfECiwDl9sLQb9RmWn2ut171AK0nON3Qgcekx23t7tdxdJdqbdWbloI0vUj8RoEDpy/3IX6Z5yW4UEkCZ1xSuLz8TzlNHUCuugsekjD11UhSTJoCeLH+mOWmqJbYrCxwa1SZOKeAMIxhd0/u7skeQfUkhnfB79I7/jdmw2BFzMPeF651/agZeVnYgO4w84tPgWPfFj5Y4AKc9B6+vbtawAd7ohoOHWomRyROx8y2Fc79iSDXs7zlNp8yMaGlE1ozAHFm8xJieTzLSs+pUOv1+EK2y1YGCCJ9XSBkXk0r8+N7TMFzu6gBUrGlGYJy0AjaOVilo+RpTeRa3dQJhI0Q2O3BoPO5t2OjaXX1xdhHLALiGshsL+OCFzr13Ydjmmx8o9NQT4kunkDnKhN6hvC8w6ekH3cgBhsPe/ePDtis4TFNBbISyEyZg31HSq2iDRvEX6X+Pg4oHPYLVLbrVhOh8jdgu5icfJXOlTl/QrhKT43PoUvHPb5xsYdLslywaghkvW4WytYCqrNNzZkC9gF2DEQhVGLOmjZJV+X52r/3niNCDwDfcv1dWAqam8BknjOLgrm8ZMSwJYKXOED3715blYPm8/CeEL9cyZi9ZKws7gPiLKgvjXY5WICamFMBHHL22NORknqT1+TlMwyRB4wviUERgdlcGBTV2oNWpfv/cn7gM7Ye5KE71ENqreybOaAhklgv9x+7y0P3x79bwlnFHKY/aBlH7996g5aoIFM6Xw2aNknr57DkWARiUFxcPD4AFnZNCAxrPQvb167g1YaQrTdoGU/fvX9sQvq2wmVHT7HAaKQq4LHr966g1bConMSMA41nr38EfqckjCGoM5By3538hgqcZyHeIZe5lnQlr0c/HzwiztokQWJSOxPaXsLCt++egE9sWyGqo9fnsNjxmkUgRI0r5+9XyTGLRi+oUS5RlkC4P2+8Y0HxTb802/CnJ/MQasj9giE849zml65NLduRJFHLIy/BxiqnsFVjGmaVZxpIfhl19enQ8sBDabJC4mQK8iu8iPA/BSwyfa1VfCYEwYrqggbSgWxr5OupzoSOx1q5IUBeaGlpKjOHysYqMmz4PpafMwvJlNT7dN9LmgutXQUwEoUAMphGhAjBstJGNCYh+MQrS0xMYqFrGEDsfZN9JWt7h4uaWdG0nPKAZ6Wi+y9L7k8OCVzgM0wyFwd4/IqxrXRRRxD+gYtns6pmtB7Ida8B6M1jbkgPVvb00FLwQhrgpHtrUeeBxwGAsQ+HK1ZyClYmhIahAHLDAJ2ijBgxp//9u8NUMFSIyAf56FBjPnMmIXxHHhfdy20sRq0KQLESvosURlooI8lOiOKap1SgB5UFjSj/VUmGmFgReyymQdCDojsuBzV/SIec9Ys5Put7amNbJha+/dh/P67ALFmtUh0AcemXyc0AmyYI3acv8dnuxC973hkv/ayY/Y2CfCCkp0uBVeixNOCu5Q0hf9u2/O6VskwWnZAOIACmTDILVASsJceRFsJQLZRPBN6ytEHJeqiJlJK98ISIaC+jve+N7muJI8URa/UgjrqZHAHchtU6SLsCXNoHGS/DzkIB2jSQc5npRg4D2RtJU/0y/OTXxqwHzFG4SgKGac+AYCOaMjnKf48vvRpJI66T9KUTtgcwRu9dsKPc2oQIwon0o5KjZSKanDeSuFRG95JKQlQMHgXxvzhQZqSqwKnEng6nI/HNDUty16CMQq2BIrhfCKTdgKWupdkRoV4yEHDBsvkcrE7+mBzHkaZ8AV+z9l7PEeyB1BJ2cspGpzcnp2SC9A1B3S8IJFQNlsViSRjMyqkWJQcldZvf18wozwNZ6ZlWblVbQZTUnhPYhf5tLoPuMzAWMY8paEwuBsxzTJqjEN/SsOUwaoq0pGrA0mLBQTXE9NSrObagVRvxoJ8CrU+T+VCItiJ1ST5MDc59jg3I6ukKIkZSbHv+voO1WT2taMyQ5pHBDxxOlP2+X+hmUFGNOUk0z4Q5IjyWMC5LQ6GPl6DIkeYNH7WtUPEU4SCOhHjhWpBYz/BWaUfU/PsCOLj0VXi7vKZSR3i+2wecys/s88Gg9gwDGM30XwAMHEIVOVWDrI3xtcbdGbsjvZED4p6WfluZ7QHdUCEq69Z3rAeDvgcqEHR86gYGFAiZpVJ93b5dO9ZnPEUNdVst8OnWPYTD5zi4WiecWbMPv8xCMsa6Hsgnjo8VSNVZyeX6kyMFMhvkuuW73Z4IIsPTFQnyzLZF8wbXr4wC01ypRGUaxum3sFszixF0kEeLFYBZ2H4LAJ/DW/Quo/eCXtvQSFhZHQyjwNm4AbCahdD4W68MJmVG027Ug6rLQIoj/fPmod8DBkH4BSBFETCS1L7KGjbOFbxeQLPqO/q4PburYWwI7BzpjNqUDBsGvHn/zWjKcsMn80MYpAkAReSX94eOsZjmrAwA/wtvY1S2+DzgBkJyTKClUlKfZrKsejMoPOUZTaA7oKmHLgYwgxfKLvAP+bw6LgCiujpUMwQHSBhFyreCFg6YpfKI+HyqXCXwXKqAwg63ryheLzTeZgazABD7ec/gaVW94wxiJGQlIfgLpMBTzUF34EUUocU7js4tfXLeALIB9QrRlieGFisLKC4WUprJTHFaXeIkbRCPoV0S/BS4v/CDAhhWnLIE2qAi3RqzAhsAjOATM5nROAFW+4JbYMfBIPPAJANA5K5BjFStQiSomYJTYlBjTH51M5EN9nnPxkL+qmyHbq3iHRB11x21Bv0SR+0jIBw0iY+RxN17IOnzN4R/tA8cVTXtT6k+3u1Fwab/0zCWs3j5cyyD82KuwuYiWl6dYKhIyw1vz1tmNDwW8shQXAMDoDP0aWBAhHxoxAgzc7o13ULM/xCl8iHmZbGMcMAEmgtR0KtzQCS+aiNylhJGmziNSBMU9hhJH/IQL4oTZACPex5Tre3sSE1vUtV1QbleGG7sgWqdUssYgvTHbwuTTvKIKAU4nr9UcrOKchuQNVw5uoV6k+lD8Bp8UFDb+k3dAMDqnHhbLjiiGD5qySTr14lmQ0xaPCMf0GVXOqgcyninpcDW/bP4EJinwmiq83uzLJRG8Q3NkpWwNum962lH1GSvg1nlM25+XvL9qk5aL3SEcfnP2rn6Z/By0/KY3DyScxp5hgCaqmBfD96Is15Cn5CcFgz28jkaXZAqPy9l1GuhkRQ+fX6+gf4JAr65dzKgQ1B9kmKD8KgE9hhcOlOc6/8BgudhDja9G4Q3AnoWtlFBtIfmtKZzlK63b55Bzwn9riT+Syl1saGyT0xqKiJI1Mb37pxbklPIYPnZmTZYy84nQ5BDrMXXmwG9tSyrzxmjpG3ewmsLJViiP0S+/MC+6UDwo+3sF9KLwzvyr4C4TXlSvoQrlpK/lDP4DUegNeM53lXDRwisrqf/2iwgt8FGiYaOcbxpdwp2DiDGRENJjTNUB4JPv+DwTIjIxHwzPQSnHAcXQTJzIVkV2/Nf8vOBAMuBtO405+1r7SpPWj9qD7ZRsYVoDZ/6UiB0Ks59+R2aMqic3qVmYvTrhDK0ZohHXWwQH7ByGusrkEONUo9PVYqBreskRPGfjQPqFYKyrXr64BGlFNDL+3fqdt6DOpVO4b9V1Owuce9vW93WYJCLho00YAI7r9GTOMpEC10BRZV9r7dpCVPWWuG3JKVD1rG3WU5KT70hCOHCDekAepRBq18T9Yv+q6wjDbzaspf38KRQenLQOl7VmNkMKix8CW+u2QOvs/hVwq2zpQG+4OWcU9NQHIdGiuDMxTEcYwfRHMUD7iYp3hfsCmV+YL0MWg9p2khKQmObtC6QfB4Io+Kq8QNcWp1UUNsWCFlRMg2KXalYCuBTYGkBzFiv1TppoC5/Dj//D8d48Cgmc+iKYHjSYzJHNTRAXJkyJiln/90Gc5InTm5u2S5zqcI79eUQsrKwo/1PwgjEyrPZMXMaCLZCl9TaMSQEtzMjRxEkanAV/Al4yFU0hV10htgXzuMDlTNKHfGQ+Vw4K4eWa1WXqK8ooIU1TY2yhJwAErlQbZLROGeDvv4HWp3LJF14OnbF8+9wsR9drMgevL5n2G4W0uhIAqhF5+yCm9Zv1XkFGXKP0P5MumSJziYDVqbKJJpvJKl/M2+JH3qklqTEoA2yfIgoX2cQ4bAgATUCMIxTYV+mBqfaMqc8hAyTbAThE6T4vBUnbnf1gY2ZLDvoLV3LA9oQiNmzGgMvchDDZJIJrfGANW0NiXs+NuvYqjVSQGmWoXCegV1zft/8XGgjbw6qnaBWbf+Q4gV+irc0K0mVVCv4dz1S6LvgdBQvFG88kRjC4BZRhFEMh5IIASbnFs2MZETLezuPsix0shu3+laeV7oo38GZtVmisiTJr8d7gFriVwe+sv0tTroukNsx3H40L40S0u1VLXZmfrVX+sRhALOncIfqIIPY2dKsvLYb2xksMZlgR1Xn8HrGbV4+z4Fgz1MLyutQuATkyvVB+g8gjkqD8IJjTPHOEjIRArqSNCE0hukgNSAwzNKSeqcwRK6onvedNTlUQ1IdnfJgFMIKNp2BLfgnAkfFPuJqcwLP6KnaqFyuMFVpvQB/UloQ0vta8Wwhs77wuHE66JkKl63e9LPE5nGPtv1SF/tfeaxTbK31+vT02x42h3ugnda7OFTDyxC2WbPcomXtVWogRHnMMTvsUf7V4hzqJk7fjCp5wtL76/KhvSrd6dbmG1rvJkmDTJwyeg3GA0NGEgw2MAqvYQ9mn7+B8UvZZJhKrYBpQDYs35pdyEex/SiL5ARBIsZIBuQY0HIQgkdYhQBtkstMWqAENQb2kqht6zNLQtcCH80Y3CC1c2URZfCGodJpudocdjU/B7XeEhYQzuFqBJfGXtFnEm3T3dDuU59uult7Vi+UCiEEn6oTTe3diyraMS9bp/v+qoR39y0ltQ8Oyjl5ZoS7s9/+9+Nu0u+2cs7d5eqXX5Wt1UWzjIs74hQiyt0l/FPecU8m2+ADdO7u8zyjYzTxLu42UGGGTe6yFSlq9Suusqooxat+BpqG+z7V3J/Z9W9VRxC1Y2w4kM4b7bklYe0CsTLvNH2fXazl1kHPJAc59beYKx5JRVaQ6UjxmKRS4JchtL2FpsurDFrjdFLzU/M4EJvAVbjiifCKbdZgwMZ0RzInIylYLWqOcdRi52SIRiiyVBAM/R1SobDQgaPczOyM8tOClchVDbgzqCbhazXK9b7J3MO3iNcc8DodZgw19rT6rGK+3RXc52Ek/Wgu/2Q7lhTMZ8fwU+sPz2dFgh2eMfzfjTLNtbGRlFXK1WLOi4o5cKbFh78EnNXqKkgDpuD1tut++7OI3fn0a/AmUyENsq06jtBEPA4oq29+PqaQ07zjIL3Fv7Y9WILaFsYz2kpxqygJL4GJRWuLXbmpadkaIdeBuQ52f/JzJzEpsoS7yXgV+1f2dSSrv5h6ffONj0OzPu98J7vjpGWFx0jccm8rgZJNhmiz2TpMFkgXt3iyvfiJp9sMkNFbRcQsmjY5nbqJSYp1ZvFJNONDZNteuG9dEXDQoRKE9dXDFZbR17t80cTyYHsmG9smNkmyCY4nXvcylXoXuDSVR9Xhj6udlgvz4Tva8VGXYbdOAsLGDWM4oKIsxBi6BdVLaw9C7MMXBUAD46HitG8a8t2lu7/feWNhXmUmlf7Z09LDWtFveoYd5dXFbPK3eXVXg/UNkpdYlRcBsFjSAReClVRlkHYZwTOB6DgW2BcNOoasvmIZjyckYA5YDZbNwUUtTgDvR3LKgYe4AOu9rqKM+ZA7yQDUWDDdcTPFc5gOhc9DmMSRVdL4Ec0lvoPmsoM5IgyKFz4xePSAnpGR0qxM+UviUf2tnQXEPHqtFan3Rva4IqzaDMnLOMMRDQv8Ehq9KoMr+ufFbjSgqMRXkQLmzrhsIAsBVbAlenMEQejuiggl7Ig9kibXV/37Ax0gg82eccsuU/r3v2th3YI/G5ve7O39eCe2WubtM2sTmzZKbQQekGT2gx8foF/fo6Q8wKixjLwyOfsCWTPMHtKkg9NUKzpLwqxHZ3gfU/ihYVlR+p3aNmBR0+ptphzL3AWe17ghPuDVpHqAkfX8j6AF1mVYQec3O26+N+vIvhgvZXQXs5YzKfgHTlFudG+ogTMMlvtAMIDwetEbubZbraYGKCFOWSX3qAF+cHub3eN3s5DLeReBpYaKYsoiqOTQUtqKioB6SspBlCygT8kCcFsHsYLOGABswtrMMSlKaUj4VMjQG2mnxvPjbvLTN9YbfFzo7fdNZ4bD/Dvr4OWAamqseUctLoyJwfElHcfDVqdpiGivGwGOTMgDJ2DActTeyGyyxTlIrOIN2j1nK2yEDLKousQ2OuN+2sG828YTM55ZZCHel9+mPqgDLvEBmvXBTbtCquEZuAs6u8g5mbLeVBfr3IYcO0xYAyoAx31du5rgABZwaUXSmJSsFkHFirF6CVf7eP+/e0bejFEBpvYn2IoEI2Doufgxm6LqXWbZ/bcJLXWu51sMdk7y02F3qwCcYnMFjryOkOtfNHx3SWnJrGEdv0D/FJZTogPauiAlVBtVJsi/Axae6gdf24yJ0TNQAR+rCwDpTnqyMH05NMPJFC5Qc7Au0gSTkDb8mepGB2le80jgbqgWrvmf1AljCUPrkZ2hUUDgyvUEsnUFBb6fR0V9xqpw57piolf3h7qR9vKC2Kh4m/EtHa37Ft2X+AS9HbX+9jztjY2zGYKRKipKhey18Ky72917e1tIK0rAKCPfnZ3WR0qh8wtmZHSSZhxtXmwp7IanISFlRt//s//tVJc7aXdw1pnVknJgfsprV+mhQpNmdimOqejFUeu/RNg+qBuoVcuJBDoRia9qSjTVFP2BYCnMqKxgPuyQHz6W1Hy2uflgWiGySn7QPXEOGUyFAoZh64b38lJJJE2AXgoB8dAxC+NjatTwLb+0d82NzgI44DgKSmBGvTmM1DmJSwtlOTgbC3VQY4cQGi2VTaj+u5BQNw+eMESlbnmz3/73wetIvhtv2Sa26psb6v3gO7sw1ZmqlkA3t0FY6BqlgwBSGqrDMGUzSsMgI2O4rTKE8joKPQIHbTwazAxUf1TisicaiXFFcoKdhMXiOCNWZZkKC14GZTChR6quteVMrtyphav2ioituLnivpJcRb0+DCu7biwfeolbCWcvWA0MfJPhtDazkOYrIzzl1C/33WLyu2eXbCsPVvV6GxbJZcVGpiEC2y/kLgQlCx61rS7yy74/Rc8IbDKwBWyve7NfGJeZDO7uzSd+zubzoOde4X7D9M41i1kAPCiO2UAL6Rg4+7y2OzZvSIrgf75Vv47tJ+Ge2d5xVZl0lJtA/sqMj5ZfaIt8elpGbxrF/GpBjWO3z4ZtIb2aRmua6sIVFUuvJIGrefhx3kY0E+D1nAo1WZc2NULVesKIAlFv4fhnRU3ZbEh8AF9UgEvPdC7rcOhFhr3pejwkqmmAr0XlmS4aKTkdGsW6InKCFVBSWWeNdBzNmJJuCkE3z+HrDmVzGLFSHeXQv3IaKOba0dOtba5NmmypDk4n7o5+QaLFPf2ltzhJJ1QqRLKuOwH0v5jPAHogxJkEPCPOGLC0HyOaRdcrQDVBeABdcMMZc9ftvLJSTJvbwlRMSx5nbKETIhwSmnAX6xmuxKBWB9NLsOtGgNZUN1FRW4McOrVYtkZQin4Y6jQqNID4yaPkZ8Kk6rac+ERiz4P5CfoXeTPnrGAYvo7YFUhU1npACOjXNBGj/+6mKojx7NedW69aSq6od0wY2KIsC09K57VNMkj4Vpx21kqI3vxyy2TiOwL/+avm/cLmGbjxPyrygyegZoN4v7ZmjwAgFZn5FLgF+UnXp3J3WW8f7MPkPJmKHRVTVPDFyuTK9SlRXgdTgmS30uxO/wEtdl4/MU1up2HNXkNSUvQeYrIBCaykuYyJb7rQJM2FiAXzAxsYJhBuAiDMEWmCoKqao7VZ+7NC/asDAlkaRkQ2Lijk9UNrcSksVL/LJHjuuUzMBZ8yqKAosx66biGip4tp56v9aJ6ZYiEYUbGRilNPv8LBXdronkiFiZFgxozEvPPf5xBFTpTbyQFHc9Rf/nXcc8O0KXpDeaBS/V0lr/VSft7dNr6C320b+FMbepMwDIHhSAKhAIHWgWnqHTWGXiuIrbzigDIEJkXiZBkExlo1Q+xukQ0HjfDghtIZSv/qt6oGocLNCHFXnz/ykstO66qbtWhXulDD8aj2AEedEwmIg6daC/PYuE5ntMoo9Uh4ADcon84DB61V06FR61cEjGPgAeG8JV+go4gX7OhwS1cY3BHde+PZm8RoLnCKir91OQEy+lhEg5gUkvmAcLm7D8UPhGcVtN3SRnQpch0A7/m0l34Cbw24jVgywet0kOCUV220RiYc3plM89cTQt1hu6+cJzR/xxcz90zzb9MyLe3cC3DxvAbSK+Ds/ORFAM+DTCFKQTFn1mbJnWEX/6+ytmyqUqktocUso3wDFwjG6NzrZB03RPFIVvI09Q/E/p1zyoICe4TM0rdAgrvyLtWNQmIJzAvEiRu2q/2AR5oUskn3hct8EsK9htid3zNdRCs03eXfH/Qgh1SJErhrfNCHjqnVzipJoSKd86tZeFTSOBcz/YK18oV0y29ClcSr8JdcbIeKypUufhqfUz4vTLaArMhQ8yRaHx3GedVt1f9AZwiip+8ttDi5i/9a9F1EqOcNzbUL6WHu78vzAiFYgeisIHmVswKW92usQ0q2ySlGU0X9CBLqM/fALtdaMVh+gAhYgB7q9u1t7so2oACtxLJBosS7ekOk2Jh+d6RYjl2OwHf2w1UqByGcaO025TsTfJzLjptihC6IKjvgzaKzoQXw2iOojc2rvqnFs1v61NadSW9caRnSjmtDXMi/VK/OM3vSTxlnYSmwCuL5qsquqqaUD43KOpuHOk1zfQZ3qSOMH7X1NduR4eGOqtSiIXrjvwB8GXkJuZHQzS5tCpIPLN3Vip0AXrB3REy1Sq9AW00n1syuY5SiOuqCeUup1tC0clLt4TGVjsDK2jqxcqgSSxv75R0il7BHMpt1t4CC2hmdcJ7JmtvW0NLNRCaj6oFFO06KxZQetob3mD+jE/LMYd7XnzaHd6suVLWZLLfZIMEBZlw6b8ZX1RxjgFX5DYbFFNhUJS9Gs9xDJZXbYd+1XbYdcDE1Gnu7iZ7nt9oz9sBlIhsUZuOxxRZopjF7cwnEVyNJBrAgArdnf37DamBcEyFT1nB2jVaaOgq61eq/Xj5UtcM9+wizSneCo+bB0wgeuUMWuKWeJDAiskAL7ds7Ky7tjOR0Lq5v1A3uCxlAGShoUQW+zgIOQ0g9bGIlHnJFpo2A3OnNvAHcA9OcaMB/l7FRgXuUQPuHQjRuAP60DrGaWinqNae0JTepgVyZntKh9qM1W6jMCnjLWqhSJqoHZ8Aw7MqO0OaeuJzmmbqLZslwLYXcnWW0ChCCQYGJhEmu68K2y9/fnzwlUqeV3GAceyf/8EwWYJ3AETWjR9wiHzxythv4cqReGJs9bbWfMHKvCqZ9S9YBRx+s24vvkm3V51yd3VO60YWffv+1ZO1KjKdZOvzqWrL3p08XlWG/QZwWFnML0Op/AaW8cpHlMXPoRWcHF1hCcLSPBbxMreEkJsUl41AIDBC6r9hq3FodQWRnK686Kl6Jch/pCD81Rs1xHd9a1Us0Dp1KKVmIrLDsib9/TfadWK6Dh8DREoMz9lkEgFuhlo2L0X8MuerUE2UQF0QjgbeX1QtYUevW5Vsi5oSnOpeC01ixTqIKx0lNNgTqbu+DKPS9FqCik4YmxLmIhFVYGhVLOG/RTG9DiEoHfUa/elvRf7xIiDOPGvCaU161s//Fy4bxuGL9FGlGvrzH8HL35+nJCCOcTIfh5csM6ZkFPI5CTNX7xiyb+4582y3g7+KgvNaASDrSsE4rRXEkSxwtP5fGTz0zym6uWgkxgAAwxwcNF2Ead/wVdxeEasnomJTXf3bdILFtXc1NCB1/D9jci2fpOXaFKf5275usFebCtZzgeqpsjqY4j2Qfalh3A9Wy1TeKqlv4k0KQAQipQCU/QtODCBaFnhyArmFas6m82b+NjhfY0+4gSrU6cLkrw/1AQ0vqUifJaLFJOCmIvJSxVmuORV/LVhARBNrSmRIUT7R/D/kuy9sKjTy6l1Zlrt+v1aT6ijlaaCSIsGqBIicMIbOMY7R3zRmBjqDiHXSEgwFIRFRqAWAsxvjOcX6DL+1+uhKfYPiOl5J+VwmNhDHSMPVfa7JRJKwQbK54lNtXiMsBzIZni/9hrRIM+atnjiVvXidSeIOa0yM4acUZJ00nOHq6iCGzRoJi5KmIL8xUXOpWDXQOmlZzcaHhvoeqaUjLgK+6BeyI5MiMCn+ihCvuJYTM/NkrrtYxXadEpGmMru+zpT/k1CaZ1KtWB8KI1VkzTMVgKDCoqbgTobZoSAkgV4mFJYcYrUhLwwzMqRKZ1V3pbPdUXEg0JsEbZl6BoYXZlYoOf/tX40x9aeY2wQqZsAkIVzsg0DsVDMyKLs9/BZgQOfGiHBq+DTlzDnTzUpqk7VzvAJv2g5rCWClM87KYp3VkqKofB5iUhBtoUWVg97mTMKNjpWIjSimGXa+LuUrUVla4/VZWuObsrQGWpLaaspWzLVFa7la9dpfC5ldCZmNwB5WyBpEM4I6D1c7oAsWwTZLf79bAFsmcw5VIa6SJRWcYP/un+BldWjBBhUQi09nuXa92AoSLPMN1JBhEWie518vQ3zJ9CgdxzSRAmPdpTihcOyX+JdmVLmxcafC2GxsVHBf1TDcxEA14krguKhgreASE/ZXyk/A/nqm+a8lUHB/imhRM+Nr7lUG5uF6QiJONNygwrAFllmtWclGIesqbHGTTUjiO83Yr98D0vAJxWs7W2celX3qbgfVRbFDT4+SZHa6mt8Jzd7hEL9YWsJTvGupeFDXKhUFECd5Ix1vpuDr8Tu6D6SFe0KOwL96CUut/1sSD9l53TehdEoIh15aXOKkOwuoVLqQ8NnzvHA1qURzugiofwfq2ypRntoFuIcPFMZSFSDz5bHa5UfZPjczqyFRXqzy44kFUKrGxkXIa54M4G1hi4QQDEwYPriSK49wImiI1MnAI6SAkFk68D4sWmpffFpNcisCDohw3WU1FT+rYGVZbRMNRsaIKGcvNBHBXchwx5KeLi+lcPFfPZtdY6c2JNvLYTL6pa83YpgnAidXbm+9sYGWcAwV+/pNr3ryq5vkxOM4oCn9/D9QmhCsJAS1M+WYdZPuMHsN9WvOaNqVI+h4tl4CBO5hnhFMzGrMaDYDjknO5vYOf6tCFTWS+SgKfTY3mPEpTEB6OorYPBhHJKXGazKhmW1oM3HxhtPik43F5/85k0kPcVpFitLPfwLjnR9mmOU7SSmF2xxSyHZIIvYBU55ARlm4rzX7/M88ZBh6IXiF9xcsPaep80FpXyBv7AyEku9D/nQ+EhO7IV1szVF1Shb0VoJ9Zct+pM0bJq7cWN2wJCIxMx7TGbONSUr4POR/2ebMDB9nDsAL87WNGYYtS54z+fy/cO9ArYWZYElClf/g5/+WQZY01Bghr2eAPGJsbz2qJk6bOeWFroI23Zj7iVMDHNMzSCCHthVijCL2cU4JxDOTdEY+0VhccmrgZayugRxxIPLfytQ4M3R7xBuMHeNglBIJC2XqXWZ8/mefxRTgkfrp538EwTT2w4REQoYv/Vf0vIFlghcV7PTtbVQh8vZrPT1wNTmwSPQsdSLVnMq/WSV/EeKF45AUiKSYPPmv7XO5PqEfE1dH6CfZlWKqKSXH8PM/pCGzRe5nyFfKLEM7Q44h7ynLZO5mYxES44mWU0SOjrF8kLYoDkK4L2nBRD7NQq8Zi3w6+ENkuCxVnWBdAUfhjH4AVg8k1DGTScr+zziUaigZyaPC2zUfysabofQbeURjxCDVpjUnyr7O99/2YwS8gmaKgkfWl74JR/vhq102BYDektWHvYRL6AQ0lwF0tvR6hrif8kyBGmJjw6wwZUNkaD1kbMVta1gkru4QxfJwiweRe0LciSGz/UKuUJVkQlwprK5og9uJi+vocqvKYImYEslPqJvjv4qbKGxi6zwEEmy3xlYvllvxmZBF/lioYVKRK0xzS5IE7d2MGEJVa4M24fjtE4PNRQZwdA6wjc//zZhhE+lZf6OzgJiAuM4dhn+2GuhYjg03rbO5AbdfqFxYDBQJ8vCuGVHZCL8KAtWSfAEGw69MqSc+9DaAjSByaKomloNvzRJgcMgjCG76AsSotH+qo5syD+pRiVRFUEFDiDUGZTRc82IXb8p8uLkFwXNBSibgzI8BdEHK4HZAPSCqcJ1ZmQOVQVuQbpPG/DEdk3nETavoByQ60IXDYr5NSZyNaVrMDOfV/AqVKCjLrMYjb2w8wRHQ4OXT3yPnBzoVIyaLcEI4Szc25JUrDasWMZBFcLuK+k6lL0eEbmNtp5NdOB9QWBDqJ9xm0Pi1cruFl9CnmfMha7nLFm+5LYoZoUu9PtY4Ovm5di0WCFox4CsmLjZNQbcPuYUe7Gx99wjlYGB2jlhAD7jZBdyHhjRMndazyljK5uwpKkUfyElOlkQhBNINBqjhUu92yhA+fGHHcK2kjf+JO6AHAyAa5WVONmQawEUAveEbOjm+TLD5YAA+f/agBWK6JW4eE3ulJcaqxuee9oZt8BK0bPD+O+0N97r7+Ks7dHFwjBjFrIDZrspfUeQGDDENIIZLoHsAXFCNYrv2QE+zzd7QWrJND0rsbNPb6qvESLlY8M3NsgSSK0EJKq+hBcj1++EdzyPA5w5STK0W7sv1wt+mamS5ZiyyajEwWeKvGJe02GKslW1u6jX1V2YKtkv4KdMvmWW8snKXBDhoGAd+3uJiIO1KoDqYxvMZHuZBi6CaWeZIj/F+eTjGEN2FGdDkduoXqlO3i96pIi5A1ehKIK+PrrNC2fVgMO92SbczsWs3aJ7++e/+6e6//eNQvREa9rJzpZLo/M1gYDr3BgPrbseBu0nNWFxIBUsFendxZOx2z0K0BBcNYqgvvCxGs4thKhExsRORjD+LA3r5aqyuceMrxZjWne61exsbfK/d24e8+Hw/1r/UWflCddagsds0FZeKvjp/094fDIJlz76fmzb8up9byy07Lz94v7F93DwWx4lWeh0MnMZ+5Ro2fYcKjEk9RHFPIkZw6evwkVr7bL+duqnbzdWyalfUF5dV6Xo8JwZXbhB+waPyyeMqYADI3O922/j3wXjYADt/Q9qfuu1Hw018Z5Sqsn4d8APKqc9PUHdX3nMWeyLnImaYgrgfcaTAKFC9KxH0YZdhgNwpPKR0rD2N8EpKIN/7xX0D8ooAiNevN04IhOHIhwWLKu3UPQXu2jGbxpBJeVfOO4QjP8WLxt6wC/hucVbbPbtM85cCPRB6SwSeLJTWXRuIbZEnpvaMjwsWzWcUf5Y6dO1RRvijEUj+or7oyad4u+igBRhH/AgT8QricQweyo6Bb5DvZYlYFXvQIllGxURETjv8CWmuQE6UbfxzyfDEbAaJ0/D3Bc47htuRVdJFIMrZbuFbr5K/QqRJH5B1mcH1NJO0sshTdshYRInAR6T03S+y80H/kPqvxN1pAWgUkBRcKF5ckwAZXBUhJEVam/sbG2a46Tk7lh3uAdJjXmjHXlbcqsH2vK392C0u9O667d4KPHAmtCKZru+FZLu8oP9rrpcrE70JTMs3e7/plrqV9BrLvGQdiptxY0zDtozhTpHTeOjRUwa8os3zgqaJ9k+eHbwt7lc7VfYV6XVqD1rfH74WWSSePsG/P7z+g3g+EO8P3om/r5+/HLSGVuEBAijQPLl+cf3k+vD69fXTV88fXx//ZN3thCuopUBiQs45yPD+XnXUmteh5nyhFkDDwVyqDrbvgFVZMQiD1i+4ujGy1YPWr8XT9bVOBpEG/nL4FmlgjOh90Dp8ewQ9Dlq/PP6+8gLu8BVvjt8+3aq8On77FHnGFUgSKOgpi8BBLdNRanmdZBnXyiq3eHALkwlXUrVmDalaY0uuYj3HaGYBH+IxkW4h9vaoGVtI7e3YGqWUnEs24jbtKievaA8LkEJK2bg4YWlucnn1iL0EbOSe6liJziT+EhhraOMdkqcrGG5oI96CNxoCAwUYvkNMhi+bcNrQHlPsdExFnz6D3F5EjAwJdaGOJEhQr6BNgNnBVQreIymBt5KmDO0LEkViTuKX6LvIsjXMJYUsLy6HzETIEph1EC+5EQO7eSusQb9qV9gUbAO39rnbzSEHY3l3Fa4tM+lp7MDPoSWWUo0DxVcJHTbyFHCdJh5BvTqu87B6BOUuNJ/eoo2lNgQ5ZyjGx6FiMS3cD/VyTKn2Ru1C7Mhf+6qefC7rCsvglGSHss2dO0UtOOcVlKp1UPsksa9aPSyo15J7HTvix75WX5TUGsg7SWu3i8pltvppReKjuGVtjn9KDxVA0S9IIi/DfEGSenLbVJdrVeebg9Y1hiaLefWpUy4RuFLBXnF7KXaSii0rlp2qVcK8MLitsoZJIH2xerQgUc+myovbprCLiusNi+mGY1Nk+C9xihq3GJHngGOE3iUzLSuUV7mboRhPjMSF8GGU2A+ugcfMyWFx93thvV67XFRs7sYGYJhU8V1ZgjkTbTjaPg0XonRG0gkEKg9LXEfxDAHn78u7DrA76/ral2uFz6gg9eVyiRrqkm41x/m6OfrlSugZXwH1Um8PKLccWWwD3jOmwdid1RoyfW0hJtcGjGVqZLGTu163niBZ5tiHNFgqLbO1qRXBztvMm9fAY/mRXx3Or9wu2u7lL//K5aJG3scsOYfzqzK9si0yw2BZbM8r4MesvEwLrycsl3Ag1BvltKzdHm33tlY/Rs7T6kfVS/y068HQN6FcSBAehOOJqyXZUpf8odMCL6/1g5UWHwZaG/VBHVXY5M4A1dBvDhmx8s63qIYkxJAOmgIpuGqSlJYpuC07qrJ5v7w9fP/k2fHzxyfeUs52iVZSd9A6KdxRbXVPlgsalqvY/c2CjS43kE8XREkQQIFzXKZi+J90wadhAreUkT5ycWwhcSx6HqyRWGCuEct8/AU3R+CMxM3lxZxeS28EcEKYJZgms5xZT80M5ayabAZt8P7feUq00lpRszhnMH5BUj8kVQEPuLkrfZx56k9JRlXRMLezMNBmf4RzNjrGgsbBmrmvSo1BmIqsZeWT5IqyUC64PwuUgJkS9RYfRLthLq5iL2byWMie69buBhkV+hFjfgLLvL4wULm6zMPcLjxOi7Ex0q55cFVZ8oaiHnJuczkPH14O83xFWJnMaZa9EDf86Ez7ModshvLKnBIjpY18eXkaJYOO95rIzGd3GKIajpfmZFexRnJQtO2T62vzxgYoSSJzjjnU4utr+KXf8hhbcMvJV3VUTkM2BgHnNIXsNQwjjSE/cHG5g1qWU7wpShxBBY3il8QOWZJ+ogH5JM+uyKyNWeeHK2t/yUelvFRefpQ20M/MqN43IFk0LQHPjfIkXl9T1T9APpcZdvCRXw2VN2SNpIQec+C07FMxVBjQoWD/IOtRXMj4IWjHrq9DfU+oyAlgQXG55RYmV/LaBTUjVsnbMOGYvq9mhk9Dy+3ac48V9xjsax+vym78fJwwZFxH8qgIuNu115BxZG/7ESzMpkdsstfd2PDhHzMq6Dqxo5Kgk3u+Zc83Nu5EQOywHiRymlt2KlnSSDGQWSOFTy2N6YDUIEDhH0EYQY2Oi6u2ViLSK/QaXTsVzeYlweYFwebrCTYXeewQLahCuC2ykNSyryTcWd6IcrS+60BNa9snbU+ogTk9aP86XG7Z93PrbkfNafnuxFUannc/ukrJ8/hYsR32kzfFz5fPi5/HJ8XPZ2+Ln6/Ln4daD8/KumXpQVn36KmrtEonUOHk+EcY7ZU7aL18BT8fw8we/wg/X8McUMNkH/0KzX6F0qfv4DaJd08GrfyU74OlDCERE87hxzVo79AVZ90a6pp1qQYXCwZLeUran8RKKrU/it4gYmEMZV64ZYPaBlTh4GdwBeiTl8pKiZGtVQU7IOGTKZXiy7JEZbG4Uad6Z1ShZ431O4Xt+12462azxIzyPabKPB1aa3SUwhBkpja31D1HeA2xaGxPUQH+DC8jht9uaoMrmhtj5EKea3eX5ZpKXOMBNR7OJ5xOWCpob0w5+HuOIYnM0M7WtyrYBWPOBeuGiU+1IrhTQ+drNO2P1Hb7bCb404KySKSd/cJHb9ADBjQ0d+7oW5GWGe3kxi5XhabSGAJN0d4Fuy1XmTc7YRfZTeO9dq+4/y2v3Se9vncJS+wv7aMkNsxq6Ev8aPfg6jIqojCovITbB0sn6LGsQrdd3mp0Cz1Xzc55a3WXuPJpDtOBO3mja+QsrpF76ITicK5AeAMzIfa8onotdp7DzldMqXj9njrkVR1tbb15XW0qL/7WLgS0lCCuM3fgz6EOoKGA57RXo9X9MqVRbnLwS5EXvxvKCm2jQZqmUoCJUZtqydjSSJv7Cprh1Ylypzj6OOMYVGmokxAeK2YMnglgIxV0psSNcvbx6f1h3YBR/T6o0fhlsRbukXgxzsSeeaGZ2BqWGMI96LKsglnkQ4ifbgdFu5oqGa5Ml68Uthla9rQoE99q4y8mxpuol18W/4aWPVK1dVQHkufcT8HfGDLIiImcVPqt4LqqsDSF2+7r41yAB8VlhVmS6Enf0rjc0M2etUoFT2dfxRerY1M0H68oVMt3dTVqX1gNhUr3qlTloqZQQtud1LpoYOnaGLmzhqvjyNVlpRYGB5iUA4gg0yobV+WxuGUXuRzBDW/Q2oxs4SP5M97jLPqcrvQp6rzGbZaVRvVKuVRfCqcctYS+SU9PhhaYTS7VF6vv8ZsmCB85B6+BduZmNkCIG9tIFAV+LHRkHytYLcP1/ailaxJHyQ3Nj+KMVU+XOBWVt9pBQbNCpeXK+cKZ6VVuBG9QluI36C3qpL5C/aHNym2GH3Wg/9gI9AXU8lNQucMH3wj7eFnBDGuLBdAMFann4wv4kCFcrCcecZJiT9nGRrqys3HDzsZqZ3FaYKWx9tvMZWIdU7k6GWwvnJ+jwgvhHBDAMfzzrrLhBDf8XXnWl3LT3t2wadJmo1dqtqZZNtqaKr2tKHUAYdW3CcnNO32b3jVuE0Mqw+VSQFq++QwL6nYkEUkvb3lBvmh5VGqrU2vX6XZ39rtuWnqyKQnTFyOgpayf4U4dy53igEjEYqRwRzHQOjOg6Gp5Lf+y64uQT4OUXJDoOqILEnMRqHGdkCs255akicza2Dhv7Ldgoc/rpiCwA1n2cXPxZa0YQKTN5X23S8kVuKzUjUV24SPqXtigx3aPbNCBupc2Xo3ontvyXkb3OM/BcxO9OpXTpliwn4/fnDx79dIr7ZvtRQ/EuKfHz58DD+50hBNVJwQ+05nyWSQLSJKgkyg+lE6hsmBG4nBMM+5c0JH6rXryWdzuPew6STzRi3Z6W6Jo2M9oNG6OIc44QRWUuFkBIr3fxTyMTJ/4U5rhepnyoyyHT2lc3G4Asc/4WZZ8AV6tOFB2Hia/JyHHq54tvL96zfgQu7IQ2sw1E0Cbfjny6xRM0tQhUWTq9hy4xbuYphTkZA8iDhW0RSsT9aOQwt2DfkSkT+P6qWJUf81PGnRr7948R+vVxznszjyNrP6g9f3xWxmJql7MKJ+yANyY4WbuELI240ig6wCgk8UQWSHj8VHxJXIJFN3ID+DFHEBq8SMWa44e63cO49GTOS/7s9HvM9f9kmVzoSepDwwrfX1dqVKHZQuXET2bm2BWHZclGD8AGYLKorxwS+o53ze/CyBTRJgIhTqoPcp7wAIV0FPEBMggvz/JQD9H9A46xffzNML2K6cw81lC5Sup6s+SiFxhEYh1AYkwEyZQ5hSAhxSTAe4mJZKFLa/aee8z5I7dQeub7pPedu9AkJMpndE17yICp9Ytb1MatOBAgy/e6RJz16jZ108+2JCFy17vYfey97CrecG5cI8imdAOVs7t1Z4KhFHpaae3dbkDaQjX9CSsLglGI0BUcHwFAYPnZAQxB/kQMaU+UYCAUctthT8fvnpz0f3x+wk7ODg4eHnybnr8bnJwcPD8p4ODg6Pu4cGLg4ODx6+3L7NDqPC4d/ji5+Pf78yeJOPsWfLj77//w4fnHyavnxx+/OHDzx+eQJ1pNzr+6ec321vz++Tip9nBi4OLg4snvwbsKNuePHnZHT0LLg4fBxcH2ZOY/fSw8yz6frsTPT86fvdsc0JPyP04efzTx9dvyOOfyId35EP395Pu96z3PXv0hL08/PjyzccXjx/8OHve+25xTmffBZ+++5A9//VDr6jz+uPb4Ono/vSYfOh89/3J08lmdhz92ntxotrX+p72Dn/ZfP3i8GL07uj8+x/gGw6Ooydvz0/mP82Ojoq1k1vzxbWD/x88OxBrd/D9z1n8wy3X7ih6V6xdcHKxdfzi8Kcn3Zf+4cHbF6/Onx09Ozr3j46Tg4uDxWTn2ffdo6PNx37w6/yXmO90t3befrg/Pj8++P//9xf9790PV1t/mHcfxo+7j948/OmqN+8lm2zae5V+9/PbyYt//wm9OPpw/t2z739b28NP7zqv0+9ek84VeXry88WLg4PnHyaP3006j3/6//pOHx1k88uUTa7GUXy02cOywx/evNs5Ts9/mEwmntfK8/8XjTm8+7DdAAA=";
