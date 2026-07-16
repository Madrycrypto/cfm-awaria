# CFM ↔ Google Apps Script — sprawdzanie awarii i bufora reworku

To jest **druga połowa** integracji, obok Feishu Base (`feishu-proxy/`).
Feishu Base świetnie zapisuje dane, ale nie potrafi na nic odpowiedzieć —
Google Apps Script uzupełnia dokładnie tę lukę, dla dwóch funkcji które
tego wymagają:

- **Awaria** — sprawdzenie, czy na stanowisku jest już otwarta (niezamknięta) awaria, zanim pozwolimy zacząć nową
- **Rework** — bufor zaległości per strefa, żeby zwalidować „odzyskane + złom" przeciwko temu, co faktycznie czeka w kolejce

Trwały zapis danych produkcyjnych nadal idzie do Feishu Base (aplikacja
wysyła do obu miejsc naraz) — ten arkusz to tylko pomocnicza pamięć
operacyjna, nie zamiennik Feishu.

## Wdrożenie (2 minuty, zero uprawnień admina)

1. Utwórz nowy arkusz Google Sheets — dowolna nazwa, np. „CFM Stan"
2. **Rozszerzenia → Apps Script**
3. Skasuj domyślną zawartość `Code.gs`, wklej całą zawartość pliku `CFM_state_webhook.gs` z tego folderu
4. **Wdróż → Nowe wdrożenie**
   - Typ: **Aplikacja internetowa**
   - Wykonaj jako: **Ja**
   - Kto ma dostęp: **Wszyscy**
5. Skopiuj adres URL wdrożenia (kończy się na `/exec`)
6. W aplikacji CFM: **⚙ → Połączenie → Webhook URL** → wklej ten adres → Zapisz i testuj

Zakładki (`RaportDzienny`, `Awarie`, `ReworkProcessing`) tworzą się
automatycznie przy pierwszym zapisie — nic nie trzeba przygotowywać
ręcznie w arkuszu.

## Jak to się łączy z Feishu

Skonfiguruj **oba** pola w panelu Połączenie:

| Pole | Do czego służy |
|---|---|
| Webhook URL (Google Apps Script) | Sprawdzanie otwartej awarii, bufor reworku — dwukierunkowo |
| Feishu Proxy URL | Trwały zapis raportów i przyczyn jakości w firmowej Bazie Feishu |

Aplikacja wysyła zapisy (raport, awaria, rework) **do obu jednocześnie**.
Przy sprawdzaniu (czy jest otwarta awaria / ile w buforze) **Google Apps
Script ma pierwszeństwo** — to jedyny z dwóch, który potrafi faktycznie
odpowiedzieć. Jeśli skonfigurujesz tylko Feishu bez webhooka, te
sprawdzenia po prostu nie zadziałają (aplikacja i tak wpuści operatora do
formularza, tylko bez ostrzeżenia o duplikacie/przekroczonym buforze).

## Dlaczego nie samo Feishu?

Sprawdziliśmy to dokładnie: automatyzacja webhook w Feishu Base zawsze
odpowiada pustym potwierdzeniem (`{"data":{}}`), niezależnie co się
stanie — nie ma sposobu, żeby zwrócić obliczony wynik. Google Apps
Script nie ma tego ograniczenia i każdy użytkownik może go wdrożyć sam,
bez zgody działu IT — stąd taki podział.
