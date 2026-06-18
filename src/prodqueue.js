// ============================================================
// PRODQUEUE.JS — Priorytety produkcji (ręczna kolejka zleceń)
// Czyta zlecenia „W produkcji" z Firebird M_ZLECENIA (poziom
// KAT-ROK-SYMBOL, pozycje LP zgrupowane). Kolejkę z ręcznymi
// priorytetami trzyma lokalnie w prod-queue.json (ERP tylko odczyt).
// ============================================================

const fs   = require('fs');
const path = require('path');
const { fbQuery, queryMaterials } = require('./fb-mrp');

const QUEUE_PATH = path.join(__dirname, '..', 'prod-queue.json');

function trim(v) { return v == null ? '' : String(v).trim(); }
function num(v)  { if (v == null) return null; const n = Number(v); return isNaN(n) ? null : Math.round(n * 100) / 100; }
function toDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

// ── Kolejka (lokalny plik) ───────────────────────────────────
function readQueue() {
  try { const q = JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8')); return Array.isArray(q.items) ? q : { items: [] }; }
  catch (e) { return { items: [] }; }
}
function writeQueue(data) {
  if (!data || !Array.isArray(data.items)) throw new Error('Nieprawidłowa kolejka (wymagane items[])');
  const clean = {
    items: data.items.map(it => ({
      kat: trim(it.kat), rok: parseInt(it.rok, 10) || 0, symb: trim(it.symb),
      nr: trim(it.nr) || `${trim(it.kat)}-${parseInt(it.rok, 10) || 0}-${trim(it.symb)}`,
      nazwa: trim(it.nazwa), klient: trim(it.klient), termin: it.termin || null,
      priorytet: Number(it.priorytet) || 0, notatka: trim(it.notatka),
    })).filter(it => it.kat && it.symb),
  };
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(clean, null, 2), 'utf8');
  return clean.items.length;
}

// ── Wyszukiwarka zleceń „W produkcji" (zgrupowane KAT-ROK-SYMBOL) ──
async function searchProdOrders(q) {
  q = trim(q);
  if (q.length < 2) return [];

  // Pełny numer „KAT-ROK-SYMBOL" → dopasuj części (bez sklejania w SQL — dialekt 1)
  const m = /^([A-Za-z]{2,4})-(\d{4})-(.+)$/.exec(q);
  let where, params;
  if (m) {
    where  = `TRIM(STATUS)='W produkcji' AND UPPER(TRIM(KATEGORIA))=? AND ROK_ZAM=? AND UPPER(TRIM(SYMBOL_ZAM)) LIKE ?`;
    params = [m[1].toUpperCase(), parseInt(m[2], 10), '%' + m[3].toUpperCase() + '%'];
  } else {
    const s = '%' + q.toUpperCase() + '%';
    where  = `TRIM(STATUS)='W produkcji' AND (UPPER(TRIM(SYMBOL_ZAM)) LIKE ? OR UPPER(TRIM(NAZWA)) LIKE ?)`;
    params = [s, s];
  }

  const rows = await fbQuery(
    `SELECT FIRST 25 TRIM(KATEGORIA) AS K, ROK_ZAM AS R, TRIM(SYMBOL_ZAM) AS S,
            MAX(TRIM(NAZWA)) AS NAZWA, MAX(TRIM(NR_KLIENTA)) AS KLIENT,
            MIN(TERMIN_WYK) AS TMIN, COUNT(*) AS POZ,
            SUM(ILOSC_ZLEC) AS ILZ, SUM(ILOSC_WYKON) AS ILW, MAX(PRIORYTET) AS PR
     FROM M_ZLECENIA WHERE ${where}
     GROUP BY KATEGORIA, ROK_ZAM, SYMBOL_ZAM
     ORDER BY MIN(TERMIN_WYK)`,
    params, 20000
  );

  const out = rows.map(r => ({
    kat: trim(r.K), rok: Number(r.R), symb: trim(r.S),
    nr: `${trim(r.K)}-${r.R}-${trim(r.S)}`,
    nazwa: trim(r.NAZWA), klientSymbol: trim(r.KLIENT), klient: trim(r.KLIENT),
    termin: toDate(r.TMIN),
    pozycje: Number(r.POZ) || 0, iloscZlec: num(r.ILZ), iloscWyk: num(r.ILW),
    priorytetErp: r.PR != null ? Number(r.PR) : null,
  }));

  // Nazwy klientów z M_KONTRAH_GL
  const syms = [...new Set(out.map(o => o.klientSymbol).filter(Boolean))];
  if (syms.length) {
    try {
      const kr = await fbQuery(
        `SELECT TRIM(SYMBOL) AS SYM, TRIM(NAZWA) AS NAZWA FROM M_KONTRAH_GL WHERE TRIM(SYMBOL) IN (${syms.map(() => '?').join(',')})`,
        syms, 10000
      );
      const km = new Map(kr.map(k => [trim(k.SYM), trim(k.NAZWA)]));
      for (const o of out) o.klient = km.get(o.klientSymbol) || o.klientSymbol;
    } catch (e) { /* zostaw symbol */ }
  }
  return out;
}

// ── Wartość braków materiałowych [PLN] per zlecenie ──────────
// Ta sama logika co „Σ braki" w widoku głównym: dla każdego materiału zlecenia
// braki = |stanil + iloscR| × cenaJedn × kurs (gdy stan po zleceniu < 0).
// Korzysta z queryMaterials (cache 5 min), kursy przekazuje wywołujący (NBP).
async function queryOrdersBraki(orders, rates) {
  rates = rates || {};
  const rate = w => (!w || w === 'PLN') ? 1 : (rates[w] > 0 ? rates[w] : null);
  const list = (orders || []).filter(o => o && trim(o.kat) && trim(o.symb));
  const out = {};
  const CONC = 2;                                   // ostrożnie — pool=6, queryMaterials sam jest równoległy
  for (let i = 0; i < list.length; i += CONC) {
    const chunk = list.slice(i, i + CONC);
    await Promise.all(chunk.map(async o => {
      const nr = `${trim(o.kat)}-${parseInt(o.rok, 10) || 0}-${trim(o.symb)}`;
      try {
        const mats = await queryMaterials({ kat: trim(o.kat).toUpperCase(), rok: String(o.rok || ''), symb: trim(o.symb) });
        let braki = 0, poz = 0, niewycenione = 0;
        for (const r of mats) {
          const spz = (r.stanil || 0) + (r.iloscR || 0);
          if (spz >= 0) continue;                   // brak niedoboru
          const price = r.cenaJedn || 0;
          const rt = rate(r.cenaJednWaluta || 'PLN');
          if (!price || rt == null) { niewycenione++; continue; }
          braki += Math.abs(spz) * price * rt;
          poz++;
        }
        out[nr] = { brakiPln: Math.round(braki), poz, niewycenione };
      } catch (e) {
        out[nr] = { error: e.message };
      }
    }));
  }
  return out;
}

module.exports = { searchProdOrders, readQueue, writeQueue, queryOrdersBraki };
