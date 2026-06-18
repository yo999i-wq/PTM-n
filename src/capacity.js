// ============================================================
// CAPACITY.JS — Zdolności produkcyjne (gniazda) dla MRP Browser
// Źródło obciążenia: Firebird M_PRZEWOD_OP (operacje przewodników).
// Mapowanie grup stanowisk → gniazdo: słownik przeniesiony z projektu
// "Realizacja 3.0" (frontend/src/utils/groupCategories.js).
// ============================================================

const fs   = require('fs');
const path = require('path');
const { fbQuery } = require('./fb-mrp');

// ── Słownik: szczegółowa grupa stanowisk (GRUPA_ST) → gniazdo nadrzędne ──
const GROUP_CATEGORIES = {
  GIL:'ROL', GW1:'ROL', GW2:'ROL', HYD:'ROL', PCV:'ROL', PRAM1:'ROL', PRAM2:'ROL', PRMAN:'ROL',
  PRSD:'ROL', PRSM:'ROL', RYL:'ROL', SKFROL:'ROL', SPAROL:'ROL', STP:'ROL', SZLOS:'ROL',
  TOKOD:'ROL', TOKOM:'ROL', ZAB:'ROL', ZEG:'ROL', ZKO:'ROL',
  GAMM:'CNC', TOKC:'CNC', TOKR1:'CNC', TOKR2:'CNC',
  SP:'SPAW', SPG:'SPAW', SPHD:'SPAW', SPL:'SPAW', SPN:'SPAW', SPTZ:'SPAW', SPU:'SPAW', SPW:'SPAW', ZG:'SPAW', ZGR:'SPAW',
  PIL:'PIL', PILD:'PIL', PILCNC:'PIL',
  CCNC:'CNCF', FRER:'CNCF', FREM:'CNCF', FREMU:'CNCF', FREBLO:'CNCF', FREGLO:'CNCF', FRERLO:'CNCF', FREY:'CNCF',
  LAS2D:'LAS2D', GILB:'LAS2D',
  LAS3D:'LAS3D',
  GIEB:'GIEB', GIEP:'GIEB',
  SZLIF:'SZLIF',
  MAL:'MAL', MYC:'MAL',
  WYS:'WYS', POW:'POW',
  MON:'MON', MONBD:'MON', MONEL:'MON', MONHD:'MON', MONI:'MON', MONMB:'MON', MONSL:'MON', MONW:'MON', MPDT:'MON', MPD1:'MON',
  MAG:'HIDDEN', MAG2:'HIDDEN',
  SPR:'SPR', PAK:'PAK',
};
// Kod operacji nadpisuje mapowanie po grupie (priorytet) — tak jak w Realizacja 3.0
const OPER_CATEGORIES = { PILCNC:'PIL', PILD:'PIL', PIL:'PIL' };

// Zdefiniowane gniazda produkcyjne (kolejność jak w widoku). Tylko te emitujemy.
// WYS (wysyłka), POW (powłoki) i PAK (pakowanie) to operacje logistyczno-wykończeniowe,
// nie gniazda produkcyjne — pomijane. Niezmapowane (SLUS, PUK, SPC, PROD…) też.
const GNIAZDA = ['PIL','LAS3D','LAS2D','GIEB','CNC','CNCF','ROL','SPAW','SZLIF','SPR','MAL','MON'];
const GNIAZDA_SET = new Set(GNIAZDA);

function catFor(grupaSt, kodOper) {
  if (kodOper && OPER_CATEGORIES[kodOper]) return OPER_CATEGORIES[kodOper];
  return GROUP_CATEGORIES[grupaSt] || grupaSt;
}

