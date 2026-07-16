# CFM ↔ Feishu — konfiguracja

Aplikacja CFM (przeglądarka) nie może łączyć się z arkuszem Feishu bezpośrednio —
Feishu nie udostępnia CORS dla `open.feishu.cn`, a klucz `app_secret` nigdy nie
może trafić do kodu działającego w telefonie/przeglądarce. Dlatego pomiędzy
aplikacją a Feishu stoi mały serwer pośredniczący (Cloudflare Worker, ten katalog).

```
CFM_raport_dzienny.html  --->  Worker (feishu-proxy)  --->  Feishu Sheets API
   (telefon operatora)           (trzyma app_secret)         (Twój arkusz)
```

## 1. Utwórz aplikację w Feishu Open Platform

1. Wejdź na https://open.feishu.cn/app i zaloguj się firmowym kontem.
2. „Utwórz aplikację wewnętrzną" (企业自建应用).
3. W zakładce „Poświadczenia i podstawowe informacje" (凭证与基础信息) skopiuj
   **App ID** i **App Secret**.
4. W „Zarządzanie uprawnieniami" (权限管理) włącz uprawnienia:
   - `sheets:spreadsheet` (odczyt/zapis arkuszy)
5. Opublikuj wersję aplikacji.
6. Otwórz swój arkusz Feishu i dodaj tę aplikację jako współpracownika
   (Udostępnij → dodaj aplikację), inaczej worker nie będzie miał dostępu.

## 2. Przygotuj zakładki na surowe dane

W arkuszu Feishu (tym samym co "CFM产线生产计划统计表" albo osobnym) dodaj **cztery**
nowe zakładki. Worker celowo nie dotyka istniejącej, złożonej tabeli planu
produkcji — te zakładki są surowym logiem, z którego możesz budować
formuły/pivot podpięte pod resztę arkusza.

### `RaportDzienny` — jeden wiersz = jeden raport zmiany

```
timestamp | date | shift | station | operator | qty | scrap | rework | recovered | ok_count | pass_rate | notes
```

### `PrzyczynyJakosc` — jeden wiersz = jedna pozycja scrap/rework z przyczyną

To dane dla działu jakości: każda przyczyna dodana w aplikacji (przycisk
„+ Dodaj" przy Scrap/Rework) trafia tu jako osobny wiersz.

```
timestamp | date | shift | station | operator | category | reason | qty
```

`category` to `scrap` albo `rework`.

### `Awarie` — jeden wiersz = jedno zdarzenie awarii

```
start_timestamp | station | type | koniec_timestamp | czas_min | status
```

Wiersz powstaje przy „START AWARII" ze `status=OTWARTA` i pustymi kolumnami
D/E, a przy „KONIEC AWARII" worker odnajduje ten wiersz i uzupełnia
`koniec_timestamp`, `czas_min`, `status=ZAMKNIETA`. Dzięki temu przycisk
„Sprawdź otwartą awarię" (ostrzeżenie o niezamkniętej awarii na tym samym
stanowisku) działa też przez Feishu, nie tylko przez Google Sheets.

### `ReworkProcessing` — jeden wiersz = jedno przetworzenie bufora reworku

Rework nie jest rozliczany w ramach tej samej zmiany, w której powstał —
może być przetworzony zbiorczo kilka dni później, dla kilku stanowisk naraz
(strefy: OP33A/B, OP60/61, GP12, OP40 IN/OUT, OP51/52). Worker liczy narastający
bufor per strefa: `SUMA(rework z RaportDzienny dla stacji w strefie) − SUMA(recovered) − SUMA(final_scrap)`.

```
timestamp | date | zone | processed | recovered | final_scrap | note | notes
```

`zone` to jeden z kluczy: `OP33A_B`, `OP60_61`, `GP12`, `OP40`, `OP51_52`.

Skopiuj **spreadsheetToken** z URL arkusza Feishu:
`https://xxx.feishu.cn/sheets/`**`shtcnXXXXXXXXXXXXXXXX`** ← to jest token.

## 3. Wdróż Cloudflare Worker

```bash
cd feishu-proxy
npm install -g wrangler   # jeśli nie masz
wrangler login
wrangler secret put FEISHU_APP_ID       # wklej App ID z kroku 1
wrangler secret put FEISHU_APP_SECRET   # wklej App Secret z kroku 1
wrangler deploy
```

Po wdrożeniu wrangler wypisze adres, np.:
`https://cfm-feishu-proxy.<twoj-subdomain>.workers.dev`

## 4. Skonfiguruj aplikację CFM

W aplikacji: ⚙ → **Połączenie** → sekcja **Feishu / 飞书 API**:

| Pole | Wartość |
|---|---|
| Feishu Proxy URL | adres workera z kroku 3, np. `https://cfm-feishu-proxy.xxx.workers.dev` |
| Spreadsheet Token | token z kroku 2, np. `shtcnXXXXXXXXXXXXXXXX` |
| Sheet ID (nazwa zakładki raportu) | `RaportDzienny` |

Zapisz. Od tej pory każdy wysłany raport (produkcja, przyczyny scrap/rework,
start/koniec awarii) trafia do odpowiedniej zakładki w arkuszu Feishu, a
sekcja „Dziś" oraz moduł Awaria czytają dane z powrotem z tych zakładek.

Nazwy zakładek `PrzyczynyJakosc` i `Awarie` są ustawione na stałe w
`worker.js` (stałe `QUALITY_SHEET_NAME`, `AWARIA_SHEET_NAME`) — jeśli chcesz
inne nazwy, zmień je tam przed wdrożeniem.

## Uwaga o Google Sheets

Pole **Webhook URL** (Google Apps Script) nadal działa niezależnie — jeśli
skonfigurujesz oba, Feishu ma priorytet przy odczycie historii, ale zapis
wysyłany jest do obu jednocześnie.
