// Parsowanie Excela z Lanteka ("Stan magazynowy" -> arkusz "Struktura")
// i uzgodnienie ze stanami ERP.
//
// Jednostka porownania zalezy od klasy materialu (wg JM w ERP):
//   - PROFILE (JM='MB'): porownanie w METRACH BIEZACYCH.
//       Lantek mb = suma(stan * Dlugosc[mm]/1000), ERP mb = IL_BR/IL_KS wprost.
//       (konwersja na sztuki jest stratna - odpady pretow maja rozne dlugosci)
//   - ARKUSZE (JM='M2'): porownanie w SZTUKACH.
//       Lantek szt = suma(stan), ERP szt = IL / pole_arkusza (dokladne dla calych arkuszy).
const XLSX = require('xlsx');

function indeksFromProdukt(prod) {
  return String(prod).split(/[_-]/)[0].trim();
}

function findCol(headers, name) {
  const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const target = norm(name);
  for (let i = 0; i < headers.length; i++) {
    if (norm(headers[i]) === target) return i;
  }
  return -1;
}

function parseLantek(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = wb.SheetNames.includes('Struktura') ? 'Struktura' : wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  if (!grid.length) throw new Error('Pusty arkusz Excela');

  const headers = grid[0];
  const col = {
    mag: findCol(headers, 'Magazyn'),
    prod: findCol(headers, 'Produkt'),
    stan: findCol(headers, 'Stan magazynowy'),
    zarez: findCol(headers, 'Zarezerwowane'),
    dost: findCol(headers, 'Dostępne'),
    dlugosc: findCol(headers, 'Długość'), // pierwsza kolumna "Długość" = dlugosc preta/odpadu [mm]
    material: findCol(headers, 'Materiał'),
    grubosc: findCol(headers, 'Grubość'),
    klasa: findCol(headers, 'Klasa')
  };
  if (col.mag < 0 || col.prod < 0 || col.stan < 0) {
    throw new Error('Nie znaleziono wymaganych kolumn (Magazyn / Produkt / Stan magazynowy). To nie jest eksport "Stan magazynowy" z Lanteka?');
  }

  const num = v => (typeof v === 'number' ? v : (v == null || v === '' ? 0 : Number(v) || 0));
  const agg = {};
  let wierszy = 0;
  for (let i = 1; i < grid.length; i++) {
    const row = grid[i];
    if (!row) continue;
    const mag = row[col.mag];
    const prod = row[col.prod];
    if (!mag || !prod) continue;
    wierszy++;
    const indeks = indeksFromProdukt(prod);
    const key = mag + '|' + indeks;
    let a = agg[key];
    if (!a) {
      a = agg[key] = {
        mag: String(mag).trim(), indeks, szt: 0, mb: 0, zarez: 0, dost: 0, pozycji: 0,
        material: col.material >= 0 ? row[col.material] : null,
        grubosc: col.grubosc >= 0 ? row[col.grubosc] : null,
        klasa: col.klasa >= 0 ? row[col.klasa] : null,
        przyklad: String(prod).trim()
      };
    }
    const stan = num(row[col.stan]);
    a.szt += stan;
    if (col.dlugosc >= 0) a.mb += stan * (num(row[col.dlugosc]) / 1000);
    if (col.zarez >= 0) a.zarez += num(row[col.zarez]);
    if (col.dost >= 0) a.dost += num(row[col.dost]);
    a.pozycji++;
  }
  return { agg, wierszy, sheetName };
}

// Czy dwie wartosci uznajemy za zgodne (tolerancja: 0.5 jednostki albo 0.5% wartosci ERP).
function zgodne(delta, erpVal) {
  if (delta == null) return false;
  if (Math.abs(delta) < 0.5) return true;
  if (erpVal && Math.abs(delta) / Math.abs(erpVal) < 0.005) return true;
  return false;
}

function reconcile(lantekAgg, erpAgg) {
  const keys = new Set([...Object.keys(lantekAgg), ...Object.keys(erpAgg)]);
  const wiersze = [];
  const sum = { obie: 0, tylkoLantek: 0, tylkoErp: 0, zgodne: 0, rozjazd: 0, sztNiepewne: 0 };

  for (const k of keys) {
    const l = lantekAgg[k];
    const e = erpAgg[k];

    // jednostka porownania: MB dla profili, SZT dla arkuszy
    const jm = e ? e.jm : (l && /arkusz/i.test(l.klasa || '') ? 'M2' : 'MB');
    const unit = jm === 'MB' ? 'mb' : 'szt';

    // wartosci porownywane w wybranej jednostce (stan BIEZACY - ksiegowego nie liczymy)
    const lantekVal = l ? (unit === 'mb' ? round(l.mb, 2) : Math.round(l.szt)) : null;
    const erpBr = e ? (unit === 'mb' ? round(e.il_br, 2) : e.szt_br) : null;

    let status;
    if (l && e) sum.obie++;
    else if (l) { sum.tylkoLantek++; status = 'TYLKO_LANTEK'; }
    else { sum.tylkoErp++; status = 'TYLKO_ERP'; }

    const dBr = (lantekVal != null && erpBr != null) ? round(lantekVal - erpBr, 2) : null;

    if (!status) {
      const zg = zgodne(dBr, erpBr);
      status = zg ? 'ZGODNE' : 'ROZJAZD';
      if (zg) sum.zgodne++; else sum.rozjazd++;
    } else {
      sum.rozjazd++;
    }
    if (e && e.sztNiepewne && unit === 'szt') sum.sztNiepewne++;

    wiersze.push({
      mag: (l || e).mag,
      indeks: (l || e).indeks,
      nazwa: e ? e.nazwa : (l ? (l.material || '') : ''),
      klasa: l ? l.klasa : (jm === 'M2' ? 'Arkusz' : 'Profil'),
      jedn: unit,
      lantek: lantekVal,
      erp_br: erpBr,
      d_br: dBr,
      lantek_szt: l ? Math.round(l.szt) : null,
      erp_partie: e ? e.partie : null,
      lantek_dost: l ? Math.round(l.dost) : null,
      lantek_pozycji: l ? l.pozycji : null,
      szt_niepewne: e ? (!!e.sztNiepewne && unit === 'szt') : false,
      status
    });
  }

  wiersze.sort((a, b) => {
    const rank = s => (s === 'ROZJAZD' || s === 'TYLKO_LANTEK' || s === 'TYLKO_ERP') ? 0 : 1;
    if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
    // sortuj wg wzglednego rozjazdu, zeby duze % byly na gorze niezaleznie od jednostki
    const rel = r => {
      if (r.d_br == null) return 9e9;
      const base = Math.abs(r.erp_br) || Math.abs(r.lantek) || 1;
      return Math.abs(r.d_br) / base;
    };
    return rel(b) - rel(a);
  });

  return { wiersze, sum };
}

function round(n, d) { const p = Math.pow(10, d); return Math.round(n * p) / p; }

module.exports = { parseLantek, reconcile, indeksFromProdukt };
