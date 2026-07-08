# Weryfikacja stanów Lantek ↔ ERP

Mała aplikacja web: wgrywasz eksport **„Stan magazynowy"** z Lanteka (`.xlsx`), a narzędzie
porównuje stany magazynów Lantek (ML2, ML3, MO2, MO3) ze stanami w ERP (Rekord, Firebird DB
`EUROPA`) i pokazuje rozjazdy.

## Uruchomienie

```bash
copy config.example.json config.json   # i uzupelnij dane logowania do Firebird
npm install
npm start
```

> `config.json` (dane logowania) oraz pliki `*.xlsx` są w `.gitignore` i nie trafiają do repo.

Aplikacja: http://localhost:3066 — przeciągnij plik Excel na stronę.
Najprościej: dwuklik **`start.bat`** (instaluje zależności przy 1. uruchomieniu, dodaje regułę
zapory, otwiera przeglądarkę).

## Udostępnianie w sieci

Serwer nasłuchuje na wszystkich interfejsach (`0.0.0.0:3066`), więc jest dostępny dla innych
komputerów w tej samej sieci firmowej. Po starcie w oknie konsoli pojawia się adres do
udostępnienia, np. `http://192.168.0.44:3066` — wystarczy wysłać go współpracownikom.

Warunki:
- komputer-serwer musi być włączony i mieć uruchomioną aplikację (`start.bat`),
- w zaporze Windows musi być otwarty port **3066** — `start.bat` dodaje regułę automatycznie
  (przy pierwszym uruchomieniu **jako Administrator**; bez uprawnień wypisze ostrzeżenie),
- klient musi mieć dostęp do serwera Firebird tylko pośrednio — łączy się z serwerem, a ten
  z ERP; klienci nie potrzebują własnego dostępu do bazy.

## Jak liczy (model danych)

- **Poziom porównania:** `Magazyn + Indeks` (na razie **bez partii**).
  Indeks = kod „Produkt" z Lanteka obcięty do pierwszego `_` lub `-`
  (`MBLE2302000001_3000x1500` → `MBLE2302000001`, `MBST2300150001-CNA` → `MBST2300150001`).
- **Źródło ERP:** kartoteka stanów `M_KSM` + widok `MV_KSMILWA` (stan **bieżący `IL_BR`**
  i **księgowy `IL_KS`**), agregowane per partia do (magazyn, indeks). Nazwy z `M_KIMWSP`.
- **Jednostka porównania zależy od klasy materiału** (bo Lantek eksportuje wszystko w „szt",
  ale różne rzeczy fizycznie liczy się różnie):
  - **profile/pręty** (`JM='MB'`) → porównanie w **metrach bieżących (mb)**.
    Lantek mb = Σ(stan · Długość[mm]/1000), ERP mb = `IL_BR`/`IL_KS` wprost.
    (konwersja na sztuki jest stratna — odpady prętów mają różne długości, dawała fałszywe rozjazdy)
  - **arkusze** (`JM='M2'`) → porównanie w **sztukach**.
    Lantek szt = Σ stan, ERP szt = `stan_m² / (ATS_DLUGOSC·ATS_SZEROKOSC/1e6)` (dokładne dla całych arkuszy).
- **Używamy wyłącznie stanu bieżącego (`IL_BR`)** — księgowy (`IL_KS`) nie jest liczony.
- **Δ = Lantek − ERP** (w jednostce z kolumny „Jedn."). Δ > 0 → Lantek pokazuje więcej niż ERP.
- Tolerancja „zgodne": |Δ| < 0,5 jednostki **lub** < 0,5 % stanu ERP.
- Puste kartoteki (stan bieżący 0 w ERP) są pomijane — Lantek ich nie eksportuje.

## Statusy

| Status | Znaczenie |
|---|---|
| `ZGODNE` | Lantek = ERP (BR i KS) co do sztuki |
| `ROZJAZD` | różnica sztuk (BR lub KS) |
| `TYLKO_LANTEK` | pozycja jest w Lanteku, brak (stanu) w ERP |
| `TYLKO_ERP` | pozycja ma stan w ERP, brak w Lanteku |

`⚠` przy indeksie = w części partii ERP brak wymiaru → przelicznik na sztuki niepewny.

## Ograniczenia (v1)

- Porównanie na poziomie (magazyn, indeks) — bez rozbicia na konkretne partie/PZ (planowane).
- Kolumna „Lantek szt" jest poglądowa; dla profili miarodajne jest mb.
- Stany ERP są cache'owane 5 min. Przycisk **„↻ Odśwież stan ERP"** wymusza świeże pobranie.

## Pliki

- `server.js` — Express: serwuje UI + `POST /api/verify` (upload → JSON z porównaniem).
- `lib/erp.js` — połączenie z Firebird, pobranie i agregacja stanów ERP, przelicznik na szt.
- `lib/reconcile.js` — parser Excela z Lanteka + uzgodnienie z ERP.
- `public/index.html` — interfejs (upload, karty podsumowania, tabela z filtrami, eksport CSV).
- `config.json` — port + dane logowania Firebird + lista magazynów.
