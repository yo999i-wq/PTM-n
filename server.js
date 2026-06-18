// ============================================================
// SERVER.JS - MRP Browser - Serwer HTTP + REST API
// ============================================================

const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const config = require('./config');
const { queryMaterials, queryMaterialsGlobal, queryMaterialDetail, queryOrdersAC, queryZamPositions, queryProPositions, queryPlanMaterials, queryPlanZlecenieMap, fbQuery, testConnection, detectIndeksColumn, getTableColumns, clearCache, cacheStats } = require('./src/fb-mrp');
const { queryCapacityLoad, queryCapacityOps, readConfig: readCapConfig, writeConfig: writeCapConfig, clearCapacityCache } = require('./src/capacity');
const { searchProdOrders, readQueue: readProdQueue, writeQueue: writeProdQueue, queryOrdersBraki } = require('./src/prodqueue');

const PORT       = process.env.PORT || config.port || 5350;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ── Helpers ──────────────────────────────────────────────────

function jsonResp(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type':  'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function errResp(res, msg, status = 500) {
  jsonResp(res, { error: msg }, status);
}

// ── Kursy walut (NBP, tabela A — kursy średnie, cache 1h) ─────
let _ratesCache = null, _ratesExpires = 0;
async function getRates() {
  const now = Date.now();
  if (_ratesCache && _ratesExpires > now) return _ratesCache;
  const resp = await fetch('https://api.nbp.pl/api/exchangerates/tables/A?format=json', {
    signal: AbortSignal.timeout(8000),
    headers: { 'Accept': 'application/json' },
  });
  if (!resp.ok) throw new Error('NBP HTTP ' + resp.status);
  const data  = await resp.json();
  const table = Array.isArray(data) ? data[0] : null;
  if (!table || !Array.isArray(table.rates)) throw new Error('Brak danych z NBP');
  const want = { EUR: null, USD: null, GBP: null };
  for (const r of table.rates) if (r.code in want) want[r.code] = r.mid;
  _ratesCache   = { source: 'NBP', base: 'PLN', date: table.effectiveDate, rates: want };
  _ratesExpires = now + 60 * 60 * 1000;  // 1h
  return _ratesCache;
}

// Bezpieczny parser query string (obsługuje = w wartościach)
function parseQS(url) {
  const idx = url.indexOf('?');
  if (idx < 0) return {};
  const out = {};
  for (const part of url.slice(idx + 1).split('&')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx >= 0) {
      const k = decodeURIComponent(part.slice(0, eqIdx));
      const v = decodeURIComponent(part.slice(eqIdx + 1).replace(/\+/g, ' '));
      if (k) out[k] = v;
    }
  }
  return out;
}