// ── Numer tygodnia ISO-8601 (zgodny z firebirdowym EXTRACT(WEEK ...)) ──
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = (t.getUTCDay() + 6) % 7;          // pon=0 … nd=6
  t.setUTCDate(t.getUTCDate() - day + 3);        // czwartek tego tygodnia
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((t - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
}
// Klucz kolumny spójny z SQL: EXTRACT(YEAR) + EXTRACT(WEEK) = rok kalendarzowy + tydzień ISO
function weekKey(d) { return `${d.getFullYear()}-W${String(isoWeek(d)).padStart(2, '0')}`; }

// Lista kolejnych tygodni (klucze) od dziś na `weeks` tygodni do przodu
function forwardWeeks(weeks) {
  const out = [], seen = new Set();
  const start = new Date(); start.setHours(0, 0, 0, 0);
  for (let i = 0; i <= weeks * 7; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    const k = weekKey(d);
    if (!seen.has(k)) { seen.add(k); out.push(k); }
  }
  return out;
}

// ── Konfiguracja gniazd + kalendarza (capacity.config.json) ──
const CONFIG_PATH = path.join(__dirname, '..', 'capacity.config.json');

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}
function writeConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.gniazda) || !cfg.kalendarz)
    throw new Error('Nieprawidłowa konfiguracja (wymagane: kalendarz, gniazda[])');
  if (!Array.isArray(cfg.wyjatki)) cfg.wyjatki = [];
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  return true;
}

// ── Obciążenie [h] per gniazdo × tydzień (agregat w Firebird) ──
// Cache krótkoterminowy — by nie skanować M_PRZEWOD_OP przy każdym żądaniu.
let _cache = null, _cacheKey = '', _cacheExp = 0;

async function queryCapacityLoad(weeks) {
  const w = Math.max(1, Math.min(parseInt(weeks, 10) || 12, 53));
  const key = 'cap|' + w;
  const now = Date.now();
  if (_cache && _cacheKey === key && _cacheExp > now) return _cache;

  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end   = new Date(start.getTime() + w * 7 * 86400000);

  // Daty jako parametry (?) — niezależne od dialektu SQL i bezpieczne.
  // TJ_MASZ / TJ_PRAC = czas całej operacji (h); pozostała praca = ×(1−ZAAWANS/100).
  const rows = await fbQuery(
    `SELECT TRIM(GRUPA_ST) AS G, TRIM(KOD_OPER) AS O,
            EXTRACT(YEAR FROM HARM_START) AS Y, EXTRACT(WEEK FROM HARM_START) AS W,
            SUM((TPZ + TJ_MASZ) * (1 - ZAAWANS/100.0)) AS LM,
            SUM((TPZ + TJ_PRAC) * (1 - ZAAWANS/100.0)) AS LP
     FROM M_PRZEWOD_OP
     WHERE ZAAWANS < 100 AND HARM_START >= ? AND HARM_START <= ?
     GROUP BY 1, 2, 3, 4`,
    [start, end], 90000
  );

  const weekCols = forwardWeeks(w);
  const weekSet  = new Set(weekCols);
  const load = {};                              // gniazdo -> { weekKey: {maszyna, praca} }
  for (const g of GNIAZDA) { load[g] = {}; for (const k of weekCols) load[g][k] = { maszyna: 0, praca: 0 }; }

  for (const r of rows) {
    const g = catFor((r.G || '').trim(), (r.O || '').trim());
    if (!GNIAZDA_SET.has(g)) continue;          // tylko 15 zdefiniowanych
    const k = `${r.Y}-W${String(r.W).padStart(2, '0')}`;
    if (!weekSet.has(k)) continue;              // poza oknem (skraje ISO/rok)
    const cell = load[g][k];
    cell.maszyna += Number(r.LM) || 0;
    cell.praca   += Number(r.LP) || 0;
  }
  // zaokrąglij
  for (const g of GNIAZDA) for (const k of weekCols) {
    load[g][k].maszyna = Math.round(load[g][k].maszyna * 10) / 10;
    load[g][k].praca   = Math.round(load[g][k].praca   * 10) / 10;
  }

  const result = { ok: true, weeks: weekCols, gniazda: GNIAZDA, load, generatedAt: new Date().toISOString() };
  _cache = result; _cacheKey = key; _cacheExp = now + 5 * 60 * 1000;   // 5 min
  return result;
}

