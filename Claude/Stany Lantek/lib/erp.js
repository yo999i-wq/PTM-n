// Warstwa dostepu do ERP (Rekord, Firebird DB EUROPA).
// Pobiera stany magazynowe per partia z M_KSM + MV_KSMILWA i agreguje do (MAGAZYN, INDEKS).
const Firebird = require('node-firebird');

function makeOptions(cfg) {
  return {
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    lowercase_keys: false,
    encoding: 'UTF8'
  };
}

// Firebird DB EUROPA bywa niestabilne przy logowaniu ("user name and password are not defined").
// Ponawiamy kilka razy - to znany, przejsciowy blad puli.
function query(options, sql, params = []) {
  return new Promise((resolve, reject) => {
    Firebird.attach(options, (err, db) => {
      if (err) return reject(err);
      db.query(sql, params, (err, result) => {
        db.detach();
        if (err) return reject(err);
        resolve(result);
      });
    });
  });
}

async function queryRetry(options, sql, params = [], tries = 5) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await query(options, sql, params);
    } catch (e) {
      last = e;
      if (/user name and password/i.test(e.message || '') && i < tries - 1) {
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      throw e;
    }
  }
  throw last;
}

// Przelicznik ilosci ERP -> sztuki.
//  - arkusze (JM='M2'): stan w m2, sztuka = L*W/1e6 m2
//  - profile (JM='MB'): stan w metrach biezacych, sztuka = L/1000 m (dlugosc preta/odpadu)
// Zwraca null, gdy nie da sie policzyc (brak wymiaru przy stanie > 0).
function sztFromQty(qty, jm, L, W) {
  if (!qty) return 0;
  if (jm === 'M2') {
    const area = (L && W) ? (L * W / 1e6) : 0;
    return area > 0 ? qty / area : null;
  }
  if (jm === 'MB') {
    const unit = L ? L / 1000 : 0;
    return unit > 0 ? qty / unit : null;
  }
  // nieznana jednostka - traktujemy stan jako sztuki 1:1
  return qty;
}

const SQL_STANY = `
  SELECT TRIM(k.MAGAZYN) MAG, TRIM(k.INDEKS) INDEKS, TRIM(k.JM) JM,
         v.IL_BR, k.ATS_DLUGOSC L, k.ATS_SZEROKOSC W
  FROM M_KSM k
  JOIN MV_KSMILWA v
    ON v.MAGAZYN = k.MAGAZYN AND v.INDEKS = k.INDEKS
   AND v.NR_PARTII = k.NR_PARTII AND v.KON_MAT = k.KON_MAT
  WHERE k.MAGAZYN IN (@MAGS@)
`;

const SQL_NAZWY = `
  SELECT TRIM(INDEKS) INDEKS, TRIM(NAZWA) NAZWA
  FROM M_KIMWSP
  WHERE INDEKS IN (SELECT DISTINCT INDEKS FROM M_KSM WHERE MAGAZYN IN (@MAGS@))
`;

// Zwraca mape: "MAG|INDEKS" -> { mag, indeks, jm, nazwa, il_br, szt_br, partie, sztNiepewne }
// Uzywamy wylacznie stanu BIEZACEGO (IL_BR) - ksiegowy (IL_KS) pomijamy.
async function fetchErpStany(cfg) {
  const options = makeOptions(cfg.firebird);
  const mags = (cfg.magazyny || ['ML2', 'ML3', 'MO2', 'MO3']);
  const inList = mags.map(m => `'${m.replace(/'/g, "''")}'`).join(',');

  const rows = await queryRetry(options, SQL_STANY.replace('@MAGS@', inList));
  const nazwy = await queryRetry(options, SQL_NAZWY.replace('@MAGS@', inList));
  const nazwaMap = {};
  nazwy.forEach(n => { nazwaMap[n.INDEKS] = n.NAZWA; });

  const agg = {};
  for (const r of rows) {
    const key = r.MAG + '|' + r.INDEKS;
    let a = agg[key];
    if (!a) {
      a = agg[key] = {
        mag: r.MAG, indeks: r.INDEKS, jm: r.JM, nazwa: nazwaMap[r.INDEKS] || '',
        il_br: 0, szt_br: 0, partie: 0, sztNiepewne: false
      };
    }
    a.il_br += r.IL_BR || 0;
    a.partie++;
    const sb = sztFromQty(r.IL_BR, r.JM, r.L, r.W);
    if (sb == null) a.sztNiepewne = true;
    else a.szt_br += sb;
  }
  const out = {};
  for (const [key, a] of Object.entries(agg)) {
    a.il_br = round(a.il_br, 3);
    a.szt_br = Math.round(a.szt_br);
    // Pomijamy puste kartoteki (stan biezacy zerowy) - Lantek ich nie eksportuje,
    // wiec nie sa realnym rozjazdem, tylko szumem z historycznych partii.
    if (a.il_br === 0) continue;
    out[key] = a;
  }
  return out;
}

function round(n, d) { const p = Math.pow(10, d); return Math.round(n * p) / p; }

module.exports = { fetchErpStany, sztFromQty };
