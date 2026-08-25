# CFM ↔ Feishu Base (bez uprawnień admina) — konfiguracja

Ta ścieżka **nie wymaga tworzenia „custom app"** w konsoli deweloperskiej
Feishu ani żadnych uprawnień administratora. Wystarczy zwykłe konto firmowe.

```
CFM_raport_dzienny.html  --->  Twój VPS (relay.php/relay.js)  --->  Automatyzacja webhook w Feishu Base
   (telefon operatora)          (tylko przekazuje POST dalej)         (Twoja Baza)
```

**Ograniczenie do zaakceptowania:** ta ścieżka pozwala tylko **zapisywać**
dane do Feishu. Statystyki w aplikacji („Dziś", „Ostatni wpis", bufor
reworku) pokazują dane **z tego konkretnego telefonu** — nie sumują danych
z innych operatorów/urządzeń na żywo. Do zbiorczego przeglądu (wszystkie
stanowiska, wszyscy operatorzy) otwórz samą Bazę w Feishu — tam masz pełne
widoki i sumy.

## 1. Utwórz Bazę (多维表格) w Feishu

1. W Feishu: **+ Nowy** → **Baza** (多维表格). Nazwij np. „CFM Dane Produkcyjne".
2. Wewnątrz utwórz **4 tabele** (zakładki), każda z podanymi kolumnami:

### Tabela `RaportDzienny`
```
timestamp | date | shift | station | operator | qty | scrap | rework | recovered | ok_count | pass_rate | notes
```

### Tabela `PrzyczynyJakosc`
```
timestamp | date | shift | station | operator | category | reason | qty
```

### Tabela `Awarie`
```
event | station | type | timestamp | start_timestamp | koniec_timestamp | czas_min
```

### Tabela `ReworkProcessing`
```
timestamp | date | zone | processed | recovered | final_scrap | note | notes
```

## 2. Utwórz automatyzację webhook dla każdej tabeli

Dla **każdej** z 4 tabel osobno:

1. Otwórz tabelę → w lewym dolnym rogu Bazy kliknij **„Workflow" / „工作流"**.
2. **Nowa automatyzacja** → wyzwalacz: **„Gdy odebrano webhook" / „接收到 webhook 时"**.
3. Akcja: **„Dodaj rekord"** w tej tabeli.
4. Zmapuj pola webhooka na kolumny tabeli (nazwy pól w JSON dokładnie
   odpowiadają nazwom kolumn wyżej — np. pole `qty` → kolumna `qty`).
5. Włącz automatyzację. Feishu pokaże **unikalny URL webhooka** — skopiuj go.

Powtórz dla wszystkich 4 tabel. Na koniec masz 4 różne adresy URL.

## 3. Wklej adresy webhooków do przekaźnika

Wybierz wersję pasującą do Twojego VPS:

- **PHP** → edytuj `relay.php`
- **Node.js** → edytuj `relay.js`

W obu na górze pliku są 4 stałe do uzupełnienia:

```
WEBHOOK_REPORT  = ...  (z tabeli RaportDzienny)
WEBHOOK_QUALITY = ...  (z tabeli PrzyczynyJakosc)
WEBHOOK_AWARIA  = ...  (z tabeli Awarie)
WEBHOOK_REWORK  = ...  (z tabeli ReworkProcessing)
```

## 4. Wdróż na VPS Hostingera

### Wariant PHP
```bash
scp relay.php uzytkownik@twoj-vps:/var/www/cfm-relay/
# skonfiguruj Apache/Nginx + PHP-FPM na ten katalog, z HTTPS (Let's Encrypt / certbot)
```

### Wariant Node.js

**UWAGA — na obecnym VPS (srv1281126) relay.js NIE działa jako goły proces
pod pm2/systemd (mimo że tak sugerowały wcześniejsze wersje tej instrukcji).
Działa jako kontener Docker** zarządzany przez `docker compose`, w
`/opt/cfm-relay/` (razem z `docker-compose.yml` i `Dockerfile`, który robi
`COPY relay.js .` do obrazu przy buildzie). Ruch HTTPS idzie przez Traefik
(`traefik-proxy` sieć, host `cfm-relay.maciejmostowski.pl`), nie przez
osobny Nginx. Żeby wgrać nowa wersje `relay.js` na tym serwerze:

```bash
ssh uzytkownik@twoj-vps
# wklej/nadpisz /opt/cfm-relay/relay.js nowa tresc (np. przez nano)
cd /opt/cfm-relay
docker compose up -d --build
docker compose logs --tail=20   # powinno pokazac "CFM relay listening on port 3000" bez bledow
docker compose ps               # status ma byc "Up", nie "Restarting"/"Exited"
```

Nie próbuj `pm2`/`nohup node relay.js &` na tym serwerze — plik na dysku
sam z siebie niczego nie zmienia w działającym kontenerze (nie ma
bind-mounta, `Mounts` jest puste), a ręcznie odpalony proces obok
kontenera tylko wejdzie w konflikt o port 3000.

Na innym/nowym VPS bez istniejącego Dockera — klasyczny wariant:
```bash
scp relay.js uzytkownik@twoj-vps:/opt/cfm-relay/
ssh uzytkownik@twoj-vps
cd /opt/cfm-relay
pm2 start relay.js --name cfm-relay   # albo systemd
# ustaw Nginx jako reverse proxy z HTTPS na port 3000
```

**Ważne: musi być HTTPS.** Aplikacja CFM działa po HTTPS (GitHub Pages) —
przeglądarka zablokuje połączenie do zwykłego `http://`. Najprościej:
Nginx + certbot (`certbot --nginx`) przed Twoim skryptem.

## 5. Skonfiguruj aplikację CFM

W aplikacji: ⚙ → **Połączenie** → sekcja **Feishu / 飞书 API**:

| Pole | Wartość |
|---|---|
| Feishu Proxy URL | adres Twojego VPS, np. `https://cfm-relay.twojadomena.pl` |
| Spreadsheet Token | dowolny tekst, np. `vps` — nieużywane w tym trybie, ale pole musi być wypełnione |
| Sheet ID | dowolny tekst, np. `vps` — jw. |

Zapisz. Raporty zaczną trafiać do Bazy. Statystyki „Dziś"/„Ostatni
wpis"/bufor reworku automatycznie przełączą się na dane lokalne (telefon) —
to oczekiwane zachowanie w tym trybie, nie błąd.

## Later: pełny odczyt

Jeśli kiedyś uda się uzyskać od IT **wąskie, tylko-do-odczytu** uprawnienie
(`sheets:spreadsheet:readonly`) w Feishu Open Platform, wróć do
`feishu-proxy/worker.js` (Cloudflare Worker) — ta wersja czyta dane na
żywo (historia, bufor reworku, sprawdzanie otwartej awarii) i może
działać **równolegle** z tym przekaźnikiem: zapis przez Bazę, odczyt przez
Workera, albo migracja w całości na jedno rozwiązanie.