function clearCapacityCache() { _cache = null; _cacheExp = 0; }

// Poniedziałek (UTC) tygodnia ISO — odwrotność isoWeek
function mondayOfIsoWeek(year, week) {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = (jan4.getUTCDay() + 6) % 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - jan4Dow + (week - 1) * 7);
  return monday;
}

// ── Drill-down: operacje danego gniazda w danym tygodniu ─────
function _fmtTs(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d) ? null : d.toISOString().slice(0, 16).replace('T', ' ');
}

async function queryCapacityOps(gniazdo, week) {
  if (!GNIAZDA_SET.has(gniazdo)) throw new Error('Nieznane gniazdo: ' + gniazdo);
  const m = /^(\d{4})-W(\d{1,2})$/.exec(week || '');
  if (!m) throw new Error('Nieprawidłowy tydzień (oczekiwano RRRR-Wnn)');
  const monday = mondayOfIsoWeek(parseInt(m[1], 10), parseInt(m[2], 10));
  const start  = new Date(monday.getTime());                 // pon 00:00
  const end    = new Date(monday.getTime() + 7 * 86400000);  // kolejny pon 00:00

  let basis = 'maszyna';
  try { const g = readConfig().gniazda.find(x => x.id === gniazdo); if (g && g.podstawaMocy) basis = g.podstawaMocy; } catch (_) {}

  const rows = await fbQuery(
    `SELECT TRIM(KAT_ZLEC) AS KAT, ROK_ZLEC AS ROK, TRIM(SYMB_ZLEC) AS SYMB, TRIM(LP_ZLEC) AS LPZ,
            TRIM(NR_PRZEW) AS NRP, LP AS LP, TRIM(KOD_OPER) AS KOD, TRIM(GRUPA_ST) AS G,
            ZAAWANS, TPZ, TJ_MASZ, TJ_PRAC, HARM_START, HARM_KONIEC, TRIM(OPIS) AS OPIS
     FROM M_PRZEWOD_OP
     WHERE ZAAWANS < 100 AND HARM_START >= ? AND HARM_START < ?`,
    [start, end], 60000
  );

  const out = [];
  for (const r of rows) {
    if (catFor((r.G || '').trim(), (r.KOD || '').trim()) !== gniazdo) continue;
    const frac = 1 - (Number(r.ZAAWANS) || 0) / 100;
    const hMasz = ((Number(r.TPZ) || 0) + (Number(r.TJ_MASZ) || 0)) * frac;
    const hPrac = ((Number(r.TPZ) || 0) + (Number(r.TJ_PRAC) || 0)) * frac;
    out.push({
      zlecenie: `${(r.KAT || '').trim()}-${r.ROK}-${(r.SYMB || '').trim()}-${(r.LPZ || '').trim()}`,
      nrPrzew: (r.NRP || '').trim(), lp: Number(r.LP) || 0,
      kodOper: (r.KOD || '').trim(), grupaSt: (r.G || '').trim(),
      opis: ((r.OPIS || '').trim()) || null,
      zaawans: Math.round((Number(r.ZAAWANS) || 0) * 10) / 10,
      hMasz: Math.round(hMasz * 100) / 100, hPrac: Math.round(hPrac * 100) / 100,
      start: _fmtTs(r.HARM_START), koniec: _fmtTs(r.HARM_KONIEC),
    });
  }
  const keyH = basis === 'praca' ? 'hPrac' : 'hMasz';
  out.sort((a, b) => b[keyH] - a[keyH]);
  const sumH = out.reduce((s, o) => s + o[keyH], 0);
  return { ok: true, gniazdo, week, basis, count: out.length, shown: Math.min(out.length, 300), sumH: Math.round(sumH * 10) / 10, ops: out.slice(0, 300) };
}

module.exports = {
  GNIAZDA, GROUP_CATEGORIES, OPER_CATEGORIES, catFor,
  readConfig, writeConfig, queryCapacityLoad, queryCapacityOps, clearCapacityCache,
};