// ── HTTP Server ──────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];
  const qs      = parseQS(req.url);
  const method  = req.method;

  // ── CORS preflight ──
  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET' });
    res.end();
    return;
  }

  // ── Static files ────
  const staticFile = urlPath === '/' ? 'index.html' :
                     /^\/[\w.-]+\.html$/.test(urlPath) ? urlPath.slice(1) : null;
  if (staticFile) {
    const f = path.join(PUBLIC_DIR, staticFile);
    if (fs.existsSync(f)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(fs.readFileSync(f, 'utf8'));
    } else {
      errResp(res, staticFile + ' not found', 404);
    }
    return;
  }

  // ── API: Materiały ──────────────────────────────────────────
  if (urlPath === '/api/materials') {
    try {
      // Tryb globalny: filtruj po terminie, bez filtra zlecenia
      if (qs.global === '1') {
        const data = await queryMaterialsGlobal({
          date:   (qs.date   || '').trim(),
          search: (qs.search || '').trim(),
        });
        jsonResp(res, { ok: true, count: data.length, rows: data });
        return;
      }
      const data = await queryMaterials({
        kat:    (qs.kat    || '').trim().toUpperCase(),
        rok:    (qs.rok    || '').trim(),
        symb:   (qs.symb   || '').trim(),
        lp:     (qs.lp     || '').trim(),
        date:   (qs.date   || '').trim(),
        search: (qs.search || '').trim(),
      });
      jsonResp(res, { ok: true, count: data.length, rows: data });
    } catch (err) {
      console.error('[API] /api/materials error:', err.message);
      errResp(res, err.message);
    }
    return;
  }

  // ── API: Szczegóły materiału ────────────────────────────────
  if (urlPath === '/api/detail') {
    const indeks   = (qs.indeks   || '').trim();
    const kodLokal = (qs.kodLokal || '01').trim();
    if (!indeks) { errResp(res, 'Brak parametru indeks', 400); return; }
    try {
      const data = await queryMaterialDetail(indeks, kodLokal);
      const w = data.filter(r => r.wartosc != null).map(r => `${r.rodzaj}:${r.wartosc}`);
      const wal = data.filter(r => r.waluta).map(r => `${r.rodzaj}:${r.waluta}`);
      console.log(`[API] detail ${indeks}: wartosc=[${w.slice(0,3)}] waluta=[${wal.slice(0,3)}]`);
      jsonResp(res, { ok: true, count: data.length, rows: data });
    } catch (err) {
      console.error('[API] /api/detail error:', err.message);
      errResp(res, err.message);
    }
    return;
  }

  // ── API: Autocomplete zleceń ────────────────────────────────
  // GET /api/orders?q=00401  (szukaj po symbolu zlecenia)
  if (urlPath === '/api/orders') {
    try {
      const data = await queryOrdersAC(qs.q || '');
      jsonResp(res, { ok: true, rows: data });
    } catch (err) {
      errResp(res, err.message);
    }
    return;
  }

  // ── API: Diagnostyka materiału ────────────────────────────
  // GET /api/debug?indeks=DDRAALDP1X2002
  if (urlPath === '/api/debug' && method === 'GET') {
    try {
      const indeks = qs.indeks;
      if (!indeks) { errResp(res, 'Brak indeksu', 400); return; }
      const ind = indeks.trim();

      // 1. Karta materiałowa
      const [karta] = await Promise.all([
        fbQuery(`SELECT TRIM(W.INDEKS) AS INDEKS, TRIM(W.NAZWA) AS NAZWA, TRIM(W.JM) AS JM,
                        TRIM(W.WALUTA) AS WALUTA, W.CENA_KOSZT,
                        M.CENA_ZAK1, M.CENA_ZAK2
                 FROM M_KIMWSP W LEFT JOIN M_KIMMAG M ON TRIM(M.INDEKS)=TRIM(W.INDEKS)
                 WHERE TRIM(W.INDEKS)=?`, [ind], 5000)
      ]);

      // 2. Pozycje ZAM (M_ZAMWLASNEPOZ)
      const zamPoz = await fbQuery(
        `SELECT FIRST 20
           TRIM(p.KATEGORIA)||'-'||p.ROK_ZAM||'-'||TRIM(p.SYMBOL_ZAM)||'-'||LPAD(CAST(p.LP_ZAM AS VARCHAR(3)),3,'0') AS NR_ZAM,
           p.LP_ZAM, p.ILOSC, p.CENA_ZAM, p.ILOSC*p.CENA_ZAM AS WARTOSC_ZAM,
           TRIM(p.JM) AS JM,
           CAST(p.TERMIN AS DATE) AS TERMIN
         FROM M_ZAMWLASNEPOZ p
         WHERE TRIM(p.INDEKS)=?
         ORDER BY p.ROK_ZAM DESC, p.LP_ZAM`, [ind], 10000);

      // 3. Wiersze MRP (M_KSM_MRP) - ZAM
      const mrpZam = await fbQuery(
        `SELECT FIRST 20
           TRIM(S.DOKUMENT) AS DOKUMENT, S.RAZEM, S.PRZYCHOD, S.ROZCHOD,
           CAST(S.TERMIN AS DATE) AS TERMIN
         FROM M_KSM_MRP S
         WHERE TRIM(S.INDEKS)=? AND S.RODZAJ='W'
         ORDER BY S.TERMIN DESC`, [ind], 10000);

      // 4. Wiersze MRP (M_KSM_MRP) - PRO
      const mrpPro = await fbQuery(
        `SELECT FIRST 20
           TRIM(S.DOKUMENT) AS DOKUMENT, S.RAZEM, S.PRZYCHOD, S.ROZCHOD,
           CAST(S.TERMIN AS DATE) AS TERMIN
         FROM M_KSM_MRP S
         WHERE TRIM(S.INDEKS)=? AND S.RODZAJ='R'
         ORDER BY S.TERMIN DESC`, [ind], 10000);

      // 5. SP szczegółów (MP_KSMMRP_SZCZLOK) - pierwsze 20
      const sp = await fbQuery(
        `SELECT FIRST 20
           C.RODZAJ, TRIM(C.DOKUMENT) AS DOKUMENT, C.ILOSC, C.ILOSC_R,
           CAST(C.TERMIN AS DATE) AS TERMIN, C.CENA, C.PRZYCH_NP
         FROM MP_KSMMRP_SZCZLOK(?, '01') C
         ORDER BY C.LP`, [ind], 30000);

      jsonResp(res, { ok: true, indeks: ind, karta, zamPoz, mrpZam, mrpPro, sp });
    } catch(err) {
      console.error('[API] /api/debug error:', err.message);
      errResp(res, err.message);
    }
    return;
  }

  // ── API: Lista zleceń (autocomplete) ─────────────────────────────
  // GET /api/orders?kat=PRO&rok=2026[&q=szukaj]
  if (urlPath === '/api/orders' && method === 'GET') {
    try {
      const kat = q.get('kat') || 'PRO';
      const rok = parseInt(q.get('rok')) || new Date().getFullYear();
      const search = (q.get('q') || '').trim().toUpperCase();
      const { fbQuery } = require('./src/fb-mrp');
      const searchCond = search ? `AND (TRIM(Z.SYMBOL_ZAM) STARTING WITH ? OR UPPER(TRIM(Z.NAZWA)) CONTAINING ?)` : '';
      const params = search ? [kat, rok, search, search] : [kat, rok];
      const rows = await fbQuery(
        `SELECT FIRST 100
           TRIM(Z.SYMBOL_ZAM) AS SYMB,
           TRIM(Z.NAZWA)      AS NAZWA,
           Z.LP_ZAM           AS LP
         FROM M_ZLECENIA Z
         WHERE TRIM(Z.KATEGORIA) = ? AND Z.ROK_ZAM = ?
           ${searchCond}
         ORDER BY Z.SYMBOL_ZAM`,
        params, 10000
      );
      // Grupuj po SYMB (może być wiele LP dla jednego zlecenia)
      const map = new Map();
      for (const r of rows) {
        const symb = String(r.SYMB||'').trim();
        if (!map.has(symb)) map.set(symb, { symb, nazwa: String(r.NAZWA||'').trim() });
      }
      jsonResp(res, { ok: true, rows: [...map.values()] });
    } catch(err) {
      errResp(res, err.message);
    }
    return;
  }

  // ── API: Pozycje PRO dla eksportu ────────────────────────────
  if (urlPath === '/api/pro-positions' && method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { kat, rok, symb, indeksy } = JSON.parse(body);
        if (!indeksy || !indeksy.length) { errResp(res, 'Brak indeksów', 400); return; }
        const data = await queryProPositions({ kat, rok, symb, indeksy });
        jsonResp(res, { ok: true, count: data.length, rows: data });
      } catch (err) {
        console.error('[API] /api/pro-positions error:', err.message);
        errResp(res, err.message);
      }
    });
    return;
  }

  // ── API: Pozycje ZAM dla eksportu ────────────────────────────
  // POST /api/zam-positions  body: {kat,rok,symb,indeksy:[...]}
  if (urlPath === '/api/zam-positions' && method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    // Timeout — jeśli zapytanie trwa dłużej niż 45s, zwroć błąd
    const abort = setTimeout(() => {
      console.error('[API] /api/zam-positions TIMEOUT');
      try { errResp(res, 'Timeout zapytania ZAM (>45s)', 504); } catch(_) {}
    }, 45000);
    req.on('end', async () => {
      try {
        const { kat, rok, symb, indeksy } = JSON.parse(body);
        if (!indeksy || !indeksy.length) { errResp(res, 'Brak indeksów', 400); return; }
        const data = await queryZamPositions({ kat, rok, symb, indeksy });
        clearTimeout(abort);
        jsonResp(res, { ok: true, count: data.length, rows: data });
      } catch (err) {
        clearTimeout(abort);
        console.error('[API] /api/zam-positions error:', err.message);
        errResp(res, err.message);
      }
    });
    return;
  }

  // ── API: Mapa zlecenie → materiały (widok zleceń) ──────────
  // POST /api/plan-zlecenia-map  body: {zlecenia:[{kat,rok,symb}]}
  if (urlPath === '/api/plan-zlecenia-map' && method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    const abort = setTimeout(() => {
      try { errResp(res, 'Timeout (>90s)', 504); } catch(_) {}
    }, 90000);
    req.on('end', async () => {
      try {
        const { zlecenia } = JSON.parse(body);
        if (!zlecenia || !zlecenia.length) { clearTimeout(abort); errResp(res, 'Brak zleceń', 400); return; }
        const map = await queryPlanZlecenieMap(zlecenia);
        clearTimeout(abort);
        const total = Object.values(map).reduce((s, v) => s + v.length, 0);
        console.log(`[API] plan-zlecenia-map: ${Object.keys(map).length} zleceń, ${total} pozycji`);
        jsonResp(res, { ok: true, count: Object.keys(map).length, map });
      } catch(err) {
        clearTimeout(abort);
        console.error('[API] /api/plan-zlecenia-map error:', err.message);
        errResp(res, err.message);
      }
    });
    return;
  }

  // ── API: Raport materiałowy dla harm-full ──────────────────
  // POST /api/plan-material-report  body: {zlecenia:[{kat,rok,symb}], week?, year?}
  if (urlPath === '/api/plan-material-report' && method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    const abort = setTimeout(() => {
      console.error('[API] /api/plan-material-report TIMEOUT');
      try { errResp(res, 'Timeout (>120s)', 504); } catch(_) {}
    }, 120000);
    req.on('end', async () => {
      try {
        const { zlecenia, week, year } = JSON.parse(body);
        if (!zlecenia || !zlecenia.length) { clearTimeout(abort); errResp(res, 'Brak zleceń', 400); return; }
        const data = await queryPlanMaterials(zlecenia);
        clearTimeout(abort);
        const braki   = data.filter(r => r.brakuje < 0).length;
        const ok      = data.filter(r => r.brakuje >= 0).length;
        console.log(`[API] plan-material-report: ${data.length} mat, ${braki} braków, ${ok} OK`);
        jsonResp(res, { ok: true, count: data.length, braki, week: week||null, year: year||null, rows: data });
      } catch(err) {
        clearTimeout(abort);
        console.error('[API] /api/plan-material-report error:', err.message);
        errResp(res, err.message);
      }
    });
    return;
  }

  // ── API: Schema tabeli ─────────────────────────────────
  // GET /api/schema?table=M_PRZEWOD_SK
  if (urlPath === '/api/schema') {
    const tableName = (qs.table || '').trim().toUpperCase();
    if (!tableName) { errResp(res, 'Brak parametru table', 400); return; }
    try {
      const cols = await getTableColumns(tableName);
      jsonResp(res, { ok: true, table: tableName, columns: cols });
    } catch (err) {
      errResp(res, err.message);
    }
    return;
  }

  // ── API: Cache — czyszczenie i statystyki ───────────────────
  // POST /api/cache/clear[?prefix=materials]  → wymuś odświeżenie z bazy
  // GET  /api/cache/stats                      → ile wpisów w cache
  if (urlPath === '/api/cache/clear' && (method === 'POST' || method === 'GET')) {
    const n = clearCache(qs.prefix || null);
    jsonResp(res, { ok: true, cleared: n });
    return;
  }
  if (urlPath === '/api/cache/stats') {
    jsonResp(res, { ok: true, ...cacheStats() });
    return;
  }

  // ── API: Test połączenia ─────────────────────────────────────
  if (urlPath === '/api/test') {
    try {
      const result = await testConnection();
      jsonResp(res, result);
    } catch (err) {
      errResp(res, err.message);
    }
    return;
  }

  // ── API: Kursy walut (NBP) ───────────────────────────────────
  if (urlPath === '/api/rates') {
    try {
      jsonResp(res, { ok: true, ...(await getRates()) });
    } catch (err) {
      console.error('[API] /api/rates error:', err.message);
      errResp(res, err.message, 502);
    }
    return;
  }

  // ── API: Wersja / info ───────────────────────────────────────
  if (urlPath === '/api/info') {
    jsonResp(res, {
      name:    'MRP Browser',
      version: '1.0.0',
      port:    PORT,
      fbHost:  config.firebird?.host,
      fbDb:    config.firebird?.database,
    });
    return;
  }

  // ── API: Capacity — konfiguracja gniazd + kalendarz ─────────
  // GET  /api/capacity/config   → odczyt konfiguracji
  // POST /api/capacity/config   → zapis (body = pełna konfiguracja JSON)
  if (urlPath === '/api/capacity/config' && method === 'GET') {
    try { jsonResp(res, { ok: true, config: readCapConfig() }); }
    catch (err) { errResp(res, err.message); }
    return;
  }
  if (urlPath === '/api/capacity/config' && method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        writeCapConfig(JSON.parse(body));
        clearCapacityCache();
        jsonResp(res, { ok: true });
      } catch (err) {
        console.error('[API] /api/capacity/config error:', err.message);
        errResp(res, err.message, 400);
      }
    });
    return;
  }

  // ── API: Capacity — obciążenie [h] per gniazdo × tydzień ─────
  // GET /api/capacity?weeks=12
  if (urlPath === '/api/capacity' && method === 'GET') {
    try {
      jsonResp(res, await queryCapacityLoad(qs.weeks || 12));
    } catch (err) {
      console.error('[API] /api/capacity error:', err.message);
      errResp(res, err.message);
    }
    return;
  }

  // ── API: Capacity — operacje gniazda w tygodniu (drill-down) ─
  // GET /api/capacity/ops?gniazdo=SPAW&week=2026-W27
  if (urlPath === '/api/capacity/ops' && method === 'GET') {
    try {
      jsonResp(res, await queryCapacityOps((qs.gniazdo || '').trim(), (qs.week || '').trim()));
    } catch (err) {
      console.error('[API] /api/capacity/ops error:', err.message);
      errResp(res, err.message, 400);
    }
    return;
  }

  // ── API: Priorytety produkcji — wyszukiwarka zleceń „W produkcji" ──
  // GET /api/prod-orders?q=00504  (lub PRO-2024-00504, lub nazwa)
  if (urlPath === '/api/prod-orders' && method === 'GET') {
    try {
      const rows = await searchProdOrders(qs.q || '');
      jsonResp(res, { ok: true, count: rows.length, rows });
    } catch (err) {
      console.error('[API] /api/prod-orders error:', err.message);
      errResp(res, err.message);
    }
    return;
  }

  // ── API: Priorytety produkcji — kolejka (lokalny zapis) ──────
  // GET  /api/prod-queue   → odczyt
  // POST /api/prod-queue   → zapis (body = { items:[...] })
  if (urlPath === '/api/prod-queue' && method === 'GET') {
    try { jsonResp(res, { ok: true, ...readProdQueue() }); }
    catch (err) { errResp(res, err.message); }
    return;
  }
  if (urlPath === '/api/prod-queue' && method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const n = writeProdQueue(JSON.parse(body));
        jsonResp(res, { ok: true, count: n });
      } catch (err) {
        console.error('[API] /api/prod-queue error:', err.message);
        errResp(res, err.message, 400);
      }
    });
    return;
  }

  // ── API: Wartość braków materiałowych per zlecenie ──────────
  // POST /api/order-braki  body: { orders:[{kat,rok,symb}] }  → { braki:{ nr:{brakiPln,poz} } }
  if (urlPath === '/api/order-braki' && method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    const abort = setTimeout(() => { try { errResp(res, 'Timeout braków (>120s)', 504); } catch(_) {} }, 120000);
    req.on('end', async () => {
      try {
        const { orders } = JSON.parse(body);
        if (!orders || !orders.length) { clearTimeout(abort); jsonResp(res, { ok: true, braki: {} }); return; }
        let rates = {};
        try { rates = (await getRates()).rates || {}; } catch(_) {}   // NBP — gdy padnie, liczymy tylko PLN
        const braki = await queryOrdersBraki(orders, rates);
        clearTimeout(abort);
        jsonResp(res, { ok: true, braki });
      } catch (err) {
        clearTimeout(abort);
        console.error('[API] /api/order-braki error:', err.message);
        errResp(res, err.message);
      }
    });
    return;
  }

  // ── 404 ─────────────────────────────────────────────────────
  res.writeHead(302, { Location: '/' });
  res.end();
});

