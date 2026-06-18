// ============================================================
// FB-MRP.JS - Zapytania Firebird dla MRP Browser
// Wersja z connection pool + równoległe zapytania (Promise.all)
// ============================================================

const Firebird = require('node-firebird');
const config   = require('../config');

let _iconv = null;
try { _iconv = require('iconv-lite'); } catch(e) {
  console.warn('[MRP] iconv-lite niedostępny — polskie znaki mogą być błędne');
}

// ── Connection pool (6 połączeń równoległych) ────────────────

let _pool = null;

function getPool() {
  if (_pool) return _pool;
  const fb = config.firebird || {};
  _pool = Firebird.pool(6, {
    host:           fb.host     || '192.168.0.101',
    port:           fb.port     || 3050,
    database:       fb.database || 'EUROPA',
    user:           fb.user     || 'PBI',
    password:       fb.password || 'POWERBI',
    lowercase_keys: false,
    encoding:       'UTF8',
  });
  return _pool;
}

function fbQuery(sql, params, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const pool = getPool();
    let settled = false, db = null;
    const release = () => { if (db) { const d = db; db = null; try { d.detach(); } catch(_) {} } };
    const settle = (err, rows) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      release();                                   // zawsze oddaj połączenie do puli
      if (err) reject(err); else resolve(rows || []);
    };
    const timer = setTimeout(() => settle(new Error(`[FB] Timeout zapytania po ${timeoutMs/1000}s`)), timeoutMs);
    pool.get((err, conn) => {
      if (err) { settle(new Error(`[FB] Błąd połączenia z poola: ${err.message}`)); return; }
      // Jeśli zapytanie już padło na timeout (pula była zakorkowana) — oddaj połączenie i nie odpalaj zapytania.
      if (settled) { try { conn.detach(); } catch(_) {} return; }
      db = conn;
      db.query(sql, params || [], (err2, rows) => {
        if (err2) { settle(new Error(`[FB] Błąd zapytania: ${err2.message}`)); return; }
        settle(null, rows);
      });
    });
  });
}

// ── Cache wyników (in-memory, TTL) ───────────────────────────
// Buforuje wyniki zapytań Firebird w pamięci serwera. Po wygaśnięciu TTL
// wpis jest odrzucany i przy kolejnym żądaniu nadpisywany świeżymi danymi.
// Współdzielony między wszystkimi klientami (cache po stronie serwera).

const CACHE_TTL = (config.cacheTtlSec || 300) * 1000;  // domyślnie 5 min
const _cache = new Map();  // key -> { data, expires }

// Periodyczne sprzątanie wygasłych wpisów (co 1 min), by Map nie puchła
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _cache) if (v.expires <= now) _cache.delete(k);
}, 60000).unref?.();

// Pojedynczy "in-flight" lock — jeśli to samo zapytanie już leci, kolejne
// żądania czekają na ten sam wynik zamiast dublować obciążenie Firebird.
const _inflight = new Map();  // key -> Promise

function _cacheStableKey(obj) {
  // Stabilny klucz niezależny od kolejności pól (sortuje klucze)
  return JSON.stringify(obj, (k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.keys(v).sort().reduce((o, kk) => { o[kk] = v[kk]; return o; }, {});
    }
    return v;
  });
}

async function withCache(prefix, argObj, fn, ttl = CACHE_TTL) {
  const key = prefix + '|' + _cacheStableKey(argObj);
  const now = Date.now();

  const hit = _cache.get(key);
  if (hit && hit.expires > now) {
    const ageS = Math.round((now - (hit.expires - ttl)) / 1000);
    console.log(`[CACHE] HIT ${prefix} (wiek ${ageS}s)`);
    return hit.data;
  }

  // Jeśli identyczne zapytanie już trwa — dołącz się do niego
  if (_inflight.has(key)) {
    console.log(`[CACHE] WAIT ${prefix} (in-flight)`);
    return _inflight.get(key);
  }

  console.log(`[CACHE] MISS ${prefix} — pobieram z Firebird`);
  const p = (async () => {
    try {
      const data = await fn();
      _cache.set(key, { data, expires: Date.now() + ttl });
      return data;
    } finally {
      _inflight.delete(key);
    }
  })();
  _inflight.set(key, p);
  return p;
}

// Ręczne czyszczenie cache (np. przycisk "Odśwież z bazy")
// prefix opcjonalny — czyści tylko wpisy zaczynające się od prefixu
function clearCache(prefix) {
  if (!prefix) {
    const n = _cache.size;
    _cache.clear();
    console.log(`[CACHE] Wyczyszczono cały cache (${n} wpisów)`);
    return n;
  }
  let n = 0;
  for (const k of _cache.keys()) if (k.startsWith(prefix)) { _cache.delete(k); n++; }
  console.log(`[CACHE] Wyczyszczono ${n} wpisów (prefix=${prefix})`);
  return n;
}

function cacheStats() {
  const now = Date.now();
  let live = 0, stale = 0;
  for (const v of _cache.values()) (v.expires > now ? live++ : stale++);
  return { total: _cache.size, live, stale, ttlSec: CACHE_TTL / 1000 };
}

// ── Helpers ──────────────────────────────────────────────────

function decodeWin1250(v) {
  if (v == null) return v;
  if (Buffer.isBuffer(v)) return _iconv ? _iconv.decode(v, 'win1250') : v.toString('binary');
  if (typeof v !== 'string') return v;
  let needsFix = false;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c > 0x00FF) return v;
    if (c >= 0x0080) { needsFix = true; break; }
  }
  if (!needsFix || !_iconv) return v;
  try { return _iconv.decode(Buffer.from(v, 'binary'), 'win1250'); } catch(e) { return v; }
}

function trim(v) {
  if (v == null) return '';
  if (Buffer.isBuffer(v)) return decodeWin1250(v).trim();
  return decodeWin1250(String(v)).trim();
}

function num(v) {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return isNaN(n) ? null : Math.round(n * 10000) / 10000;
}

