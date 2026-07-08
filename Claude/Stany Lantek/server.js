const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { fetchErpStany } = require('./lib/erp');
const { parseLantek, reconcile } = require('./lib/reconcile');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

app.use(express.static(path.join(__dirname, 'public')));

// Prosty cache stanow ERP (kosztowne zapytanie do Firebird). TTL 5 min.
let erpCache = { data: null, ts: 0 };
const ERP_TTL = 5 * 60 * 1000;

async function getErp(force) {
  if (!force && erpCache.data && (Date.now() - erpCache.ts) < ERP_TTL) return erpCache.data;
  const data = await fetchErpStany(cfg);
  erpCache = { data, ts: Date.now() };
  return data;
}

app.post('/api/verify', upload.single('plik'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Brak pliku. Wgraj eksport "Stan magazynowy" z Lanteka (.xlsx).' });
    const force = req.query.refresh === '1' || req.body.refresh === '1';
    const { agg: lantekAgg, wierszy, sheetName } = parseLantek(req.file.buffer);
    const erpAgg = await getErp(force);
    const { wiersze, sum } = reconcile(lantekAgg, erpAgg);
    res.json({
      ok: true,
      plik: req.file.originalname,
      arkusz: sheetName,
      wierszyExcel: wierszy,
      magazyny: cfg.magazyny,
      erpTs: erpCache.ts,
      erpZindeksow: Object.keys(erpAgg).length,
      podsumowanie: sum,
      wiersze
    });
  } catch (e) {
    console.error('verify error:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/api/erp/refresh', async (req, res) => {
  try { await getErp(true); res.json({ ok: true, ts: erpCache.ts, zindeksow: Object.keys(erpCache.data).length }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.get('/api/health', (req, res) => res.json({ ok: true, erpCache: erpCache.ts }));

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

const port = cfg.port || 3066;
const server = app.listen(port, '0.0.0.0', () => {
  console.log('\n========================================================');
  console.log('  Stany Lantek - aplikacja uruchomiona');
  console.log('========================================================');
  console.log(`  Ten komputer:        http://localhost:${port}`);
  const lan = lanAddresses();
  if (lan.length) {
    console.log('  Udostepnij wspolpracownikom (ta sama siec):');
    lan.forEach(ip => console.log(`      >>>  http://${ip}:${port}`));
  } else {
    console.log('  (nie wykryto adresu sieciowego LAN)');
  }
  console.log('========================================================\n');
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[!] Port ${port} jest juz zajety - aplikacja prawdopodobnie juz dziala.`);
    console.error(`    Otworz w przegladarce: http://localhost:${port}`);
    console.error(`    (albo zamknij poprzednie okno serwera i uruchom ponownie).\n`);
  } else {
    console.error('Blad serwera:', err.message);
  }
  process.exit(1);
});