// ── Start ────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', () => {
  const ifaces = os.networkInterfaces();
  let localIP  = 'localhost';
  for (const iface of Object.values(ifaces)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) { localIP = addr.address; break; }
    }
  }

  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║          MRP Browser — Europa Systems                ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  Lokalnie:  http://localhost:${PORT}                  ║`);
  console.log(`║  Sieć:      http://${localIP}:${PORT}           ║`);
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log('║  GET /                   → przeglądarka MRP          ║');
  console.log('║  GET /api/materials      → lista materiałów          ║');
  console.log('║  GET /api/detail         → szczegóły materiału       ║');
  console.log('║  GET /api/orders?q=      → autocomplete zleceń       ║');
  console.log('║  GET /api/test           → test połączenia FB        ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');
  console.log('Przykłady:');
  console.log('  /api/materials?kat=PRO&rok=2024&symb=00401');
  console.log('  /api/materials?search=BLACHA');
  console.log('  /api/detail?indeks=MBLE2303000001&kodLokal=01');
  console.log('');

  // Sprawdź połączenie i wykryj schemat przy starcie
  testConnection().then(r => {
    if (r.ok) {
      console.log('[FB] ✅ Połączenie z Firebird OK');
      // Wykryj kolumnę INDEKS w M_PRZEWOD_SK (raz, cache'owane)
      detectIndeksColumn().then(col => {
        if (col && col !== '__NOT_FOUND__') {
          console.log(`[FB] ✅ M_PRZEWOD_SK.${col} — filtr po zleceniu aktywny`);
        } else {
          console.warn('[FB] ⚠️  Filtr po zleceniu wyłączony — sprawdź: http://localhost:' + PORT + '/api/schema?table=M_PRZEWOD_SK');
        }
      });
    } else {
      console.error('[FB] ❌ Błąd połączenia:', r.error);
    }
  });
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[BŁĄD] Port ${PORT} zajęty. Zmień port w config.js\n`);
  } else {
    console.error('[BŁĄD]', err.message);
  }
  process.exit(1);
});
