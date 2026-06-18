# MRP Browser — Europa Systems

Przeglądarka materiałów MRP z powiązaniami do przewodników produkcji.
Połączenie bezpośrednie z bazą Firebird (Rekord).

## Szybki start

```
1. install.bat       ← instaluje node-firebird (raz)
2. START.bat         ← uruchamia serwer
3. http://localhost:5300
```

## Konfiguracja (config.js)

```js
firebird: {
  host:     '192.168.0.101',   // IP serwera Firebird
  port:     3050,
  database: 'EUROPA',
  user:     'PBI',
  password: 'POWERBI',
}
```

## Jak używać

### Filtr po zleceniu
- **Kat ZO** — kategoria zlecenia (np. `PRO`)
- **Rok** — rok zlecenia (np. `2024`)
- **Symbol ZO** — symbol zlecenia (np. `00401`)
- **LP** — pozycja zlecenia (opcjonalnie)
- Kliknij **▶ Pobierz**

### Filtr tekstowy
- Pole **Szukaj** — wyszukuje po indeksie lub nazwie materiału
- Działa samodzielnie (bez filtra zlecenia) — wpisz min. 2 znaki
- Można połączyć oba filtry

### Panel szczegółów
- Kliknij dowolny wiersz w tabeli
- Wyświetli się panel z powiązaniami materiału z przewodnikami

## Kolorowanie wierszy

### Tabela główna
| Kolor | Znaczenie |
|-------|-----------|
| 🔴 Czerwony | BRAKUJE < 0 — niedobór materiału |
| 🟡 Żółty | BRAKUJE ≥ 0 ale < 5 — ostrzeżenie |
| Biały | Stan prawidłowy |

### Panel szczegółów (powiązania)
| Kolor | Typ | Znaczenie |
|-------|-----|-----------|
| 🔵 Niebieski | PRO | Rozchód na przewodnik (RODZAJ = "R") |
| 🟢 Zielony | ZAM | Zamówienie własne (RODZAJ = "W") |
| ⚫ Szary | MAG | Stan magazynowy / bilans |
| 🟣 Fioletowy | NP | Niepotwierdzony termin (PRZYCH_NP lub ROZCHOD_NP ≠ 0) |

## API

```
GET /api/materials?kat=PRO&rok=2024&symb=00401   → lista materiałów
GET /api/materials?search=BLACHA                  → szukaj tekstowo
GET /api/detail?indeks=MBLE2303000001&kodLokal=01 → szczegóły materiału
GET /api/test                                      → test połączenia FB
```

## Zapytania SQL

### Query 1 — lista materiałów (M_KSM_MRP)
Pobiera dane z M_KSM_MRP + M_KIMWSP + M_KIMMAG.
Opcjonalny filtr po zleceniu przez JOIN do M_PRZEWOD_SK.

**Kolumna INDEKS w M_PRZEWOD_SK:**
Jeśli filtr po zleceniu zwraca błąd kolumny INDEKS, sprawdź rzeczywistą
nazwę kolumny z indeksem składowej w tabeli M_PRZEWOD_SK i popraw
w `src/fb-mrp.js` (szukaj: `PS.INDEKS`).

### Query 2 — szczegóły materiału (MP_KSMMRP_SZCZLOK)
Wywołuje stored procedure: `MP_KSMMRP_SZCZLOK(INDEKS, KOD_LOKAL)`
Zwraca dokumenty powiązane z materiałem:
- Stany magazynowe (MAG)
- Rozchody na przewodniki (PRO)  
- Zamówienia własne (ZAM)
- Niepotwierdzony przychód/rozchód (NP)

## Troubleshooting

**Błąd połączenia FB:**
```
Sprawdź: config.js → host, port, database, user, password
Test:    http://localhost:5300/api/test
```

**Filtr zlecenia nie działa / pusty wynik:**
```
Możliwe że M_PRZEWOD_SK.INDEKS to inny name kolumny.
Sprawdź schemat: SELECT RDB$FIELD_NAME FROM RDB$RELATION_FIELDS
                 WHERE RDB$RELATION_NAME = 'M_PRZEWOD_SK'
Popraw w src/fb-mrp.js (szukaj: PS.INDEKS)
```

**MP_KSMMRP_SZCZLOK — błąd procedury:**
```
Sprawdź czy procedura istnieje i ma te same parametry.
Zamiennik: Można napisać własne zapytanie SQL bez stored proc.
```

## Struktura plików

```
mrp-browser/
├── config.js          ← konfiguracja Firebird + limity
├── server.js          ← serwer HTTP + REST API (port 5300)
├── src/
│   └── fb-mrp.js      ← zapytania Firebird
├── public/
│   └── index.html     ← SPA (cały frontend)
├── install.bat        ← instalacja npm
└── START.bat          ← uruchomienie
```