function toDateStr(v) {
  if (!v) return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    const pad = n => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${pad(v.getMonth()+1)}-${pad(v.getDate())}`;
  }
  return String(v).trim().slice(0, 10);
}

// Pełny znacznik czasu "YYYY-MM-DD HH:MM:SS" (UTC = wartość zapisana w bazie Rekord)
function toDateTimeStr(v) {
  if (!v) return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return v.toISOString().slice(0, 19).replace('T', ' ');
  }
  return String(v).trim().slice(0, 19).replace('T', ' ');
}

// ── Wykrycie kolumn M_PRZEWOD_SK ─────────────────────────────

let _colIndeksSk = null;
let _colNNettoSk = null;

async function detectIndeksColumn() {
  if (_colIndeksSk) return _colIndeksSk;
  const sql = `SELECT TRIM(F.RDB$FIELD_NAME) AS COL_NAME FROM RDB$RELATION_FIELDS F WHERE F.RDB$RELATION_NAME='M_PRZEWOD_SK' ORDER BY F.RDB$FIELD_POSITION`;
  let cols = [];
  try {
    const rows = await fbQuery(sql, [], 10000);
    cols = rows.map(r => trim(r.COL_NAME).toUpperCase());
    console.log('[MRP] M_PRZEWOD_SK kolumny:', cols.join(', '));
  } catch(err) { console.warn('[MRP] Nie można pobrać schematu M_PRZEWOD_SK:', err.message); }

  if (!_colNNettoSk) {
    const found = ['N_NETTO','ILOSC_N','ILOSC_NETTO','IL_NETTO','NETTO','ILOSC'].find(c => cols.includes(c));
    _colNNettoSk = found || 'ILOSC';
    console.log(`[MRP] Wykryta kolumna ilości netto w M_PRZEWOD_SK: ${_colNNettoSk}`);
  }

  const found = ['IND_SUR','INDEKS','INDEKS_SK','IND_SKLAD','INDEKS_MAT','IND_MAT','IND','SYMBOL_IND'].find(c => cols.includes(c));
  if (found) {
    console.log(`[MRP] Wykryta kolumna materiału w M_PRZEWOD_SK: ${found}`);
    _colIndeksSk = found;
    return found;
  }
  console.warn('[MRP] Nie znaleziono kolumny INDEKS w M_PRZEWOD_SK.');
  _colIndeksSk = '__NOT_FOUND__';
  return '__NOT_FOUND__';
}

function getIndeksColName() {
  if (config.filterColumn && config.filterColumn.mprzevodSk) return config.filterColumn.mprzevodSk;
  return _colIndeksSk || null;
}

async function detectNNettoColumn(cols) {
  if (_colNNettoSk) return _colNNettoSk;
  const found = ['N_NETTO','ILOSC_N','ILOSC_NETTO','IL_NETTO','NETTO','ILOSC'].find(c => cols.includes(c));
  _colNNettoSk = found || 'ILOSC';
  return _colNNettoSk;
}

// ── Korpus cen referencyjnych + estymata wg podobieństwa ─────
// Materiały, które MAJĄ aktualną cenę z własnych zamówień (CENA_ZAM>0), służą
// jako baza do oszacowania ceny dla materiałów bez żadnej ceny. Estymata jest
// oznaczana flagą „!" — to wartość kalkulowana, nie twarda.

let _priceCorpus = null;            // Map<indeks, { cena, waluta }>
let _priceCorpusExpires = 0;
let _priceCorpusInflight = null;
const PRICE_CORPUS_TTL = 30 * 60 * 1000;  // 30 min — ceny zmieniają się wolno

async function getPriceCorpus() {
  const now = Date.now();
  if (_priceCorpus && _priceCorpusExpires > now) return _priceCorpus;
  if (_priceCorpusInflight) return _priceCorpusInflight;
  _priceCorpusInflight = (async () => {
    try {
      // Cena jednostkowa per indeks+waluta = SUM(ILOSC*CENA_ZAM)/SUM(ILOSC) z pozycji
      // zamówień własnych; waluta z nagłówka M_ZAMWLASNE. Grupujemy po SUROWYM indeksie
      // (bez TRIM w GROUP BY) i BEZ joinu do kartoteki — to ~1s zamiast ~40s.
      const rows = await fbQuery(`
        SELECT p.INDEKS AS INDEKS, wl.WALUTA AS WALUTA,
               SUM(p.ILOSC*p.CENA_ZAM) AS WART, SUM(p.ILOSC) AS ILZ
        FROM M_ZAMWLASNEPOZ p
        JOIN M_ZAMWLASNE wl ON wl.KATEGORIA=p.KATEGORIA AND wl.ROK_ZAM=p.ROK_ZAM AND wl.SYMBOL_ZAM=p.SYMBOL_ZAM
        WHERE p.CENA_ZAM>0
        GROUP BY p.INDEKS, wl.WALUTA
      `, [], 120000);
      // Per indeks wybierz dominującą walutę (największa zamówiona ilość)
      const byIdx = new Map();
      for (const r of rows) {
        const idx = trim(r.INDEKS); if (!idx) continue;
        const ilz = Math.abs(num(r.ILZ) || 0), wart = num(r.WART) || 0;
        if (!ilz || !wart) continue;
        const ex = byIdx.get(idx);
        if (!ex || ilz > ex.ilz) byIdx.set(idx, { ilz, cena: wart / ilz, waluta: trim(r.WALUTA) || 'PLN' });
      }
      const corpus = new Map();
      for (const [idx, v] of byIdx) corpus.set(idx, { cena: v.cena, waluta: v.waluta });
      _priceCorpus = corpus;
      _priceCorpusExpires = Date.now() + PRICE_CORPUS_TTL;
      console.log(`[MRP] Korpus cen: ${corpus.size} indeksów (TTL ${PRICE_CORPUS_TTL/60000}min)`);
      return corpus;
    } finally { _priceCorpusInflight = null; }
  })();
  return _priceCorpusInflight;
}

// ── Korpus PZ (przyjęć zewnętrznych): cena + lead time ───────
// Per indeks: CENA_EWID (PLN) z NAJNOWSZEGO PZ + ŚREDNI lead time
// (data PZ − data wystawienia zamówienia, wg NA_ZAMOW → M_ZAMWLASNE.DATA_WYSTAW).
// Źródło: M_OBROTYLP (bieżące) + M_OBROTYLP_ARCH (archiwum). Cache 30 min.
let _pzCorpus = null, _pzCorpusExpires = 0, _pzCorpusInflight = null;
async function getLastPzCorpus() {
  const now = Date.now();
  if (_pzCorpus && _pzCorpusExpires > now) return _pzCorpus;
  if (_pzCorpusInflight) return _pzCorpusInflight;
  _pzCorpusInflight = (async () => {
    try {
      // Mapa dat wystawienia zamówień: 'KAT|ROK|SYMBOL' -> timestamp
      const orderDate = new Map();
      try {
        const od = await fbQuery(`SELECT TRIM(KATEGORIA) AS K, ROK_ZAM AS R, TRIM(SYMBOL_ZAM) AS S, DATA_WYSTAW AS DW FROM M_ZAMWLASNE WHERE DATA_WYSTAW IS NOT NULL`, [], 60000);
        for (const o of od) { const dw = o.DW ? new Date(o.DW).getTime() : 0; if (dw) orderDate.set(`${trim(o.K)}|${o.R}|${trim(o.S)}`, dw); }
      } catch(e) { console.warn('[MRP] order dates err:', e.message); }

      const byIdx = new Map();  // indeks -> { cena, priceDate, leadSum, leadN }
      for (const tab of ['M_OBROTYLP', 'M_OBROTYLP_ARCH']) {
        let rows = [];
        try {
          rows = await fbQuery(`SELECT INDEKS, CENA_EWID AS C, DATA_DOKUM AS D, TRIM(NA_ZAMOW) AS NZ FROM ${tab} WHERE DOKUMENT STARTING WITH 'PZ' AND DATA_DOKUM IS NOT NULL`, [], 120000);
        } catch(e) { console.warn(`[MRP] PZ corpus ${tab} err:`, e.message); }
        for (const r of rows) {
          const idx = trim(r.INDEKS); if (!idx) continue;
          const d = r.D ? new Date(r.D).getTime() : 0;
          let e = byIdx.get(idx);
          if (!e) { e = { cena: null, priceDate: 0, leadMax: null }; byIdx.set(idx, e); }
          const c = Number(r.C);
          if (c > 0 && d >= e.priceDate) { e.cena = c; e.priceDate = d; }   // cena z najnowszego PZ
          const nz = r.NZ ? String(r.NZ).trim() : '';
          if (nz.length >= 11 && d) {
            const dw = orderDate.get(`${nz.slice(0,3)}|${parseInt(nz.slice(3,7))}|${nz.slice(7,-3)}`);
            if (dw) { const days = Math.round((d - dw) / 86400000); if (days >= 0 && days <= 365 && (e.leadMax == null || days > e.leadMax)) e.leadMax = days; }  // najdłuższy lead time
          }
        }
      }
      const corpus = new Map();
      for (const [idx, v] of byIdx) {
        const cena = v.cena > 0 ? v.cena : null;
        const leadDays = v.leadMax;   // najdłuższy zaobserwowany lead time (dni)
        if (cena != null || leadDays != null) corpus.set(idx, { cena, waluta: 'PLN', leadDays });
      }
      _pzCorpus = corpus;
      _pzCorpusExpires = Date.now() + PRICE_CORPUS_TTL;
      console.log(`[MRP] Korpus PZ: ${corpus.size} indeksów (cena + lead time)`);
      return corpus;
    } finally { _pzCorpusInflight = null; }
  })();
  return _pzCorpusInflight;
}

// Normalizacja nazwy → tokeny (słowa) i liczby (wymiary)
function _normName(s) {
  return String(s || '').toLowerCase()
    .replace(/,/g, '.')                         // 33,7 → 33.7
    .replace(/[^a-z0-9ąćęłńóśźż.]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function _nameTokens(norm) {
  return norm.split(' ').filter(t => t.length >= 2 && !/^\d/.test(t));
}
function _nameNumbers(norm) {
  const out = []; const re = /\d+(?:\.\d+)?/g; let m;
  while ((m = re.exec(norm)) !== null) out.push(parseFloat(m[0]));
  return out;
}
function _diceTokens(a, b) {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a), sb = new Set(b);
  let inter = 0; for (const t of sa) if (sb.has(t)) inter++;
  return (2 * inter) / (sa.size + sb.size);
}
function _numScore(a, b) {
  if (!a.length && !b.length) return 1;     // brak wymiarów po obu stronach
  if (!a.length || !b.length) return 0.5;   // jedna strona bez wymiarów — neutralnie
  let sum = 0;
  for (const x of a) {
    let best = 0;
    for (const y of b) {
      const denom = Math.max(Math.abs(x), Math.abs(y), 1e-6);
      const sim = 1 - Math.min(1, Math.abs(x - y) / denom);
      if (sim > best) best = sim;
    }
    sum += best;
  }
  return sum / a.length;
}
// Podobieństwo dwóch nazw materiałów: 60% tokeny + 40% wymiary
function similarityScore(nameA, nameB) {
  const na = _normName(nameA), nb = _normName(nameB);
  const ts = _diceTokens(_nameTokens(na), _nameTokens(nb));
  const ns = _numScore(_nameNumbers(na), _nameNumbers(nb));
  return 0.6 * ts + 0.4 * ns;
}

// Znajdź najpodobniejszy wyceniony materiał (ten sam prefiks indeksu + JM).
// Prefiks adaptacyjny: najpierw 6 znaków, w razie braku trafienia ≥ progu → 4.
const EST_THRESHOLD = 0.50;   // próg minimalny — poniżej nie estymujemy w ogóle
// Powyżej EST_CONFIDENT match uznajemy za pewny (frontend: zwykły „!");
// w przedziale [EST_THRESHOLD, EST_CONFIDENT) — słaby match (frontend: czerwony).
const EST_CONFIDENT = 0.75;
// Prefiksy pozycji NIE-materiałowych (WMAN = pozycja manualna, MOBR = kooperacja) —
// wykluczane z listy materiałów ORAZ z estymaty (kandydaci i cel). Dopisz tu kolejne prefiksy.
const EST_EXCLUDE_PREFIXES = ['WMAN', 'MOBR'];
function _isExcludedIndex(idx) {
  const s = String(idx || '').trim().toUpperCase();
  return EST_EXCLUDE_PREFIXES.some(p => s.startsWith(p));
}
// Cache kandydatów wg prefiksu+JM (krótki TTL) — by w jednym eksporcie nie pytać
// wielokrotnie o ten sam prefiks. Map<'pref|jm', [{indeks,nazwa}]>.
const _candCache = new Map();
const CAND_TTL = 5 * 60 * 1000;
async function _candidatesByPrefix(pref, jm) {
  const key = pref + '|' + (jm || '');
  const hit = _candCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.data;
  let rows = [];
  try {
    rows = await fbQuery(
      `SELECT TRIM(INDEKS) AS INDEKS, TRIM(NAZWA) AS NAZWA FROM M_KIMWSP
       WHERE INDEKS STARTING WITH ?${jm ? ' AND TRIM(JM)=?' : ''}`,
      jm ? [pref, jm] : [pref], 10000
    );
  } catch(e) { console.warn('[MRP] kandydaci err:', e.message); }
  const data = rows.map(r => ({ indeks: trim(r.INDEKS), nazwa: trim(r.NAZWA) }));
  _candCache.set(key, { data, expires: Date.now() + CAND_TTL });
  return data;
}

async function estimateUnitPrice(indeks, jm, nazwa) {
  if (!indeks || !nazwa) return null;
  if (_isExcludedIndex(indeks)) return null;             // nie estymuj dla pozycji nie-materiałowych
  const corpus = await getPriceCorpus();
  const base = indeks.trim();
  for (const plen of [6, 4]) {
    const pref = base.slice(0, plen);
    // Kandydaci z kartoteki o tym samym prefiksie i JM (zapytanie indeksowane STARTING WITH)
    const cands = await _candidatesByPrefix(pref, jm);
    let best = null;
    for (const c of cands) {
      if (c.indeks === base) continue;
      if (_isExcludedIndex(c.indeks)) continue;            // wyklucz nie-materiałowe
      if (!c.nazwa || /manual/i.test(c.nazwa)) continue;   // wyklucz pozycje manualne
      const price = corpus.get(c.indeks);
      if (!price || !(price.cena > 0)) continue;           // tylko wyceniony kandydat
      const sc = similarityScore(nazwa, c.nazwa);
      if (!best || sc > best.score) best = { score: sc, indeks: c.indeks, cena: price.cena, waluta: price.waluta, nazwa: c.nazwa };
    }
    if (best && best.score >= EST_THRESHOLD) return best;
  }
  return null;
}

// Estymata lead time (dni) wg najpodobniejszego indeksu, który MA lead time z PZ.
async function estimateLeadDays(indeks, jm, nazwa) {
  if (!indeks || !nazwa) return null;
  if (_isExcludedIndex(indeks)) return null;
  const pz = await getLastPzCorpus();
  const base = indeks.trim();
  for (const plen of [6, 4]) {
    const pref = base.slice(0, plen);
    const cands = await _candidatesByPrefix(pref, jm);
    let best = null;
    for (const c of cands) {
      if (c.indeks === base) continue;
      if (_isExcludedIndex(c.indeks)) continue;
      if (!c.nazwa || /manual/i.test(c.nazwa)) continue;
      const p = pz.get(c.indeks);
      if (!p || p.leadDays == null) continue;            // tylko kandydat z lead time
      const sc = similarityScore(nazwa, c.nazwa);
      if (!best || sc > best.score) best = { score: sc, indeks: c.indeks, leadDays: p.leadDays };
    }
    if (best && best.score >= EST_THRESHOLD) return best;
  }
  return null;
}

// Doszacowanie ceny ORAZ lead time dla wierszy-braków (Stan po zlec. < 0), które
// nie mają własnej ceny / lead time. Wg podobnego indeksu (cache kandydatów →
// kilka zapytań STARTING WITH, nie N).
async function fillBrakiEstimates(list) {
  let nPrice = 0, nLead = 0;
  for (const o of list) {
    const spz = (o.stanil || 0) + (o.iloscR || 0);
    if (spz >= 0) continue;                          // tylko braki
    const needPrice = o.cenaJedn == null, needLead = o.leadDays == null;
    if (!needPrice && !needLead) continue;
    if (nPrice + nLead >= 1000) break;               // bezpiecznik wydajności
    try {
      if (needPrice) {
        const m = await estimateUnitPrice(o.indeks, o.jm, o.nazwa);
        if (m) { o.cenaJedn = m.cena; o.cenaJednWaluta = m.waluta; o.cenaJednZrodlo = 'est'; o.cenaJednEst = { z: m.indeks, score: Math.round(m.score * 100) }; nPrice++; }
      }
      if (needLead) {
        const lm = await estimateLeadDays(o.indeks, o.jm, o.nazwa);
        if (lm) { o.leadDays = lm.leadDays; o.leadEst = { z: lm.indeks, score: Math.round(lm.score * 100) }; nLead++; }
      }
    } catch(_) {}
  }
  if (nPrice || nLead) console.log(`[MRP] Braki estymaty: cena ${nPrice}, lead time ${nLead}`);
  return list;
}

// Dopisuje status płatności zamówień własnych do materiałów (kolumna „$").
// Bierze tylko statusy płatnicze (OPL/COP/NO/BLO) z M_ZAMWLASNE; zbiór jest mały,
// więc pobieramy go globalnie jednym zapytaniem i mapujemy po indeksie.
// payStatuses: [{ kod, opis, count }] posortowane wg pilności (BLO→NO→COP→OPL).
const PAY_ORDER = { BLO: 0, NO: 1, COP: 2, OPL: 3 };
async function attachPayStatuses(list) {
  try {
    const rows = await fbQuery(
      `SELECT TRIM(pz.INDEKS) AS INDEKS, TRIM(wl.STAN) AS STAN_KOD, TRIM(ts.OPIS) AS STAN_OPIS, COUNT(*) AS CNT
       FROM M_ZAMWLASNEPOZ pz
       JOIN M_ZAMWLASNE wl ON wl.KATEGORIA=pz.KATEGORIA AND wl.ROK_ZAM=pz.ROK_ZAM AND wl.SYMBOL_ZAM=pz.SYMBOL_ZAM
       LEFT JOIN M_ZAMWL_TABSTAN ts ON TRIM(ts.SYMBOL)=TRIM(wl.STAN)
       WHERE TRIM(wl.STAN) IN ('OPL','COP','NO','BLO')
       GROUP BY TRIM(pz.INDEKS), TRIM(wl.STAN), TRIM(ts.OPIS)`,
      [], 20000
    );
    const map = new Map();
    for (const r of rows) {
      const idx = trim(r.INDEKS); if (!idx) continue;
      const arr = map.get(idx) || [];
      arr.push({ kod: trim(r.STAN_KOD), opis: trim(r.STAN_OPIS) || trim(r.STAN_KOD), count: num(r.CNT) || 0 });
      map.set(idx, arr);
    }
    for (const o of list) {
      const arr = map.get(o.indeks);
      if (arr && arr.length) { arr.sort((a, b) => (PAY_ORDER[a.kod] ?? 9) - (PAY_ORDER[b.kod] ?? 9)); o.payStatuses = arr; }
    }
  } catch (e) { console.warn('[MRP] payStatuses err:', e.message); }
  return list;
}

// ── Query 1: Lista materiałów ────────────────────────────────

function buildMaterialsSQL({ kat, rok, symb, lp, search, maxRows, indeksCol, date }) {
  const params = [];
  let filterJoin = '';
  const conditions = [];

  if (kat && rok && symb && indeksCol && indeksCol !== '__NOT_FOUND__') {
    const rok_int = parseInt(rok, 10);
    const lpClean = (lp != null) ? String(lp).trim() : '';
    if (lpClean) {
      filterJoin = `INNER JOIN (SELECT DISTINCT PS.${indeksCol} AS MAT_IND FROM M_PRZEWOD_SK PS WHERE PS.KAT_ZLEC=? AND PS.ROK_ZLEC=? AND PS.SYMB_ZLEC=? AND UPPER(TRIM(PS.LP_ZLEC))=UPPER(?)) FLTR ON FLTR.MAT_IND=S.INDEKS`;
      params.push(kat, rok_int, symb, lpClean);
    } else {
      filterJoin = `INNER JOIN (SELECT DISTINCT PS.${indeksCol} AS MAT_IND FROM M_PRZEWOD_SK PS WHERE PS.KAT_ZLEC=? AND PS.ROK_ZLEC=? AND PS.SYMB_ZLEC=?) FLTR ON FLTR.MAT_IND=S.INDEKS`;
      params.push(kat, rok_int, symb);
    }
  } else if (kat && rok && symb) {
    console.warn('[MRP] Filtr po zleceniu pominięty — nieznana kolumna INDEKS w M_PRZEWOD_SK');
  }

  if (search && search.trim().length >= 2) {
    conditions.push('(S.INDEKS CONTAINING ? OR W.NAZWA CONTAINING ?)');
    params.push(search.trim(), search.trim());
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  // ILOSC_R liczymy OSOBNO po pobraniu danych — to może być wolne dla starych zleceń
  // Tutaj zwracamy NULL, a queryMaterials uzupełni to drugim szybkim zapytaniem
  const sql = `
    SELECT FIRST ${maxRows} SKIP 0
      S.INDEKS,
      MAX(W.NAZWA) AS NAZWA, MAX(W.JM) AS JM, MAX(W.GRUPA) AS GRUPA,
      SUM(S.STANIL) AS STANIL, SUM(S.PRZYCHOD) AS PRZYCHOD, SUM(S.ROZCHOD) AS ROZCHOD,
      SUM(S.RAZEM) AS RAZEM, SUM(S.PRZYCH_NP) AS PRZYCH_NP, SUM(S.ROZCHOD_NP) AS ROZCHOD_NP,
      SUM(S.REZERWACJA) AS REZERWACJA, MAX(M.ZAPAS_MIN) AS ZAPAS_MIN,
      SUM(S.RAZEM) AS BRAKUJE,
      SUM(S.RAZEM + S.PRZYCH_NP - S.ROZCHOD_NP) AS BRAKUJE_NP,
      MIN(CASE WHEN S.PRZYCHOD > 0 THEN S.TERMIN ELSE NULL END) AS DATA_ZAM,
      S.KOD_LOKAL, MAX(M.CENA_ZAK1) AS CENA_ZAK1, MAX(W.OPIS_SKR) AS OPIS_SKR,
      MAX(A.KUPIEC) AS KUPIEC, MAX(W.CENA_KOSZT) AS CENA_KOSZT, MAX(W.WALUTA) AS WALUTA
    FROM M_KSM_MRP S
    INNER JOIN M_KIMWSP W ON S.INDEKS = W.INDEKS
    LEFT JOIN M_KIMMAG M ON S.INDEKS = M.INDEKS
    LEFT JOIN DT_ATS_ASO A ON A.SYMBOL = W.KOD_ASO
    ${filterJoin}
    ${whereClause}
    GROUP BY S.INDEKS, S.KOD_LOKAL
    ORDER BY S.INDEKS
  `;
  return { sql, params, filterJoin };
}

async function queryMaterials({ kat, rok, symb, lp, search, date } = {}) {
  return withCache('materials', { kat, rok, symb, lp, search, date }, () =>
    _queryMaterials({ kat, rok, symb, lp, search, date }));
}

async function _queryMaterials({ kat, rok, symb, lp, search, date } = {}) {
  const hasFilter = kat && rok && symb;
  const hasSearch = search && search.trim().length >= 2;
  if (!hasFilter && !hasSearch) throw new Error('Wymagany jest Symbol ZO (kat+rok+symb) lub fraza wyszukiwania (min. 2 znaki)');

  const indeksCol = hasFilter ? await detectIndeksColumn() : null;
  const maxRows   = config.maxMaterials || 5000;
  const { sql, params, filterJoin } = buildMaterialsSQL({ kat, rok, symb, lp, search, maxRows, indeksCol, date });

  const filterInfo = hasFilter
    ? `${kat}-${rok}-${symb}${lp ? '-'+lp : ''}${indeksCol === '__NOT_FOUND__' ? ' (bez filtra ZO!)' : ''}`
    : `search="${search}"`;
  console.log(`[MRP] Materiały: ${filterInfo} (max ${maxRows})...`);

  const t0   = Date.now();

  // Uruchom główne zapytanie i ILOSC_R równolegle
  const iloscRMap = new Map(); // indeks+kodLokal -> iloscR
  const [rows] = await Promise.all([
    fbQuery(sql, params, 90000),
    // ILOSC_R osobno — szybsze bo filtruje po INDEKS z FLTR
    (async () => {
      if (!hasFilter) return;
      const prefix = `${kat}-${rok}-${symb}`;
      const dateCond = date ? ` AND CAST(S2.TERMIN AS DATE) <= CAST('${date}' AS DATE)` : '';
      const rok_int = parseInt(rok, 10);
      const lpClean = (lp != null) ? String(lp).trim() : '';
      // Buduj filtr FLTR2 od nowa z aliasem S2
      let fj2;
      if (lpClean) {
        fj2 = `INNER JOIN (SELECT DISTINCT PS2.${indeksCol} AS MAT_IND FROM M_PRZEWOD_SK PS2 WHERE PS2.KAT_ZLEC=? AND PS2.ROK_ZLEC=? AND PS2.SYMB_ZLEC=? AND UPPER(TRIM(PS2.LP_ZLEC))=UPPER(?)) FLTR2 ON FLTR2.MAT_IND=S2.INDEKS`;
      } else {
        fj2 = `INNER JOIN (SELECT DISTINCT PS2.${indeksCol} AS MAT_IND FROM M_PRZEWOD_SK PS2 WHERE PS2.KAT_ZLEC=? AND PS2.ROK_ZLEC=? AND PS2.SYMB_ZLEC=?) FLTR2 ON FLTR2.MAT_IND=S2.INDEKS`;
      }
      const fparams = lpClean ? [kat, rok_int, symb, lpClean] : [kat, rok_int, symb];
      const ilSql = `
        SELECT S2.INDEKS, S2.KOD_LOKAL, SUM(S2.RAZEM) AS ILOSC_R
        FROM M_KSM_MRP S2
        ${fj2}
        WHERE S2.DOKUMENT STARTING WITH ?${dateCond}
        GROUP BY S2.INDEKS, S2.KOD_LOKAL
      `;
      try {
        const ilRows = await fbQuery(ilSql, [...fparams, prefix], 60000);
        for (const r of ilRows) iloscRMap.set(`${trim(r.INDEKS)}|${trim(r.KOD_LOKAL)}`, num(r.ILOSC_R));
        console.log(`[MRP] ILOSC_R: ${ilRows.length} wierszy (prefix="${prefix}", lp="${lpClean||'-'}")`);
      } catch(e) { console.warn('[MRP] ILOSC_R err:', e.message); }
    })()
  ]);

  console.log(`[MRP] Pobrano ${rows.length} materiałów (${Date.now()-t0}ms)`);

  // Cena jednostkowa do wyceny braków: ostatni PZ (CENA_EWID, PLN) → cena z zamówienia
  // własnego (korpus). Spójnie z panelem szczegółów i eksportem PRO.
  const [pzCorpus, corpus] = await Promise.all([getLastPzCorpus(), getPriceCorpus()]);
  const out = rows.map(r => {
    const indeks = trim(r.INDEKS);
    const waluta = trim(r.WALUTA) || 'PLN';
    let cenaJedn = null, cenaJednWaluta = 'PLN', cenaJednZrodlo = null;
    const pz = pzCorpus.get(indeks);
    if (pz && pz.cena > 0) { cenaJedn = pz.cena; cenaJednWaluta = 'PLN'; cenaJednZrodlo = 'pz'; }            // 1) ostatni PZ
    else { const z = corpus.get(indeks); if (z && z.cena > 0) { cenaJedn = z.cena; cenaJednWaluta = z.waluta || 'PLN'; cenaJednZrodlo = 'zam'; } }  // 2) zamówienie
    return {
      indeks, nazwa: trim(r.NAZWA), jm: trim(r.JM), grupa: trim(r.GRUPA),
      stanil: num(r.STANIL), przychod: num(r.PRZYCHOD), rozchod: num(r.ROZCHOD),
      razem: num(r.RAZEM), przychNp: num(r.PRZYCH_NP), rozchodNp: num(r.ROZCHOD_NP),
      rezerwacja: num(r.REZERWACJA), zapasMin: num(r.ZAPAS_MIN),
      brakuje: num(r.BRAKUJE), brakujeNp: num(r.BRAKUJE_NP),
      dataZam: toDateStr(r.DATA_ZAM), kodLokal: trim(r.KOD_LOKAL),
      cenaZak1: num(r.CENA_ZAK1), opisSkr: trim(r.OPIS_SKR),
      kupiec: trim(r.KUPIEC), cenaKoszt: num(r.CENA_KOSZT), waluta,
      cenaJedn, cenaJednWaluta, cenaJednZrodlo, cenaJednEst: null,
      leadDays: pz ? pz.leadDays : null, leadEst: null,
      iloscR: iloscRMap.get(`${indeks}|${trim(r.KOD_LOKAL)}`) ?? null,
    };
  });
  return attachPayStatuses(await fillBrakiEstimates(out.filter(o => !_isExcludedIndex(o.indeks))));   // pomiń pozycje nie-materiałowe (WMAN, MOBR)
}

// ── Query 2: Szczegóły powiązań materiału ────────────────────

async function queryMaterialDetail(indeks, kodLokal) {
  return withCache('detail', { indeks, kodLokal: kodLokal || '01' }, () =>
    _queryMaterialDetail(indeks, kodLokal));
}

async function _queryMaterialDetail(indeks, kodLokal) {
  if (!indeks) throw new Error('INDEKS wymagany');
  const maxRows = config.maxDetail || 2000;

  // Krok 1: SP
  console.log(`[MRP] Detail: ${indeks} / ${kodLokal}`);
  const t0   = Date.now();
  const rows = await fbQuery(
    `SELECT FIRST ${maxRows} C.LP, C.RODZAJ, C.DOKUMENT, C.ILOSC, C.TERMIN, C.ILOSC_R,
       C.PRZYCH_NP, C.PRIOR, C.IND_WYROB, C.DATA_DOK, C.DNIPO_TERM, C.ROZCHOD_NP,
       C.REZERWACJA, C.TERM_NADRZ, C.KLIENT, C.CENA, DT.DATA_1DODSKL
     FROM MP_KSMMRP_SZCZLOK(?, ?) C
     LEFT JOIN DP_ATS_1DATA(FI_STRIPCHARS(C.DOKUMENT,'-')) DT ON 1=1
     ORDER BY C.LP`,
    [indeks, kodLokal || '01'], 30000
  );
  console.log(`[MRP] Detail: ${rows.length} wierszy (${Date.now()-t0}ms)`);

  // Krok 2: zbierz klucze
  const zamMap    = new Map();
  const proMap    = new Map();
  const kontMap   = new Map();
  const zamKeys   = [];
  const proKeys   = [];
  const kontSymbs = new Set();

  for (const r of rows) {
    const dok    = r.DOKUMENT ? String(r.DOKUMENT).trim() : '';
    const rodzaj = r.RODZAJ   ? String(r.RODZAJ).trim()   : '';
    const klient = r.KLIENT   ? String(r.KLIENT).trim()   : '';
    if (!dok) continue;
    const parts = dok.split('-');
    if (rodzaj === 'W' && parts.length >= 3) {
      const key = `${parts[0]}-${parts[1]}-${parts[2]}`;
      if (!zamMap.has(key)) { console.log(`[MRP] ZAM key: ${key}, klient: ${klient}`); zamMap.set(key, null); zamKeys.push(parts); }
      if (klient) kontSymbs.add(klient);
    }
    if (rodzaj === 'R' && parts.length >= 4) {
      const key = `${parts[0]}-${parseInt(parts[1])||0}-${parts[2]}-${parseInt(parts[3])||0}`;
      if (!proMap.has(key)) { proMap.set(key, null); proKeys.push(parts); }
    }
  }

  // ── Kroki 3 + 3b + 4 + 4b RÓWNOLEGLE (Promise.all) ──────────────
  let proCenaJedn = null;
  let indeksWaluta = null;
  let indeksJm = null;
  let indeksNazwa = null;

  await Promise.all([

    // Krok 3: M_ZAMWLASNE (batch równolegle)
    (async () => {
      if (zamKeys.length === 0) return;
      if (!queryMaterialDetail._zamDostCol) {
        try {
          const cols = await fbQuery(
            `SELECT TRIM(F.RDB$FIELD_NAME) AS COL FROM RDB$RELATION_FIELDS F WHERE F.RDB$RELATION_NAME='M_ZAMWLASNE' ORDER BY F.RDB$FIELD_POSITION`,
            [], 5000
          );
          const names = cols.map(c => String(c.COL||'').trim().toUpperCase());
          queryMaterialDetail._zamDostCol = ['NR_DOST','DOSTAWCA','NR_KONTR','KLIENT','NR_KLIENTA','SYMBOL_DOST'].find(c => names.includes(c)) || null;
          console.log(`[MRP] M_ZAMWLASNE dostawca col: ${queryMaterialDetail._zamDostCol}`);
        } catch(e) { queryMaterialDetail._zamDostCol = null; }
      }
      const dc = queryMaterialDetail._zamDostCol;
      const dj = dc ? `LEFT JOIN M_KONTRAH_GL KW ON KW.SYMBOL=WL.${dc}` : '';
      const ds = dc ? `, KW.NAZWA AS NAZWA_KONTR_ZAM` : ', NULL AS NAZWA_KONTR_ZAM';
      const ZB = 10;
      const batches = [];
      for (let bi = 0; bi < zamKeys.length; bi += ZB) {
        const chunk = zamKeys.slice(bi, bi + ZB);
        const cond  = chunk.map(() => '(TRIM(WL.KATEGORIA)=? AND WL.ROK_ZAM=? AND TRIM(WL.SYMBOL_ZAM)=?)').join(' OR ');
        const prms  = chunk.flatMap(p => [p[0].trim(), parseInt(p[1])||0, p[2].trim()]);
        batches.push(
          fbQuery(
            `SELECT TRIM(WL.KATEGORIA) AS KAT, WL.ROK_ZAM, TRIM(WL.SYMBOL_ZAM) AS SYMB,
                    WL.NAZWA ${ds}, TRIM(WL.WALUTA) AS WALUTA_ZAM,
                    TRIM(WL.STAN) AS STAN_KOD, TRIM(TS.OPIS) AS STAN_OPIS,
                    (SELECT SUM(pz.ILOSC*pz.CENA_ZAM) FROM M_ZAMWLASNEPOZ pz
                     WHERE pz.KATEGORIA=WL.KATEGORIA AND pz.ROK_ZAM=WL.ROK_ZAM
                     AND pz.SYMBOL_ZAM=WL.SYMBOL_ZAM AND TRIM(pz.INDEKS)=?) AS WARTOSC,
                    (SELECT SUM(pz.ILOSC) FROM M_ZAMWLASNEPOZ pz
                     WHERE pz.KATEGORIA=WL.KATEGORIA AND pz.ROK_ZAM=WL.ROK_ZAM
                     AND pz.SYMBOL_ZAM=WL.SYMBOL_ZAM AND TRIM(pz.INDEKS)=?) AS ILOSC_ZAM
             FROM M_ZAMWLASNE WL ${dj}
             LEFT JOIN M_ZAMWL_TABSTAN TS ON TRIM(TS.SYMBOL)=TRIM(WL.STAN)
             WHERE ${cond}`,
            [indeks.trim(), indeks.trim(), ...prms], 10000
          ).catch(e => { console.warn('[MRP] ZAM lookup err:', e.message); return []; })
        );
      }
      const results = await Promise.all(batches);
      for (const wr of results)
        for (const w of wr) {
          const key = `${trim(w.KAT)}-${w.ROK_ZAM}-${trim(w.SYMB)}`;
          zamMap.set(key, { nazwaZw: trim(w.NAZWA), nazwaKontr: trim(w.NAZWA_KONTR_ZAM), wartosc: w.WARTOSC != null ? Number(w.WARTOSC) : null, iloscZam: w.ILOSC_ZAM != null ? Number(w.ILOSC_ZAM) : null, waluta: trim(w.WALUTA_ZAM) || null, stanKod: trim(w.STAN_KOD) || null, stanOpis: trim(w.STAN_OPIS) || null });
        }
    })(),

    // Krok 3b: kontrahenci ZAM
    (async () => {
      if (kontSymbs.size === 0) return;
      const syms = [...kontSymbs];
      try {
        const kr = await fbQuery(
          `SELECT TRIM(K.SYMBOL) AS SYM, K.NAZWA FROM M_KONTRAH_GL K WHERE TRIM(K.SYMBOL) IN (${syms.map(()=>'?').join(',')})`,
          syms, 10000
        );
        console.log(`[MRP] KONTR lookup: ${syms.length} symboli, ${kr.length} wyników`);
        for (const k of kr) kontMap.set(trim(k.SYM), trim(k.NAZWA));
      } catch(e) { console.warn('[MRP] KONTR lookup err:', e.message); }
    })(),

    // Krok 4: M_ZLECENIA dla PRO (batch równolegle)
    (async () => {
      if (proKeys.length === 0) return;
      const PB = 10;
      const batches = [];
      for (let bi = 0; bi < proKeys.length; bi += PB) {
        const chunk = proKeys.slice(bi, bi + PB);
        const cond  = chunk.map(() => '(Z.KATEGORIA=? AND Z.ROK_ZAM=? AND Z.SYMBOL_ZAM=? AND Z.LP_ZAM=?)').join(' OR ');
        const prms  = chunk.flatMap(p => [p[0], parseInt(p[1])||0, p[2], parseInt(p[3])||0]);
        batches.push(
          fbQuery(
            `SELECT Z.KATEGORIA, Z.ROK_ZAM, Z.SYMBOL_ZAM, Z.LP_ZAM, K.NAZWA AS NAZWA_KONTR
             FROM M_ZLECENIA Z LEFT JOIN M_KONTRAH_GL K ON K.SYMBOL=Z.NR_KLIENTA WHERE ${cond}`,
            prms, 15000
          ).catch(e => { console.warn('[MRP] PRO lookup err:', e.message); return []; })
        );
      }
      const results = await Promise.all(batches);
      for (const pr of results)
        for (const p of pr) {
          const key = `${trim(p.KATEGORIA)}-${parseInt(p.ROK_ZAM)||0}-${trim(p.SYMBOL_ZAM)}-${parseInt(p.LP_ZAM)||0}`;
          proMap.set(key, trim(p.NAZWA_KONTR));
        }
    })(),

    // Krok 4b: cena + waluta z M_KIMWSP/M_KIMMAG
    (async () => {
      try {
        if (!queryMaterialDetail._kimmagCols) {
          try {
            const cc = await fbQuery(
              `SELECT TRIM(F.RDB$FIELD_NAME) AS COL FROM RDB$RELATION_FIELDS F WHERE F.RDB$RELATION_NAME='M_KIMMAG' ORDER BY F.RDB$FIELD_POSITION`,
              [], 5000
            );
            queryMaterialDetail._kimmagCols = new Set(cc.map(c => String(c.COL||'').trim().toUpperCase()));
            console.log(`[MRP] M_KIMMAG CENA*: ${[...queryMaterialDetail._kimmagCols].filter(c=>c.startsWith('CENA')).join(', ')}`);
          } catch(e) { queryMaterialDetail._kimmagCols = new Set(); }
        }
        const kc = queryMaterialDetail._kimmagCols;
        const hasCE = kc.has('CENA_EWID'), hasCZ = kc.has('CENA_ZAK1');
        const cr = await fbQuery(
          `SELECT TRIM(W.WALUTA) AS WALUTA, TRIM(W.JM) AS JM, TRIM(W.NAZWA) AS NAZWA, W.CENA_KOSZT ${hasCZ ? ', M.CENA_ZAK1' : ''} ${hasCE ? ', M.CENA_EWID' : ''}
           FROM M_KIMWSP W LEFT JOIN M_KIMMAG M ON TRIM(M.INDEKS)=TRIM(W.INDEKS) WHERE TRIM(W.INDEKS)=?`,
          [indeks.trim()], 5000
        );
        if (cr.length > 0) {
          const r0 = cr[0];
          indeksWaluta = r0.WALUTA ? r0.WALUTA.trim() : null;
          indeksJm     = r0.JM    ? trim(r0.JM)       : null;
          indeksNazwa  = r0.NAZWA ? trim(r0.NAZWA)    : null;
          proCenaJedn  = (hasCE && r0.CENA_EWID > 0) ? Number(r0.CENA_EWID)
                       : (hasCZ && r0.CENA_ZAK1 > 0) ? Number(r0.CENA_ZAK1)
                       : (r0.CENA_KOSZT > 0)          ? Number(r0.CENA_KOSZT)
                       : null;
        }
        console.log(`[MRP] indeks ${indeks}: cena=${proCenaJedn} waluta=${indeksWaluta}`);
      } catch(e) { console.warn('[MRP] cenaJedn lookup:', e.message); }
    })()

  ]); // koniec Promise.all

  // Cena jednostkowa z zamówień własnych (ZAM) tego materiału — wyłącznie do
  // fallbacku dla wierszy PRO, które nie mają własnej ceny (puste pole wartości).
  // Wg formuły: wartość zamówienia ÷ ilość zamówiona = cena jednostkowa.
  let zamUnitPrice = null, zamUnitWaluta = null;
  {
    let sumW = 0, sumI = 0, wal = null;
    for (const z of zamMap.values()) {
      if (z && z.wartosc != null && z.wartosc !== 0 && z.iloscZam) {
        sumW += z.wartosc; sumI += Math.abs(z.iloscZam);
        if (!wal) wal = z.waluta;
      }
    }
    if (sumI > 0 && sumW) { zamUnitPrice = sumW / sumI; zamUnitWaluta = wal || indeksWaluta || 'PLN'; }
  }

  // Cena z ostatniego PZ (CENA_EWID w PLN) — pierwsze źródło wyceny wierszy PRO.
  let pzUnitPrice = null;
  try { const pz = (await getLastPzCorpus()).get(indeks.trim()); if (pz && pz.cena > 0) pzUnitPrice = pz.cena; }
  catch(e) { console.warn('[MRP] PZ price err:', e.message); }

  // Estymata ceny wg podobieństwa — OSTATECZNY fallback dla wierszy PRO, gdy
  // materiał nie ma ceny z PZ ani z własnego zamówienia.
  // Szukamy najpodobniejszego wycenionego materiału (prefiks indeksu + JM).
  let estUnit = null, estWaluta = null, estInfo = null;
  const hasPro = rows.some(r => (r.RODZAJ ? String(r.RODZAJ).trim() : '') === 'R');
  if (hasPro && pzUnitPrice == null && zamUnitPrice == null && indeksNazwa) {
    try {
      const m = await estimateUnitPrice(indeks.trim(), indeksJm, indeksNazwa);
      if (m) {
        estUnit = m.cena; estWaluta = m.waluta;
        estInfo = { z: m.indeks, nazwa: m.nazwa, score: Math.round(m.score * 100) };
        console.log(`[MRP] Estymata PRO dla ${indeks}: ${estUnit} ${estWaluta} wg ${m.indeks} (${estInfo.score}%)`);
      }
    } catch(e) { console.warn('[MRP] estymata err:', e.message); }
  }

  // Krok 5: złóż wynik
  return rows.map(r => {
    const dok    = r.DOKUMENT ? String(r.DOKUMENT).trim() : '';
    const rodzaj = r.RODZAJ   ? String(r.RODZAJ).trim()   : '';
    const parts  = dok.split('-');
    let nazwaZw = null, nazwaKontr = null, wartosc = null, waluta = null, est = null, stanZam = null;

    if (rodzaj === 'W' && parts.length >= 3) {
      const zam = zamMap.get(`${parts[0]}-${parts[1]}-${parts[2]}`);
      if (zam) {
        nazwaZw = zam.nazwaZw || null; nazwaKontr = zam.nazwaKontr || null; wartosc = zam.wartosc; waluta = zam.waluta || indeksWaluta;
        if (zam.stanKod || zam.stanOpis) stanZam = { kod: zam.stanKod, opis: zam.stanOpis };
      }
    }
    if (rodzaj === 'R' && parts.length >= 4) {
      nazwaKontr = proMap.get(`${parts[0]}-${parseInt(parts[1])||0}-${parts[2]}-${parseInt(parts[3])||0}`) || null;
      const il = num(r.ILOSC);
      // Kaskada (spójnie z kolumną „Braki PLN" i Excelem): ostatni PZ → zamówienie własne → estymata.
      if (il != null && pzUnitPrice != null) { wartosc = Math.abs(il) * pzUnitPrice; waluta = 'PLN'; }
      else if (il != null && zamUnitPrice != null) { wartosc = Math.abs(il) * zamUnitPrice; waluta = zamUnitWaluta; }
      // Ostateczny fallback: cena estymowana z podobnego materiału (oznacz „!").
      else if (il != null && estUnit != null) { wartosc = Math.abs(il) * estUnit; waluta = estWaluta; est = estInfo; }
      else waluta = 'PLN';
    }
    return {
      lp: num(r.LP), rodzaj, dokument: dok, ilosc: num(r.ILOSC), termin: toDateStr(r.TERMIN),
      iloscR: num(r.ILOSC_R), przychNp: num(r.PRZYCH_NP), prior: num(r.PRIOR),
      indWyrob: trim(r.IND_WYROB), dataDok: toDateStr(r.DATA_DOK), dnipTerm: num(r.DNIPO_TERM),
      rozchodNp: num(r.ROZCHOD_NP), rezerwacja: num(r.REZERWACJA), termNadrz: toDateStr(r.TERM_NADRZ),
      dataDodania: toDateTimeStr(r.DATA_1DODSKL),
      nazwaZw, nazwaKontr, wartosc, waluta, est, stanZam,
    };
  });
}

// ── Autocomplete zleceń ──────────────────────────────────────

async function queryOrdersAC(q) {
  if (!q || q.trim().length < 2) return [];
  const s = q.trim().toUpperCase();
  const rows = await fbQuery(
    `SELECT FIRST 30 Z.KATEGORIA, Z.ROK_ZAM, Z.SYMBOL_ZAM, Z.LP_ZAM, Z.NAZWA, Z.NR_KLIENTA
     FROM M_ZLECENIA Z WHERE Z.ROK_ZAM >= 2020
     AND (Z.SYMBOL_ZAM CONTAINING ? OR Z.KATEGORIA CONTAINING ?)
     ORDER BY Z.ROK_ZAM DESC, Z.SYMBOL_ZAM`,
    [s, s], 10000
  );
  return rows.map(r => ({ kat: trim(r.KATEGORIA), rok: num(r.ROK_ZAM), symb: trim(r.SYMBOL_ZAM), lp: num(r.LP_ZAM), nazwa: trim(r.NAZWA), nr: trim(r.NR_KLIENTA) }));
}

// ── Test połączenia ──────────────────────────────────────────

async function testConnection() {
  try {
    const t0 = Date.now();
    await fbQuery('SELECT 1 FROM RDB$DATABASE', [], 5000);
    return { ok: true, ms: Date.now() - t0 };
  } catch(err) { return { ok: false, error: err.message }; }
}

process.on('exit', () => { if (_pool) _pool.destroy(); });

// ── Inspekcja schematu tabeli ────────────────────────────────

async function getTableColumns(tableName) {
  const rows = await fbQuery(
    `SELECT TRIM(F.RDB$FIELD_NAME) AS COL_NAME, F.RDB$FIELD_POSITION AS POSITION,
            T.RDB$TYPE_NAME AS TYPE_NAME, COALESCE(T2.RDB$FIELD_LENGTH, 0) AS FIELD_LEN
     FROM RDB$RELATION_FIELDS F
     LEFT JOIN RDB$FIELDS T2 ON T2.RDB$FIELD_NAME = F.RDB$FIELD_SOURCE
     LEFT JOIN RDB$TYPES T ON T.RDB$FIELD_NAME = 'RDB$FIELD_TYPE' AND T.RDB$TYPE = T2.RDB$FIELD_TYPE
     WHERE F.RDB$RELATION_NAME = ? ORDER BY F.RDB$FIELD_POSITION`,
    [tableName], 10000
  );
  return rows.map(r => ({ name: trim(r.COL_NAME), position: r.POSITION, type: trim(r.TYPE_NAME), length: r.FIELD_LEN }));
}

// ── Query 1b: Tryb globalny ──────────────────────────────────

async function queryMaterialsGlobal({ date, search } = {}) {
  return withCache('global', { date, search }, () =>
    _queryMaterialsGlobal({ date, search }));
}

async function _queryMaterialsGlobal({ date, search } = {}) {
  if (!date && (!search || search.trim().length < 2)) throw new Error('Wymagana jest data lub fraza wyszukiwania (min. 2 znaki)');

  const params = [];
  const conditions = [];
  let dateJoin = '';

  if (date) {
    dateJoin = `INNER JOIN (SELECT DISTINCT S2.INDEKS, S2.KOD_LOKAL FROM M_KSM_MRP S2 WHERE S2.ROZCHOD>0 AND CAST(S2.TERMIN AS DATE)<=CAST(? AS DATE)) DFLTR ON DFLTR.INDEKS=S.INDEKS AND DFLTR.KOD_LOKAL=S.KOD_LOKAL`;
    params.push(new Date(date));
  }
  if (search && search.trim().length >= 2) {
    conditions.push('(S.INDEKS CONTAINING ? OR W.NAZWA CONTAINING ?)');
    params.push(search.trim(), search.trim());
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const maxRows = config.maxMaterials || 5000;

  const sql = `
    SELECT FIRST ${maxRows} SKIP 0
      S.INDEKS, MAX(W.NAZWA) AS NAZWA, MAX(W.JM) AS JM, MAX(W.GRUPA) AS GRUPA,
      SUM(S.STANIL) AS STANIL, SUM(S.PRZYCHOD) AS PRZYCHOD, SUM(S.ROZCHOD) AS ROZCHOD,
      SUM(S.RAZEM) AS RAZEM, SUM(S.PRZYCH_NP) AS PRZYCH_NP, SUM(S.ROZCHOD_NP) AS ROZCHOD_NP,
      SUM(S.REZERWACJA) AS REZERWACJA, MAX(M.ZAPAS_MIN) AS ZAPAS_MIN,
      SUM(S.RAZEM) AS BRAKUJE, SUM(S.RAZEM + S.PRZYCH_NP - S.ROZCHOD_NP) AS BRAKUJE_NP,
      MIN(CASE WHEN S.PRZYCHOD > 0 THEN S.TERMIN ELSE NULL END) AS DATA_ZAM,
      S.KOD_LOKAL, MAX(M.CENA_ZAK1) AS CENA_ZAK1, MAX(W.OPIS_SKR) AS OPIS_SKR,
      MAX(A.KUPIEC) AS KUPIEC, MAX(W.CENA_KOSZT) AS CENA_KOSZT, MAX(W.WALUTA) AS WALUTA, NULL AS ILOSC_R
    FROM M_KSM_MRP S
    INNER JOIN M_KIMWSP W ON S.INDEKS = W.INDEKS
    LEFT JOIN M_KIMMAG M ON S.INDEKS = M.INDEKS
    LEFT JOIN DT_ATS_ASO A ON A.SYMBOL = W.KOD_ASO
    ${dateJoin} ${whereClause}
    GROUP BY S.INDEKS, S.KOD_LOKAL ORDER BY S.INDEKS
  `;

  console.log(`[MRP] Globalnie: date=${date||'-'} search=${search||'-'} (max ${maxRows})...`);
  const t0   = Date.now();
  const rows = await fbQuery(sql, params, 90000);
  console.log(`[MRP] Globalnie: ${rows.length} materiałów (${Date.now()-t0}ms)`);

  const [pzCorpus, corpus] = await Promise.all([getLastPzCorpus(), getPriceCorpus()]);
  const out = rows.map(r => {
    const indeks = trim(r.INDEKS);
    const waluta = trim(r.WALUTA) || 'PLN';
    let cenaJedn = null, cenaJednWaluta = 'PLN', cenaJednZrodlo = null;
    const pz = pzCorpus.get(indeks);
    if (pz && pz.cena > 0) { cenaJedn = pz.cena; cenaJednWaluta = 'PLN'; cenaJednZrodlo = 'pz'; }
    else { const z = corpus.get(indeks); if (z && z.cena > 0) { cenaJedn = z.cena; cenaJednWaluta = z.waluta || 'PLN'; cenaJednZrodlo = 'zam'; } }
    return {
      indeks, nazwa: trim(r.NAZWA), jm: trim(r.JM), grupa: trim(r.GRUPA),
      stanil: num(r.STANIL), przychod: num(r.PRZYCHOD), rozchod: num(r.ROZCHOD),
      razem: num(r.RAZEM), przychNp: num(r.PRZYCH_NP), rozchodNp: num(r.ROZCHOD_NP),
      rezerwacja: num(r.REZERWACJA), zapasMin: num(r.ZAPAS_MIN),
      brakuje: num(r.BRAKUJE), brakujeNp: num(r.BRAKUJE_NP),
      dataZam: toDateStr(r.DATA_ZAM), kodLokal: trim(r.KOD_LOKAL),
      cenaZak1: num(r.CENA_ZAK1), opisSkr: trim(r.OPIS_SKR),
      kupiec: trim(r.KUPIEC), cenaKoszt: num(r.CENA_KOSZT), waluta,
      cenaJedn, cenaJednWaluta, cenaJednZrodlo, cenaJednEst: null, leadDays: pz ? pz.leadDays : null, leadEst: null, iloscR: null,
    };
  });
  return attachPayStatuses(await fillBrakiEstimates(out.filter(o => !_isExcludedIndex(o.indeks))));   // pomiń pozycje nie-materiałowe (WMAN, MOBR)
}

// ── Query: Pozycje ZAM dla eksportu ──────────────────────────

async function queryZamPositions({ kat, rok, symb, indeksy }) {
  return withCache('zam', { kat, rok, symb, indeksy: (indeksy||[]).slice().sort() }, () =>
    _queryZamPositions({ kat, rok, symb, indeksy }));
}

async function _queryZamPositions({ kat, rok, symb, indeksy }) {
  if (!indeksy || indeksy.length === 0) throw new Error('Wymagana lista indeksów');
  if (!kat || !rok || !symb) throw new Error('Wymagane kat/rok/symb zlecenia');

  if (!queryZamPositions._poz_cols) {
    try {
      const cc = await fbQuery(`SELECT TRIM(F.RDB$FIELD_NAME) AS COL FROM RDB$RELATION_FIELDS F WHERE F.RDB$RELATION_NAME='M_ZAMWLASNEPOZ' ORDER BY F.RDB$FIELD_POSITION`, [], 5000);
      queryZamPositions._poz_cols = new Set(cc.map(c => String(c.COL||'').trim().toUpperCase()));
      console.log(`[MRP] M_ZAMWLASNEPOZ WALUTA: ${queryZamPositions._poz_cols.has('WALUTA')}, CENA_JEDN: ${queryZamPositions._poz_cols.has('CENA_JEDN')}`);
    } catch(e) { queryZamPositions._poz_cols = new Set(); }
  }
  const hasWaluta   = queryZamPositions._poz_cols.has('WALUTA');
  const hasCenaJedn = queryZamPositions._poz_cols.has('CENA_JEDN');

  const limited   = indeksy.slice(0, 500).map(s => String(s).trim());
  const indeksCol = await detectIndeksColumn();
  if (!indeksCol || indeksCol === '__NOT_FOUND__') throw new Error('Brak kolumny indeksu w M_PRZEWOD_SK');

  console.log(`[MRP] ZAM positions: szukam ZAM w MRP dla ${kat}-${rok}-${symb}...`);
  const t0 = Date.now();

  const zamDocs = await fbQuery(
    `SELECT DISTINCT TRIM(S.INDEKS) AS INDEKS, TRIM(S.DOKUMENT) AS DOKUMENT
     FROM M_KSM_MRP S
     INNER JOIN M_PRZEWOD_SK FLTR ON FLTR.${indeksCol}=S.INDEKS AND FLTR.KAT_ZLEC=? AND FLTR.ROK_ZLEC=? AND FLTR.SYMB_ZLEC=?
     WHERE S.RODZAJ='W' AND S.DOKUMENT IS NOT NULL`,
    [kat, parseInt(rok)||0, symb], 30000
  );
  console.log(`[MRP] ZAM positions: znaleziono ${zamDocs.length} ZAM wierszy w MRP (${Date.now()-t0}ms)`);
  if (zamDocs.length === 0) return [];

  const zamKeySet = new Map();
  const indeksSet = new Set(limited);
  for (const r of zamDocs) {
    const dok = trim(r.DOKUMENT), idx = trim(r.INDEKS);
    if (!indeksSet.has(idx)) continue;
    const p = dok.split('-');
    if (p.length < 3) continue;
    const key = `${p[0]}-${p[1]}-${p[2]}`;
    if (!zamKeySet.has(key)) zamKeySet.set(key, [p[0], p[1], p[2]]);
  }

  const zamKeys = [...zamKeySet.values()];
  console.log(`[MRP] ZAM positions: ${zamKeys.length} unikalnych ZAM zamówień`);
  if (zamKeys.length === 0) return [];

  const BATCH = 10;
  const pos = [];
  const t1  = Date.now();

  // Pobierz pozycje i lookup nazw równolegle
  const [posResult] = await Promise.all([
    (async () => {
      for (let i = 0; i < zamKeys.length; i += BATCH) {
        const chunk = zamKeys.slice(i, i + BATCH);
        const cond  = chunk.map(() => '(p.KATEGORIA=? AND p.ROK_ZAM=? AND p.SYMBOL_ZAM=?)').join(' OR ');
        const prms  = chunk.flatMap(([k,r,s]) => [k, parseInt(r)||0, s]);
        const walSel = hasWaluta   ? `TRIM(p.WALUTA) AS WALUTA,` : `NULL AS WALUTA,`;
        const wrtSel = hasCenaJedn ? `COALESCE(p.CENA_JEDN,p.CENA_ZAM)*p.ILOSC AS WARTOSC,` : `p.CENA_ZAM*p.ILOSC AS WARTOSC,`;
        const rows = await fbQuery(
          `SELECT FIRST 2000 TRIM(p.INDEKS) AS INDEKS, TRIM(p.KATEGORIA) AS KAT, p.ROK_ZAM,
              TRIM(p.SYMBOL_ZAM) AS SYMB, p.LP_ZAM, p.ILOSC, p.CENA_ZAM,
              ${walSel} ${wrtSel}
              CAST(p.TERMIN AS DATE) AS TERMIN, p.DATA_REALIZ, TRIM(p.OPIS_POZ) AS OPIS
           FROM M_ZAMWLASNEPOZ p WHERE (${cond}) ORDER BY TRIM(p.INDEKS), p.LP_ZAM`,
          prms, 20000
        );
        for (const r of rows) pos.push(r);
      }
      return pos;
    })()
  ]);
  console.log(`[MRP] ZAM positions step3: ${pos.length} wierszy (${Date.now()-t1}ms)`);
  if (pos.length === 0) return [];

  // Lookup nazw ZAM + materiałów równolegle
  const zamKeyMap = new Map();
  for (const [k,r,s] of zamKeys) zamKeyMap.set(`${k}-${r}-${s}`, {});
  const matMap = new Map();

  if (!queryZamPositions._dostCol) {
    try {
      const cols = await fbQuery(`SELECT TRIM(F.RDB$FIELD_NAME) AS COL FROM RDB$RELATION_FIELDS F WHERE F.RDB$RELATION_NAME='M_ZAMWLASNE' ORDER BY F.RDB$FIELD_POSITION`, [], 5000);
      const names = cols.map(c => String(c.COL||'').trim().toUpperCase());
      queryZamPositions._dostCol = ['NR_DOST','DOSTAWCA','NR_KONTR','KLIENT','NR_KLIENTA','SYMBOL_DOST'].find(c => names.includes(c)) || null;
    } catch(e) { queryZamPositions._dostCol = null; }
  }
  const dostCol    = queryZamPositions._dostCol;
  const dostJoin   = dostCol ? `LEFT JOIN M_KONTRAH_GL kd ON kd.SYMBOL=wl.${dostCol}` : '';
  const dostSelect = dostCol ? `, kd.NAZWA AS NAZWA_KONTR` : `, NULL AS NAZWA_KONTR`;

  await Promise.all([
    // ZAM nazwy
    (async () => {
      const ZB = 10;
      const batches = [];
      for (let i = 0; i < zamKeys.length; i += ZB) {
        const chunk = zamKeys.slice(i, i + ZB);
        const cond  = chunk.map(() => '(TRIM(wl.KATEGORIA)=? AND wl.ROK_ZAM=? AND TRIM(wl.SYMBOL_ZAM)=?)').join(' OR ');
        const p2    = chunk.flatMap(([k,r,s]) => [k, parseInt(r)||0, s]);
        batches.push(
          fbQuery(`SELECT TRIM(wl.KATEGORIA) AS KAT, wl.ROK_ZAM, TRIM(wl.SYMBOL_ZAM) AS SYMB, TRIM(wl.NAZWA) AS NAZWA, TRIM(wl.WALUTA) AS WALUTA_ZAM, TRIM(wl.STAN) AS STAN_KOD, TRIM(TS.OPIS) AS STAN_OPIS ${dostSelect} FROM M_ZAMWLASNE wl ${dostJoin} LEFT JOIN M_ZAMWL_TABSTAN TS ON TRIM(TS.SYMBOL)=TRIM(wl.STAN) WHERE ${cond}`, p2, 15000)
          .catch(e => { console.warn('[MRP] ZAM lookup err:', e.message); return []; })
        );
      }
      const results = await Promise.all(batches);
      for (const wr of results)
        for (const w of wr) {
          const key = `${trim(w.KAT)}-${w.ROK_ZAM}-${trim(w.SYMB)}`;
          zamKeyMap.set(key, { nazwaZam: trim(w.NAZWA), nazwaKontr: trim(w.NAZWA_KONTR), walutaZam: trim(w.WALUTA_ZAM) || null, stanKod: trim(w.STAN_KOD) || null, stanOpis: trim(w.STAN_OPIS) || null });
        }
    })(),
    // Materiały nazwy
    (async () => {
      for (let i = 0; i < limited.length; i += BATCH) {
        const chunk = limited.slice(i, i + BATCH);
        try {
          const wr = await fbQuery(
            `SELECT TRIM(INDEKS) AS INDEKS, TRIM(NAZWA) AS NAZWA, TRIM(JM) AS JM FROM M_KIMWSP WHERE INDEKS IN (${chunk.map(()=>'?').join(',')})`,
            chunk, 10000
          );
          for (const w of wr) matMap.set(trim(w.INDEKS), { nazwa: trim(w.NAZWA), jm: trim(w.JM) });
        } catch(e) {}
      }
    })()
  ]);

  // Uzupełnij nazwy materiałów spoza filtra (inne pozycje tych samych zamówień)
  const missingNames = [...new Set(pos.map(r => trim(r.INDEKS)).filter(i => i && !matMap.has(i)))];
  for (let i = 0; i < missingNames.length; i += 100) {
    const chunk = missingNames.slice(i, i + 100);
    try {
      const wr = await fbQuery(
        `SELECT TRIM(INDEKS) AS INDEKS, TRIM(NAZWA) AS NAZWA, TRIM(JM) AS JM FROM M_KIMWSP WHERE INDEKS IN (${chunk.map(()=>'?').join(',')})`,
        chunk, 15000
      );
      for (const w of wr) matMap.set(trim(w.INDEKS), { nazwa: trim(w.NAZWA), jm: trim(w.JM) });
    } catch(e) {}
  }

  console.log(`[MRP] ZAM positions total: ${pos.length} wierszy (+${missingNames.length} nazw spoza filtra)`);
  return pos.map(r => {
    const idx  = trim(r.INDEKS);
    const zKey = `${trim(r.KAT)}-${r.ROK_ZAM}-${trim(r.SYMB)}`;
    const zam  = zamKeyMap.get(zKey) || {};
    const mat  = matMap.get(idx)    || {};
    return {
      indeks: idx, nazwaMat: mat.nazwa||'', jm: mat.jm||'',
      nrZam: `${trim(r.KAT)}-${r.ROK_ZAM}-${trim(r.SYMB)}`,
      nazwaZam: zam.nazwaZam||'', nazwaKontr: zam.nazwaKontr||'', stanKod: zam.stanKod||null, stanOpis: zam.stanOpis||null,
      lp: num(r.LP_ZAM), ilosc: num(r.ILOSC), cenaZam: num(r.CENA_ZAM),
      waluta: zam.walutaZam || trim(r.WALUTA) || 'PLN', wartosc: num(r.WARTOSC),
      termin: toDateStr(r.TERMIN), dataRealiz: toDateStr(r.DATA_REALIZ), opis: trim(r.OPIS),
    };
  });
}

// ── Query: Pozycje PRO dla eksportu ──────────────────────────

async function queryProPositions({ kat, rok, symb, indeksy }) {
  return withCache('pro', { kat, rok, symb, indeksy: (indeksy||[]).slice().sort() }, () =>
    _queryProPositions({ kat, rok, symb, indeksy }));
}

async function _queryProPositions({ kat, rok, symb, indeksy }) {
  if (!indeksy || indeksy.length === 0) throw new Error('Wymagana lista indeksów');
  if (!kat || !rok || !symb) throw new Error('Wymagane kat/rok/symb');
  const limited   = indeksy.slice(0, 500).map(s => String(s).trim());
  const BATCH     = 20;

  console.log(`[MRP] PRO positions: ${kat}-${rok}-${symb}, ${limited.length} indeksów...`);
  const t0 = Date.now();

  // Krok 1: PRO dokumenty + nazwy równolegle
  const proRows = [];
  const matMap  = new Map();
  const addMap  = new Map();  // pełny NR_PRZEW bez myślników -> data 'Dodanie składnika' (MIN)
  const glMap   = new Map();  // 'LP_ZLEC|NR_POZ' -> DATA_ZAL przewodnika (fallback)

  await Promise.all([
    // PRO dokumenty
    (async () => {
      for (let i = 0; i < limited.length; i += BATCH) {
        const chunk = limited.slice(i, i + BATCH);
        const ph    = chunk.map(() => '?').join(',');
        // Filtr po zleceniu zapewnia DOKUMENT STARTING WITH 'kat-rok-symb' (numer przewodnika
        // tego zlecenia) + lista indeksów już ograniczona do zlecenia — JOIN do M_PRZEWOD_SK
        // jest zbędny i był głównym źródłem timeoutów (30s → ~16ms bez niego).
        const rows  = await fbQuery(
          `SELECT TRIM(S.INDEKS) AS INDEKS, TRIM(S.DOKUMENT) AS DOKUMENT, ABS(S.RAZEM) AS N_NETTO
           FROM M_KSM_MRP S
           WHERE S.RODZAJ='R' AND S.INDEKS IN (${ph}) AND S.DOKUMENT STARTING WITH ? AND S.DOKUMENT IS NOT NULL`,
          [...chunk, `${kat}-${rok}-${symb}`], 30000
        );
        for (const r of rows) proRows.push(r);
      }
    })(),
    // Nazwy
    (async () => {
      for (let i = 0; i < limited.length; i += BATCH) {
        const chunk = limited.slice(i, i + BATCH);
        try {
          const wr = await fbQuery(
            `SELECT TRIM(INDEKS) AS INDEKS, TRIM(NAZWA) AS NAZWA, TRIM(JM) AS JM FROM M_KIMWSP WHERE INDEKS IN (${chunk.map(()=>'?').join(',')})`,
            chunk, 10000
          );
          for (const w of wr) matMap.set(trim(w.INDEKS), { nazwa: trim(w.NAZWA), jm: trim(w.JM) });
        } catch(e) {}
      }
    })(),
    // Data dodania składnika — bulk (jak procedura DP_ATS_1DATA, ale 2 zapytania zamiast N):
    //   1) M_ZM_PRZEW: MIN(DATA_ZM) dla zdarzeń 'Dodanie składnika' per pełny NR_PRZEW
    (async () => {
      try {
        const pref = `${kat}${rok}${symb}`;  // numer przewodnika bez myślników (KAT+ROK+SYMB)
        const zm = await fbQuery(
          `SELECT TRIM(ZM.NR_PRZEW) AS NRP, MIN(ZM.DATA_ZM) AS DZ FROM M_ZM_PRZEW ZM
           WHERE ZM.NAZWA_POLA='Dodanie składnika' AND ZM.NR_PRZEW STARTING WITH ? GROUP BY ZM.NR_PRZEW`,
          [pref], 60000
        );
        for (const r of zm) addMap.set(trim(r.NRP), r.DZ);
      } catch(e) { console.warn('[MRP] data dodania (ZM) err:', e.message); }
    })(),
    //   2) M_PRZEWOD_GL.DATA_ZAL — fallback (data założenia przewodnika), gdy brak zdarzenia
    (async () => {
      try {
        const gl = await fbQuery(
          `SELECT TRIM(GL.LP_ZLEC) AS LPZ, TRIM(GL.NR_POZ) AS NRP, GL.DATA_ZAL AS DZ FROM M_PRZEWOD_GL GL
           WHERE GL.KAT_ZLEC=? AND GL.ROK_ZLEC=? AND GL.SYMB_ZLEC=?`,
          [kat, parseInt(rok)||0, symb], 60000
        );
        for (const r of gl) glMap.set(`${trim(r.LPZ)}|${trim(r.NRP)}`, r.DZ);
      } catch(e) { console.warn('[MRP] data dodania (GL) err:', e.message); }
    })()
  ]);

  console.log(`[MRP] PRO positions krok1: ${proRows.length} wierszy (${Date.now()-t0}ms)`);
  if (proRows.length === 0) return [];

  const psKeySet = new Map();
  for (const r of proRows) {
    const dok = trim(r.DOKUMENT), idx = trim(r.INDEKS);
    const nNetto = r.N_NETTO != null ? Number(r.N_NETTO) : null;
    if (!psKeySet.has(dok)) psKeySet.set(dok, { indeks: idx, nNetto });
  }

  // Wycena per indeks: 1) ostatni PZ (CENA_EWID, PLN), 2) cena z zamówienia własnego (korpus),
  // 3) estymata wg podobieństwa. Spójnie z panelem i kolumną „Braki PLN".
  const [pzCorpus, corpus] = await Promise.all([getLastPzCorpus(), getPriceCorpus()]);
  const uniqIdx = [...new Set([...psKeySet.values()].map(v => v.indeks))];
  const priceByIdx = new Map();   // indeks -> { cena, waluta, zrodlo, est }
  let nEst = 0;
  for (const idx of uniqIdx) {
    const mat = matMap.get(idx) || {};
    const pz = pzCorpus.get(idx);
    if (pz && pz.cena > 0) {                          // 1) ostatni PZ
      priceByIdx.set(idx, { cena: pz.cena, waluta: 'PLN', zrodlo: 'pz', est: null });
      continue;
    }
    const zam = corpus.get(idx);
    if (zam && zam.cena > 0) {                        // 2) własne zamówienie
      priceByIdx.set(idx, { cena: zam.cena, waluta: zam.waluta || 'PLN', zrodlo: 'zam', est: null });
      continue;
    }
    const m = await estimateUnitPrice(idx, mat.jm, mat.nazwa);   // 3) estymata
    if (m) {
      nEst++;
      priceByIdx.set(idx, { cena: m.cena, waluta: m.waluta, zrodlo: 'est',
                            est: { z: m.indeks, nazwa: m.nazwa, score: Math.round(m.score * 100) } });
    } else {
      priceByIdx.set(idx, { cena: null, waluta: 'PLN', zrodlo: null, est: null });
    }
  }

  const result = [];
  for (const [dok, { indeks, nNetto }] of psKeySet) {
    const mat = matMap.get(indeks) || {};
    const p   = priceByIdx.get(indeks) || { cena: null, waluta: 'PLN', zrodlo: null, est: null };
    // Data dodania składnika: zdarzenie 'Dodanie składnika' (po pełnym nr bez myślników),
    // a gdy brak — data założenia przewodnika (klucz LP_ZLEC|NR_PRZEW).
    const parts = dok.split('-');
    let dd = addMap.get(dok.replace(/-/g, ''));
    if (dd == null && parts.length >= 5) dd = glMap.get(`${parts[3].trim()}|${parts[4].trim()}`);
    result.push({
      indeks, nazwaMat: mat.nazwa||'', jm: mat.jm||'', nrPro: dok, nNetto,
      cena: p.cena, waluta: p.waluta,
      wartosc: (nNetto != null && p.cena != null) ? nNetto * p.cena : null,
      zrodlo: p.zrodlo, est: p.est, dataDodania: toDateTimeStr(dd),
    });
  }
  result.sort((a, b) => a.indeks.localeCompare(b.indeks) || a.nrPro.localeCompare(b.nrPro));
  console.log(`[MRP] PRO positions total: ${result.length} (${nEst} indeksów estymowanych)`);
  return result;
}

// ── Query: Raport materiałowy dla listy zleceń (harm-full) ───
// Nowe podejście: JOIN M_KSM_MRP z M_PRZEWOD_SK bezpośrednio w Firebird
// Zamiast: pobierz 73k indeksów → 917 zapytań IN(80) → timeout
// Teraz: 32 zapytania JOIN(6 zleceń) → ~30s total

async function queryPlanMaterials(zlecenia) {
  return withCache('planmat', { z: (zlecenia||[]).map(z => `${z.kat}-${z.rok}-${z.symb}`).sort() }, () =>
    _queryPlanMaterials(zlecenia));
}

async function _queryPlanMaterials(zlecenia) {
  if (!zlecenia || !zlecenia.length) throw new Error('Wymagana lista zleceń');

  const indeksCol = await detectIndeksColumn();
  if (!indeksCol || indeksCol === '__NOT_FOUND__') throw new Error('Brak kolumny indeksu w M_PRZEWOD_SK');

  const deduped = [...new Map(
    zlecenia.map(z => [`${z.kat}-${z.rok}-${z.symb}`, { kat: z.kat, rok: parseInt(z.rok)||0, symb: z.symb }])
  ).values()];

  console.log(`[MRP] PlanReport: ${deduped.length} zleceń (JOIN approach)`);
  const t0 = Date.now();

  const mrpMap    = new Map(); // indeks -> aggregated MRP state
  const iloscRMap = new Map(); // indeks -> ILOSC_R

  const ZBATCH   = 6;  // zlecenia per JOIN query (mniejsze = szybszy zapytanie)
  const PARALLEL = 2;  // max równoległych (pool=6, 2×JOIN+2×iloscR = 4 conn)

  // Podziel na batche
  const allBatches = [];
  for (let i = 0; i < deduped.length; i += ZBATCH) allBatches.push(deduped.slice(i, i + ZBATCH));
  console.log(`[MRP] PlanReport: ${allBatches.length} batch GROUP × ${ZBATCH} zleceń = ~${allBatches.length * 2} zapytań`);

  // Przetwarzaj grupy sekwencyjnie, każdą grupę wewnętrznie równolegle
  for (let g = 0; g < allBatches.length; g += PARALLEL) {
    const group = allBatches.slice(g, g + PARALLEL);

    await Promise.all(group.map(async chunk => {
      const cond  = chunk.map(() => `(PS.KAT_ZLEC=? AND PS.ROK_ZLEC=? AND PS.SYMB_ZLEC=?)`).join(' OR ');
      const prms  = chunk.flatMap(z => [z.kat, z.rok, z.symb]);

      // ── JOIN query: M_KSM_MRP ⟕ M_PRZEWOD_SK (filtr po zleceniach) ──
      const rows = await fbQuery(`
        SELECT TRIM(S.INDEKS) AS INDEKS, S.KOD_LOKAL,
               MAX(W.NAZWA) AS NAZWA, MAX(W.JM) AS JM, MAX(A.KUPIEC) AS KUPIEC,
               SUM(S.STANIL) AS STANIL, SUM(S.PRZYCHOD) AS PRZYCHOD,
               SUM(S.ROZCHOD) AS ROZCHOD, SUM(S.RAZEM) AS RAZEM,
               SUM(S.PRZYCH_NP) AS PRZYCH_NP,
               MIN(CASE WHEN S.PRZYCHOD > 0 THEN S.TERMIN ELSE NULL END) AS DATA_ZAM
        FROM M_KSM_MRP S
        INNER JOIN M_KIMWSP W ON S.INDEKS = W.INDEKS
        LEFT JOIN DT_ATS_ASO A ON A.SYMBOL = W.KOD_ASO
        INNER JOIN (
          SELECT DISTINCT PS.${indeksCol} AS MAT_IND
          FROM M_PRZEWOD_SK PS WHERE ${cond}
        ) FLTR ON FLTR.MAT_IND = S.INDEKS
        GROUP BY S.INDEKS, S.KOD_LOKAL
      `, prms, 120000).catch(e => { console.warn(`[MRP] PlanReport JOIN err (${chunk.map(z=>`${z.kat}-${z.rok}-${z.symb}`).join(',')}):`, e.message); return []; });

      for (const r of rows) {
        const ind = trim(r.INDEKS);
        if (!mrpMap.has(ind)) {
          mrpMap.set(ind, {
            indeks: ind, nazwa: trim(r.NAZWA), jm: trim(r.JM), kupiec: trim(r.KUPIEC),
            stanil: 0, przychod: 0, rozchod: 0, razem: 0, przychNp: 0, dataZam: null,
          });
        }
        const m = mrpMap.get(ind);
        m.stanil   += num(r.STANIL)   || 0;
        m.przychod += num(r.PRZYCHOD) || 0;
        m.rozchod  += num(r.ROZCHOD)  || 0;
        m.razem    += num(r.RAZEM)    || 0;
        m.przychNp += num(r.PRZYCH_NP) || 0;
        const dz = toDateStr(r.DATA_ZAM);
        if (dz && (!m.dataZam || dz < m.dataZam)) m.dataZam = dz;
      }

      // ── ILOSC_R: suma popytu z tych zleceń (bez IN — filtr po DOKUMENT) ──
      const prefCond = chunk.map(() => 'S.DOKUMENT STARTING WITH ?').join(' OR ');
      const prefPrms = chunk.map(z => `${z.kat}-${z.rok}-${z.symb}`);
      const ilRows = await fbQuery(`
        SELECT TRIM(S.INDEKS) AS INDEKS, SUM(S.RAZEM) AS ILOSC_R
        FROM M_KSM_MRP S WHERE (${prefCond})
        GROUP BY S.INDEKS
      `, prefPrms, 120000).catch(e => { console.warn('[MRP] PlanReport iloscR err:', e.message); return []; });

      for (const r of ilRows) {
        const ind = trim(r.INDEKS);
        iloscRMap.set(ind, (iloscRMap.get(ind) || 0) + (num(r.ILOSC_R) || 0));
      }
    }));

    if ((g / PARALLEL + 1) % 3 === 0 || g + PARALLEL >= allBatches.length)
      console.log(`[MRP] PlanReport: ${Math.floor(g/PARALLEL)+group.length}/${Math.ceil(allBatches.length/PARALLEL)} grup, ${mrpMap.size} mat (${Date.now()-t0}ms)`);
  }

  console.log(`[MRP] PlanReport: ${mrpMap.size} mat, ${iloscRMap.size} z popytem (${Date.now()-t0}ms)`);

  return [...mrpMap.values()].map(m => {
    const ilR = iloscRMap.get(m.indeks) ?? null;
    const r   = v => Math.round((v||0) * 10000) / 10000;
    return {
      indeks: m.indeks, nazwa: m.nazwa, jm: m.jm, kupiec: m.kupiec,
      stanil: r(m.stanil), przychod: r(m.przychod), rozchod: r(m.rozchod),
      razem: r(m.razem), przychNp: r(m.przychNp), dataZam: m.dataZam,
      potrzeba: ilR != null ? r(Math.abs(ilR)) : null,
      brakuje:  r(m.razem),
    };
  });
}

// ── Query: Mapa zlecenie → materiały (dla widoku zleceń) ─────

async function queryPlanZlecenieMap(zlecenia) {
  return withCache('zlecmap', { z: (zlecenia||[]).map(z => `${z.kat}-${z.rok}-${z.symb}`).sort() }, () =>
    _queryPlanZlecenieMap(zlecenia));
}

async function _queryPlanZlecenieMap(zlecenia) {
  const indeksCol = await detectIndeksColumn();
  if (!indeksCol || indeksCol === '__NOT_FOUND__') throw new Error('Brak kolumny indeksu w M_PRZEWOD_SK');

  const deduped = [...new Map(
    zlecenia.map(z => [`${z.kat}-${z.rok}-${z.symb}`, { kat: z.kat, rok: parseInt(z.rok)||0, symb: z.symb }])
  ).values()];

  const ZBATCH   = 5;  // mniej OR conditions = szybszy zapytanie
  const PARALLEL = 2;  // ostrożnie — pool=6, inne zapytania też mogą być aktywne

  const setMap = new Map(); // 'KAT-ROK-SYMB-LP_ZLEC-NR_PRZEW' -> Set<indeks>
  const allBatches = [];
  for (let i = 0; i < deduped.length; i += ZBATCH) allBatches.push(deduped.slice(i, i + ZBATCH));
  console.log(`[MRP] ZleceMap: ${deduped.length} zleceń → ${allBatches.length} batch`);

  // Sekwencyjne grupy po PARALLEL
  for (let g = 0; g < allBatches.length; g += PARALLEL) {
    const group = allBatches.slice(g, g + PARALLEL);
    await Promise.all(group.map(async chunk => {
      const cond  = chunk.map(() => `(PS.KAT_ZLEC=? AND PS.ROK_ZLEC=? AND PS.SYMB_ZLEC=?)`).join(' OR ');
      const prms  = chunk.flatMap(z => [z.kat, z.rok, z.symb]);
      const rows  = await fbQuery(
        // LP_ZLEC + NR_PRZEW → identyfikuje unikalny NR_PRZEWODNIKA
        `SELECT TRIM(PS.KAT_ZLEC) AS KAT, PS.ROK_ZLEC, TRIM(PS.SYMB_ZLEC) AS SYMB,
                PS.LP_ZLEC, PS.NR_PRZEW,
                TRIM(PS.${indeksCol}) AS INDEKS
         FROM M_PRZEWOD_SK PS WHERE ${cond}`,
        prms, 90000
      ).catch(e => { console.warn('[MRP] ZleceMap batch err:', e.message); return []; });

      for (const r of rows) {
        // Klucz: 'KAT-ROK-SYMB-LP_ZLEC-NR_PRZEW' — odpowiada NR_PRZEWODNIKA
        const key = `${trim(r.KAT)}-${r.ROK_ZLEC}-${trim(r.SYMB)}-${r.LP_ZLEC||0}-${r.NR_PRZEW||0}`;
        if (!setMap.has(key)) setMap.set(key, new Set());
        const ind = trim(r.INDEKS);
        if (ind) setMap.get(key).add(ind);
      }
    }));
  }

  const out = {};
  for (const [k, v] of setMap) out[k] = [...v];
  console.log(`[MRP] ZleceMap: ${Object.keys(out).length} przewodników z materiałami`);
  return out;
}

module.exports = { queryMaterials, queryMaterialsGlobal, queryMaterialDetail, queryOrdersAC, queryZamPositions, queryProPositions, queryPlanMaterials, queryPlanZlecenieMap, fbQuery, testConnection, detectIndeksColumn, getTableColumns, clearCache, cacheStats, getPriceCorpus, getLastPzCorpus, estimateUnitPrice, similarityScore };
