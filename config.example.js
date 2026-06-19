// ============================================================
// KONFIGURACJA - MRP BROWSER (przykład)
// Skopiuj ten plik do config.js i uzupełnij dane połączenia z bazą.
// ============================================================

module.exports = {

  // --- PORT SERWERA ---
  port: 5350,

  // --- POLACZENIE Z FIREBIRDEM (Rekord) ---
  firebird: {
    host:     'YOUR_FIREBIRD_HOST',   // IP serwera Firebird, np. 192.168.0.101
    port:     3050,
    database: 'YOUR_DATABASE',        // np. EUROPA
    user:     'YOUR_USER',
    password: 'YOUR_PASSWORD',
  },

  // --- LIMITY ---
  maxMaterials: 5000,   // maks wierszy w głównej tabeli
  maxDetail:    2000,   // maks wierszy w szczegółach materiału

  // --- CACHE (bufor wyników po stronie serwera) ---
  cacheTtlSec: 300,     // czas życia wpisu w cache (sekundy), domyślnie 5 min

  // --- DOMYSLNY FILTR ZLECEN ---
  defaultKat: 'PRO',

};
