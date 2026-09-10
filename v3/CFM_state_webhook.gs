/**
 * CFM State Webhook — Google Apps Script
 *
 * Feishu Base (自动化 webhook) potrafi tylko ZAPISYWAC rekordy — nie ma
 * sposobu, zeby odpowiedziec na pytanie w rodzaju "czy jest otwarta
 * awaria na tym stanowisku?" bez tworzenia "custom app" wymagajacego
 * uprawnien administratora Feishu. Google Apps Script nie ma tego
 * ograniczenia: kazdy uzytkownik moze sam wdrozyc go jako Web App z
 * poziomu Rozszerzenia -> Apps Script, bez zadnej zgody admina.
 *
 * Rola tego arkusza: dziala jako pelnoprawny backend dla wszystkiego,
 * co wymaga ODCZYTU (nie tylko zapisu) — sprawdzanie otwartych awarii,
 * historia (dzienna/godzinna/awarii/reworku) pobierana na zywo przez
 * kazde urzadzenie, bufor reworku per strefa i per przyczyna, oraz
 * synchronizacja Ustawien miedzy telefonami. Trwaly zapis danych
 * produkcyjnych i tak idzie rownolegle do Feishu Base (aplikacja wysyla
 * do obu na raz, gdy oba sa skonfigurowane) — ten arkusz nie jest
 * zamiennikiem Feishu, tylko dodatkowa pamiecia operacyjna.
 *
 * Wdrozenie:
 *   1. Utworz nowy arkusz Google Sheets (dowolna nazwa, np. "CFM Stan")
 *   2. Rozszerzenia -> Apps Script
 *   3. Wklej cala zawartosc tego pliku, zastepujac domyslny Code.gs
 *   4. Wdroz -> Nowe wdrozenie -> Typ: Aplikacja internetowa
 *      - Wykonaj jako: Ja
 *      - Kto ma dostep: Wszyscy
 *      (Jesli wdrozenie juz istnieje: Wdroz -> Zarzadzaj wdrozeniami ->
 *      edytuj istniejace -> Nowa wersja -> Wdroz, zeby URL zostal ten sam)
 *   5. Skopiuj adres URL wdrozenia (konczy sie na /exec)
 *   6. W aplikacji CFM: Panel Admina -> Połączenie -> wklej w "Webhook URL"
 *
 * Zakladki tworza sie automatycznie przy pierwszym zapisie — nie trzeba
 * nic przygotowywac recznie w arkuszu. Nowe kolumny dopisywane pozniej
 * (patrz ensureColumns_) trafiaja zawsze NA KONIEC istniejacych, zeby nie
 * przesunac juz zapisanych danych w starszych wierszach.
 */

var REWORK_ZONES = {
  'OP33A_B': ['OP33A', 'OP33B'],
  'OP60_61': ['OP60/61'],
  'GP12': ['GP12'],
  'OP40': ['OP40 IN', 'OP40 OUT'],
  'OP51_52': ['OP51/52'],
};

// ── FEISHU BOT (powiadomienia na grupe) ────────────────────────────────
// Osobne od integracji z Feishu Base (arkusz danych) — to "custom bot"
// webhook do WYSYLANIA WIADOMOSCI na konkretna grupe czatu Feishu. Wysylane
// z backendu (UrlFetchApp), NIE z przegladarki — webhooki bota Feishu nie
// pozwalaja na wywolania z poziomu przegladarki (CORS), a tutaj i tak
// potrzebujemy tego wylacznie przy zdarzeniach juz obslugiwanych po
// stronie serwera (start/koniec awarii, codzienne podsumowanie).
var FEISHU_BOT_WEBHOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/4c3cb956-3022-4e95-adbd-eaead7efedaa'; // glowna grupa (m.in. szefowie) - awaria start/koniec, podsumowanie dnia, eskalacja 1h+
var FEISHU_BOT_WEBHOOK_TECHNICY = ''; // TODO: wklej webhook bota z grupy technikow - uzywany przez eskalacje 15 min (patrz checkAwariaEscalations)
function round1_(n) { return Math.round(n * 10) / 10; }
// Typ/opis awarii to DOWOLNY wolny tekst po polsku wpisywany przez
// operatora (np. "Awaria maszyny: Brak zasilania - inspekcja niemozliwa
// na stanowisku op74") - zadna sztywna lista slownikowa go nie obejmie,
// wiec tlumaczymy automatycznie wbudowanym LanguageApp (dostepny w Apps
// Script bez wlaczania Advanced Services). Przy bledzie tlumaczenia
// (limit, brak sieci) zostaje oryginalny tekst - lepsze to niz pusta
// wiadomosc.
// Tlumaczy RAZ na oba jezyki (zamiast osobnych wywolan dla wiadomosci
// Feishu i dla kolumny type_cn w arkuszu) - jedno wywolanie LanguageApp na
// jezyk, wynik uzywany w obu miejscach ponizej.
function translateType_(text) {
  text = text || 'Awaria';
  var en = text, cn = text;
  try { en = LanguageApp.translate(text, 'pl', 'en'); } catch (e) {}
  try { cn = LanguageApp.translate(text, 'pl', 'zh-CN'); } catch (e) {}
  return { en: en, cn: cn };
}
// webhookUrl opcjonalny - domyslnie glowna grupa (FEISHU_BOT_WEBHOOK), ale
// eskalacja 15-min wysyla jawnie na FEISHU_BOT_WEBHOOK_TECHNICY (patrz
// checkAwariaEscalations).
function sendFeishuBotMessage_(text, webhookUrl) {
  var url = webhookUrl || FEISHU_BOT_WEBHOOK;
  if (!url) return;
  try {
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ msg_type: 'text', content: { text: text } }),
      muteHttpExceptions: true
    });
  } catch (e) {
    // Nie przerywamy glownej operacji (start/koniec awarii) tylko dlatego
    // ze powiadomienie na czat sie nie udalo.
  }
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  try {
    switch (p.event_type) {
      case 'RAPORT_DZIENNY': return handleReport(ss, p);
      case 'HISTORIA_DZIENNA': return handleHistoriaDzienna(ss, p);
      case 'STATYSTYKI': return handleStatystyki(ss, p);
      case 'START': return handleAwariaStart(ss, p);
      case 'KONIEC': return handleAwariaEnd(ss, p);
      case 'SPRAWDZ': return handleAwariaCheck(ss, p);
      case 'AWARIA_HISTORIA': return handleAwariaHistoria(ss, p);
      case 'AWARIE_OTWARTE': return handleAwarieOtwarte(ss, p);
      case 'EDIT_AWARIA_DURATION': return handleEditAwariaDuration(ss, p);
      case 'DELETE_AWARIA': return handleDeleteAwaria(ss, p);
      case 'REWORK_PROCESSING': return handleReworkProcessing(ss, p);
      case 'REWORK_BUFFER': return handleReworkBuffer(ss, p);
      case 'REWORK_HISTORY': return handleReworkHistory(ss, p);
      case 'DELETE_REWORK_PROCESSING': return handleDeleteReworkProcessing(ss, p);
      case 'RAPORT_GODZINNY': return handleRaportGodzinny(ss, p);
      case 'HISTORIA_GODZINNA': return handleHistoriaGodzinna(ss, p);
      case 'DELETE_RAPORT_DZIENNY': return handleDeleteRaportDzienny(ss, p);
      case 'DELETE_RAPORT_GODZINNY': return handleDeleteRaportGodzinny(ss, p);
      case 'GET_USTAWIENIA': return handleGetUstawienia(ss, p);
      case 'PREMIA': return handlePremia(ss, p);
      case 'ZGLOS_WYPADEK': return handleZglosWypadek(ss, p);
      case 'WYPADKI_HISTORIA': return handleWypadkiHistoria(ss, p);
      case 'TEST': return jsonResponse({ status: 'ok', msg: 'polaczenie dziala' });
      default: return jsonResponse({ status: 'error', msg: 'nieznany event_type: ' + p.event_type });
    }
  } catch (err) {
    return jsonResponse({ status: 'error', msg: String(err) });
  }
}

function doPost(e) {
  var raw = (e && e.postData && e.postData.contents) || '{}';
  var p = {};
  try { p = JSON.parse(raw); } catch (err) { /* zostaw pusty obiekt */ }
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  try {
    switch (p.event_type) {
      case 'ZAPISZ_USTAWIENIE': return handleSetUstawienie(ss, p);
      default: return jsonResponse({ status: 'error', msg: 'nieznany event_type: ' + p.event_type });
    }
  } catch (err) {
    return jsonResponse({ status: 'error', msg: String(err) });
  }
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function getOrCreateSheet(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// Dopisuje na koncu istniejacych kolumn te naglowki z `headers`, ktorych
// jeszcze nie ma w arkuszu — zeby stare arkusze (utworzone przed dodaniem
// nowego pola w kodzie) dostaly brakujace kolumny bez przesuwania juz
// zapisanych danych w innych kolumnach.
function ensureColumns_(sheet, headers) {
  var lastCol = sheet.getLastColumn();
  var existing = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  headers.forEach(function (h) {
    if (existing.indexOf(h) === -1) {
      sheet.getRange(1, existing.length + 1).setValue(h);
      existing.push(h);
    }
  });
}

// Dodaje/odejmuje qty z JSON-owej listy [{reason, qty}, ...] do mapy per przyczyna.
function addReasonQty_(map, reasonsJson, sign) {
  if (!reasonsJson) return;
  var entries;
  try { entries = JSON.parse(reasonsJson); } catch (e) { return; }
  if (!entries || typeof entries.forEach !== 'function') return;
  entries.forEach(function (en) {
    if (!en || !en.reason) return;
    var q = Number(en.qty) || 0;
    map[en.reason] = (map[en.reason] || 0) + sign * q;
  });
}

// RaportDzienny trzyma reasons_json jako obiekt {scrap:[...], rework:[...]} —
// tu interesuje nas tylko galaz "rework" (to ona zasila bufor reworku).
function addReworkReasonsFromReport_(map, reasonsJson) {
  if (!reasonsJson) return;
  var obj;
  try { obj = JSON.parse(reasonsJson); } catch (e) { return; }
  var entries = (obj && obj.rework) || [];
  entries.forEach(function (en) {
    if (!en || !en.reason) return;
    var q = Number(en.qty) || 0;
    map[en.reason] = (map[en.reason] || 0) + q;
  });
}

// Komorka kolumny "date" bywa albo stringiem "yyyy-MM-dd" (tak jak go
// wysylamy), albo obiektem Date — Arkusze Google SAME konwertuja string
// wygladajacy jak data na typ Date przy zapisie, wiec przy odczycie trzeba
// sprowadzic obie postacie do tego samego formatu, inaczej porownanie
// stringa z Date zawsze zawodzi mimo identycznego wygladu w arkuszu.
function normalizeDate_(val) {
  if (val instanceof Date) {
    return Utilities.formatDate(val, Session.getScriptTimeZone() || 'Europe/Warsaw', 'yyyy-MM-dd');
  }
  return String(val || '');
}

// ── RAPORT ZMIANY ────────────────────────────────────────────────────
// timestamp | date | shift | station | operator | qty | scrap | rework | recovered | ok_count | pass_rate | notes | reasons_json | plan
// (plan dopisany NA KONCU, zeby nie przesunac kolumn juz zapisanych wierszy)
var RAPORT_DZIENNY_HEADERS = ['timestamp', 'date', 'shift', 'station', 'operator', 'qty', 'scrap', 'rework', 'recovered', 'ok_count', 'pass_rate', 'notes', 'reasons_json', 'plan'];
function handleReport(ss, p) {
  var sheet = getOrCreateSheet(ss, 'RaportDzienny', RAPORT_DZIENNY_HEADERS);
  ensureColumns_(sheet, RAPORT_DZIENNY_HEADERS);
  var row = [
    p.timestamp || '', p.date || '', p.shift || '', p.station || '', p.operator || '',
    Number(p.qty) || 0, Number(p.scrap) || 0, Number(p.rework) || 0, Number(p.recovered) || 0,
    Number(p.ok_count) || 0, p.pass_rate || '', p.notes || '', p.reasons_json || '', Number(p.plan) || 0,
  ];
  // Jedno stanowisko + jedna zmiana + jeden dzien = jeden raport, kto
  // kolwiek go akurat wypelnia — jesli juz istnieje wiersz dla tej daty/
  // zmiany/stanowiska, podmien go zamiast dopisywac duplikat (operator NIE
  // jest czescia klucza, to tylko informacja kto ostatnio wyslal/poprawil).
  var lastRow = sheet.getLastRow();
  var tail = getTailRows_(sheet, 5000);
  for (var i = tail.length - 1; i >= 0; i--) {
    var r = tail[i];
    if (normalizeDate_(r[1]) === p.date && r[2] === p.shift && r[3] === p.station) {
      var sheetRow = (lastRow - tail.length) + i + 1;
      sheet.getRange(sheetRow, 1, 1, row.length).setValues([row]);
      return jsonResponse({ status: 'ok', updated: true });
    }
  }
  sheet.appendRow(row);
  return jsonResponse({ status: 'ok', updated: false });
}

function handleDeleteRaportDzienny(ss, p) {
  var sheet = ss.getSheetByName('RaportDzienny');
  if (!sheet) return jsonResponse({ status: 'error', msg: 'brak danych' });
  var lastRow = sheet.getLastRow();
  var tail = getTailRows_(sheet, 5000);
  for (var i = tail.length - 1; i >= 0; i--) {
    var r = tail[i];
    if (normalizeDate_(r[1]) === p.date && r[2] === p.shift && r[3] === p.station) {
      var sheetRow = (lastRow - tail.length) + i + 1;
      sheet.deleteRow(sheetRow);
      return jsonResponse({ status: 'ok', deleted: true });
    }
  }
  return jsonResponse({ status: 'ok', deleted: false });
}

function handleHistoriaDzienna(ss, p) {
  var sheet = ss.getSheetByName('RaportDzienny');
  if (!sheet) return jsonResponse({ status: 'error', msg: 'brak danych' });
  var data = getTailRows_(sheet, 5000);
  // Data z apki — pozwala przegladac/uzupelniac historie dowolnego
  // wczesniejszego dnia, nie tylko dzisiejszego (patrz Zmien dzien w
  // Raporcie zmiany). Fallback na dzisiaj dla starszych wersji apki bez
  // pola date.
  var targetDate = p.date || Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Europe/Warsaw', 'yyyy-MM-dd');
  var historia = [], suma = 0, scrap = 0, rework = 0, recovered = 0;
  for (var i = 0; i < data.length; i++) {
    var r = data[i];
    if (normalizeDate_(r[1]) !== targetDate) continue;
    if (p.stanowisko && r[3] !== p.stanowisko) continue;
    if (p.operator && r[4] !== p.operator) continue;
    var entry = {
      timestamp: r[0], date: normalizeDate_(r[1]), shift: r[2], station: r[3], operator: r[4],
      qty: Number(r[5]) || 0, scrap: Number(r[6]) || 0, rework: Number(r[7]) || 0, recovered: Number(r[8]) || 0,
      ok_count: Number(r[9]) || 0, pass_rate: r[10], notes: r[11], reasons_json: r[12] || '', plan: Number(r[13]) || 0,
    };
    historia.push(entry);
    suma += entry.qty; scrap += entry.scrap; rework += entry.rework; recovered += entry.recovered;
  }
  return jsonResponse({ status: 'ok', historia: historia, suma: suma, scrap: scrap, rework: rework, recovered: recovered });
}

// Zwraca surowe wiersze RaportDzienny z zadanego zakresu dat (wlacznie) —
// bez agregacji po stronie serwera, zeby strona statystyk mogla sama
// grupowac/pivotowac wg stanowiska/zmiany/tygodnia bez wielu zapytan.
function handleStatystyki(ss, p) {
  var sheet = ss.getSheetByName('RaportDzienny');
  if (!sheet) return jsonResponse({ status: 'ok', historia: [] });
  var data = sheet.getDataRange().getValues();
  var historia = [];
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    var d = normalizeDate_(r[1]);
    if (p.start && d < p.start) continue;
    if (p.end && d > p.end) continue;
    historia.push({
      date: d, shift: r[2], station: r[3], operator: r[4],
      qty: Number(r[5]) || 0, scrap: Number(r[6]) || 0, rework: Number(r[7]) || 0,
      ok_count: Number(r[9]) || 0, plan: Number(r[13]) || 0, reasons_json: r[12] || '',
    });
  }
  historia.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });

  // Rowniez ReworkProcessing z tego samego zakresu dat — zeby strona
  // statystyk mogla pokazac, ile z tego co trafilo do reworku faktycznie
  // wrocilo jako dobre sztuki, a ile ostatecznie poszlo na zlom (bilans
  // per strefa, NIEZALEZNY od pass rate pojedynczego raportu — patrz
  // komentarz w handleReworkProcessing o addytywnym charakterze bufora).
  var reworkHistoria = [];
  var reworkSheet = ss.getSheetByName('ReworkProcessing');
  if (reworkSheet) {
    var rdata = reworkSheet.getDataRange().getValues();
    for (var j = 1; j < rdata.length; j++) {
      var rr = rdata[j];
      var rd = normalizeDate_(rr[1]);
      if (p.start && rd < p.start) continue;
      if (p.end && rd > p.end) continue;
      reworkHistoria.push({
        date: rd, zone: rr[2], zone_label: rr[9] || rr[2],
        processed: Number(rr[3]) || 0, recovered: Number(rr[4]) || 0, final_scrap: Number(rr[5]) || 0,
      });
    }
  }
  // Rowniez Awarie z tego samego zakresu dat — zeby strona statystyk mogla
  // pokazac ile bylo przestoju (i ile razy) per stanowisko/zmiana w
  // ogladanym okresie, nie tylko posrednio przez wplyw na Premie. Tylko
  // ZAMKNIETE awarie (otwarta = jeszcze trwa, nieznany finalny czas);
  // starsze wpisy sprzed dodania kolumny "shift" po prostu maja ja puste.
  var awarieHistoria = [];
  var awSheet = ss.getSheetByName('Awarie');
  if (awSheet) {
    var awMap = awarieHeaderMap_(awSheet);
    var adata = awSheet.getDataRange().getValues();
    for (var k = 1; k < adata.length; k++) {
      var ar = awarieRowToObj_(adata[k], awMap);
      if (ar.status !== 'ZAMKNIETA') continue;
      var ad = normalizeDate_(ar.start_timestamp).slice(0, 10);
      if (p.start && ad < p.start) continue;
      if (p.end && ad > p.end) continue;
      awarieHistoria.push({ date: ad, station: ar.station, type: ar.type, shift: ar.shift || '', czas_min: Number(ar.czas_min) || 0, type_cn: ar.type_cn || '' });
    }
  }
  return jsonResponse({ status: 'ok', historia: historia, rework_historia: reworkHistoria, awarie_historia: awarieHistoria });
}

// ── PREMIE ───────────────────────────────────────────────────────────
// Surowe sumy dla wyliczenia premii (CFM_premie.html robi juz samo
// wyliczenie wg progow — tu tylko agregujemy dane zrodlowe):
//   - RaportDzienny: suma qty/ok_count i liczba wpisow, per stanowisko+zmiana,
//     w podanym zakresie dat. Plan liczony z ZYWEGO cfm_monthly_plan (patrz
//     planForDate_), NIE z kolumny 'plan' zapisanej w wierszu — ta jest
//     tylko migawka z momentu wyslania raportu i moze byc juz nieaktualna
//     (np. plan poprawiony pozniej w CFM_plan.html), co dawalo sprzeczne
//     liczby miedzy Premiami a Statystykami dla tego samego stanowiska/
//     zmiany/okresu (ten sam blad juz raz naprawiony w handleStatystyki).
//   - Awarie: laczny czas przestoju (min) per stanowisko+ZMIANA (kolumna
//     'shift', zapisywana przy START) w tym samym zakresie dat.
function planForDate_(monthlyPlan, targets, station, shift, dateIso) {
  var mk = dateIso.slice(0, 7);
  var e = monthlyPlan[mk] && monthlyPlan[mk][station] && monthlyPlan[mk][station][shift] && monthlyPlan[mk][station][shift][dateIso];
  if (e) return Number(e) || 0;
  return Number(targets[station]) || 0;
}
function planEntryFor_(monthlyPlan, station, shift, dateIso) {
  var mk = dateIso.slice(0, 7);
  var e = monthlyPlan[mk] && monthlyPlan[mk][station] && monthlyPlan[mk][station][shift] && monthlyPlan[mk][station][shift][dateIso];
  return e ? Number(e) : null;
}
function enumerateDays_(startIso, endIso) {
  var days = [];
  var sp = startIso.split('-'), ep = endIso.split('-');
  var cursor = new Date(Number(sp[0]), Number(sp[1]) - 1, Number(sp[2]));
  var end = new Date(Number(ep[0]), Number(ep[1]) - 1, Number(ep[2]));
  while (cursor <= end) {
    days.push(Utilities.formatDate(cursor, Session.getScriptTimeZone() || 'Europe/Warsaw', 'yyyy-MM-dd'));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}
// Pelny zaplanowany wolumen CALEGO okresu (start..end) dla stanowiska+
// zmiany — TA SAMA logika co getPeriodPlan w CFM_statystyki.html: per
// dzien, jawny wpis w Planie jesli istnieje, inaczej Cel stanowiska TYLKO
// jesli tego dnia faktycznie zlozono raport (byDate[d]) - realna praca
// bez wpisanego z gory planu (np. niezaplanowana wczesniej sobota) liczy
// sie wzgledem Celu zamiast znikac/wygladac jak porazka; dzien bez wpisu
// I bez raportu (stacja normalnie tu nie pracuje) nie dolicza sie wcale.
function getPeriodPlan_(monthlyPlan, targets, station, shift, startIso, endIso, byDate) {
  var days = enumerateDays_(startIso, endIso);
  return days.reduce(function(sum, d) {
    var explicit = planEntryFor_(monthlyPlan, station, shift, d);
    if (explicit !== null) return sum + explicit;
    if (byDate && byDate[d]) return sum + (Number(targets[station]) || 0);
    return sum;
  }, 0);
}
function handlePremia(ss, p) {
  var monthlyPlan = {}, stationTargets = {};
  var ustSheet = ss.getSheetByName('Ustawienia');
  if (ustSheet) {
    var udata = ustSheet.getDataRange().getValues();
    for (var u = 1; u < udata.length; u++) {
      if (udata[u][0] === 'cfm_monthly_plan') { try { monthlyPlan = JSON.parse(udata[u][1] || '{}'); } catch (e) {} }
      if (udata[u][0] === 'cfm_station_targets') { try { stationTargets = JSON.parse(udata[u][1] || '{}'); } catch (e) {} }
    }
  }

  var byKey = {};
  var sheet = ss.getSheetByName('RaportDzienny');
  if (sheet) {
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      var r = data[i];
      var d = normalizeDate_(r[1]);
      if (p.start && d < p.start) continue;
      if (p.end && d > p.end) continue;
      var key = r[3] + '||' + r[2];
      if (!byKey[key]) byKey[key] = { station: r[3], shift: r[2], sumQty: 0, sumOk: 0, sumPlan: 0, count: 0, byDate: {} };
      byKey[key].sumQty += Number(r[5]) || 0;
      byKey[key].sumOk += Number(r[9]) || 0;
      byKey[key].count += 1;
      byKey[key].byDate[d] = true;
    }
  }
  // Plan CALEGO okresu (start..end), nie tylko dni z juz zlozonym
  // raportem — patrz komentarz przy getPeriodPlan_. Liczony raz na
  // stanowisko+zmiane (nie w petli po wierszach), zeby niezaraportowany
  // dzien roboczy poprawnie obnizal % zamiast znikac z mianownika.
  if (p.start && p.end) {
    Object.keys(byKey).forEach(function(key) {
      var g = byKey[key];
      g.sumPlan = getPeriodPlan_(monthlyPlan, stationTargets, g.station, g.shift, p.start, p.end, g.byDate);
    });
  }

  // Przestoj przypisany do KONKRETNEJ zmiany (kolumna 'shift', zapisywana
  // przy START od tej wersji) — starsze wpisy Awarii sprzed tej zmiany nie
  // maja tej kolumny wypelnionej i trafiaja pod klucz "stanowisko||"
  // (pusta zmiana), wiec po prostu nie zostana przypisane do zadnej
  // konkretnej grupy w wyliczeniu premii, zamiast fallszywie zawyzac
  // ktoras z nich.
  var downtimeByKey = {};
  var awSheet = ss.getSheetByName('Awarie');
  if (awSheet) {
    var awMap = awarieHeaderMap_(awSheet);
    var adata = awSheet.getDataRange().getValues();
    for (var j = 1; j < adata.length; j++) {
      var ar = awarieRowToObj_(adata[j], awMap);
      if (ar.status !== 'ZAMKNIETA') continue;
      var ad = normalizeDate_(ar.start_timestamp).slice(0, 10);
      if (p.start && ad < p.start) continue;
      if (p.end && ad > p.end) continue;
      var dtKey = ar.station + '||' + (ar.shift || '');
      downtimeByKey[dtKey] = (downtimeByKey[dtKey] || 0) + (Number(ar.czas_min) || 0);
    }
  }

  return jsonResponse({
    status: 'ok',
    shifts: Object.keys(byKey).map(function (k) { return byKey[k]; }),
    downtime: downtimeByKey,
  });
}

// ── RAPORT GODZINNY ──────────────────────────────────────────────────
// Osobna zakladka od RaportDzienny — to tylko ROBOCZA lista w ciagu zmiany,
// nie zasila bufora reworku ani Feishu bezposrednio. Suma godzinnych
// wpisow (qty + rework per przyczyna) sluzy do WSTEPNEGO WYPELNIENIA
// Raportu Zmiany na koncu zmiany — dopiero wyslanie Raportu Zmiany
// faktycznie zapisuje dane i zasila bufor, zeby nic nie liczylo sie podwojnie.
// timestamp | date | shift | hour | station | operator | qty | rework | rework_reasons_json | rework_other_desc | delay
// Czyta tylko OSTATNIE maxRows wierszy arkusza (bez naglowka) zamiast
// calej historii od poczatku — Godzinny/Dzienny dotycza prawie zawsze
// niedawnych dni (nawet wpisy "wsteczne" trafiaja fizycznie na KONIEC
// arkusza, tylko z wczesniejsza data w kolumnie), a pelne
// getDataRange().getValues() na duzym, rosnacym z czasem arkuszu jest
// glownym powodem powolnego wczytywania. Jesli kiedys trzeba by wrocic
// dalej niz maxRows wierszy wstecz (raczej nie w tym zastosowaniu), ta
// funkcja tego nie znajdzie — zwieksz maxRows w razie potrzeby.
function getTailRows_(sheet, maxRows) {
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow <= 1) return [];
  var startRow = Math.max(2, lastRow - maxRows + 1);
  return sheet.getRange(startRow, 1, lastRow - startRow + 1, lastCol).getValues();
}

function handleRaportGodzinny(ss, p) {
  var sheet = getOrCreateSheet(ss, 'RaportGodzinny', ['timestamp', 'date', 'shift', 'hour', 'station', 'operator', 'qty', 'rework', 'rework_reasons_json', 'rework_other_desc', 'delay']);
  var tz = Session.getScriptTimeZone() || 'Europe/Warsaw';
  // Data z apki (uzytkownik moze wybrac dowolny wczesniejszy dzien, zeby
  // uzupelnic/poprawic zapomniany raport) — z fallbackiem na dzisiaj dla
  // starszych wersji apki, ktore jeszcze nie wysylaja pola date.
  var dateStr = p.date || Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var row = [
    p.timestamp || '', dateStr, p.shift || '', p.hour || '', p.station || '', p.operator || '',
    Number(p.qty) || 0, Number(p.rework) || 0, p.rework_reasons_json || '', p.rework_other_desc || '', p.delay || '',
  ];
  // Poprawka wpisu godzinowego (patrz editGodzEntry w apce) — podmien
  // istniejacy wiersz dla tej samej daty/zmiany/stanowiska/godziny zamiast
  // dopisywac duplikat (operator NIE jest czescia klucza — tylko informacja
  // kto wpisal). Dopasowanie idzie po orig_hour (godzina wiersza W MOMENCIE
  // otwarcia edycji), nie po hour (nowa/docelowa wartosc) — inaczej zmiana
  // samej godziny w edycji nie trafialaby w oryginalny wiersz i zamiast go
  // "przemianowac" tworzylaby nowy, zostawiajac stary bez zmian.
  var origHour = p.orig_hour || p.hour;
  var lastRow = sheet.getLastRow();
  var tail = getTailRows_(sheet, 5000);
  for (var i = tail.length - 1; i >= 0; i--) {
    var r = tail[i];
    if (normalizeDate_(r[1]) === dateStr && r[2] === p.shift && r[3] === origHour && r[4] === p.station) {
      var sheetRow = (lastRow - tail.length) + i + 1;
      sheet.getRange(sheetRow, 1, 1, row.length).setValues([row]);
      return jsonResponse({ status: 'ok', updated: true });
    }
  }
  sheet.appendRow(row);
  return jsonResponse({ status: 'ok', updated: false });
}

function handleDeleteRaportGodzinny(ss, p) {
  var sheet = ss.getSheetByName('RaportGodzinny');
  if (!sheet) return jsonResponse({ status: 'error', msg: 'brak danych' });
  var tz = Session.getScriptTimeZone() || 'Europe/Warsaw';
  var dateStr = p.date || Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var lastRow = sheet.getLastRow();
  var tail = getTailRows_(sheet, 5000);
  for (var i = tail.length - 1; i >= 0; i--) {
    var r = tail[i];
    if (normalizeDate_(r[1]) === dateStr && r[2] === p.shift && r[3] === p.hour && r[4] === p.station) {
      var sheetRow = (lastRow - tail.length) + i + 1;
      sheet.deleteRow(sheetRow);
      return jsonResponse({ status: 'ok', deleted: true });
    }
  }
  return jsonResponse({ status: 'ok', deleted: false });
}

function handleHistoriaGodzinna(ss, p) {
  var sheet = ss.getSheetByName('RaportGodzinny');
  if (!sheet) return jsonResponse({ status: 'ok', historia: [], suma: 0, rework: 0 });
  var tz = Session.getScriptTimeZone() || 'Europe/Warsaw';
  // Data z apki — pozwala przegladac/uzupelniac historie dowolnego
  // wczesniejszego dnia, nie tylko dzisiejszego. Fallback na dzisiaj dla
  // starszych wersji apki bez pola date.
  var targetDate = p.date || Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var data = getTailRows_(sheet, 5000);
  var historia = [], suma = 0, rework = 0;
  for (var i = 0; i < data.length; i++) {
    var r = data[i];
    if (normalizeDate_(r[1]) !== targetDate) continue;
    if (p.stanowisko && r[4] !== p.stanowisko) continue;
    if (p.operator && r[5] !== p.operator) continue;
    if (p.shift && r[2] !== p.shift) continue;
    var qty = Number(r[6]) || 0, reworkVal = Number(r[7]) || 0;
    historia.push({ timestamp: r[0], date: normalizeDate_(r[1]), shift: r[2], godzina: r[3], station: r[4], operator: r[5], qty: qty, rework: reworkVal, rework_reasons_json: r[8] || '', rework_other_desc: r[9] || '', delay: r[10] });
    suma += qty; rework += reworkVal;
  }
  return jsonResponse({ status: 'ok', historia: historia, suma: suma, rework: rework });
}

// ── AWARIE ──────────────────────────────────────────────────────────
// start_timestamp | station | type | koniec_timestamp | czas_min | status | operator | shift | type_cn
// (shift i type_cn dopisane NA KONCU listy ponizej, ale UWAGA: to NIE
// znaczy, ze sa na koncu w samym arkuszu! Zywy arkusz ma miedzy "operator"
// a "shift" jeszcze dwie kolumny alert_15min_sent/alert_1h_sent, dodane
// przez funkcje checkAwariaEscalations spoza tego pliku (trigger czasowy,
// patrz nizej) - ensureColumns_ dopisuje kazdy NOWY naglowek na sam koniec
// istniejacych kolumn W MOMENCIE jego pierwszego dodania, wiec kolejnosc w
// arkuszu odzwierciedla KIEDY dana funkcja pierwszy raz zostala wdrozona,
// nie kolejnosc w tej liscie. appendRow() z gotowa tablica wartosci pisze
// pozycyjnie od kolumny A, wiec przy takim rozjezdzie kolejnosci nadpisywal
// cudze kolumny (shift trafial w alert_15min_sent, type_cn w alert_1h_sent)
// - stad WSZYSTKIE funkcje ponizej czytaja/pisza po NAZWIE naglowka
// (awarieHeaderMap_/awarieRowToObj_/awarieAppendRow_/awarieSetField_), nie
// po sztywnej pozycji - bezpieczne niezaleznie od tego, jakie jeszcze inne
// kolumny ktos kiedys dopisze z zewnatrz.
var AWARIE_HEADERS = ['start_timestamp', 'station', 'type', 'koniec_timestamp', 'czas_min', 'status', 'operator', 'shift', 'type_cn'];
function awarieHeaderMap_(sheet) {
  var lastCol = sheet.getLastColumn();
  var headers = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  var map = {};
  headers.forEach(function (h, i) { map[h] = i; });
  return map;
}
function awarieRowToObj_(row, map) {
  function g(name) { return map.hasOwnProperty(name) ? row[map[name]] : ''; }
  return {
    start_timestamp: g('start_timestamp'), station: g('station'), type: g('type'),
    koniec_timestamp: g('koniec_timestamp'), czas_min: g('czas_min'), status: g('status'),
    operator: g('operator'), shift: g('shift'), type_cn: g('type_cn'),
    alert_15min_sent: g('alert_15min_sent'), alert_1h_sent: g('alert_1h_sent'),
  };
}
// Dopisuje nowy wiersz jako obiekt {naglowek: wartosc} zamiast tablicy
// pozycyjnej - kazde pole trafia do kolumny o tej nazwie niezaleznie od
// jej faktycznej pozycji w arkuszu; nazwy nieobecne w arkuszu sa pomijane.
function awarieAppendRow_(sheet, map, fields) {
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var row = new Array(lastCol).fill('');
  Object.keys(fields).forEach(function (k) {
    if (map.hasOwnProperty(k)) row[map[k]] = fields[k];
  });
  sheet.appendRow(row);
}
function awarieSetField_(sheet, map, rowIndex1based, fieldName, value) {
  if (!map.hasOwnProperty(fieldName)) return;
  sheet.getRange(rowIndex1based, map[fieldName] + 1).setValue(value);
}
function handleAwariaStart(ss, p) {
  var sheet = getOrCreateSheet(ss, 'Awarie', AWARIE_HEADERS);
  ensureColumns_(sheet, AWARIE_HEADERS);
  var tr = translateType_(p.typ || 'Awaria');
  var map = awarieHeaderMap_(sheet);
  awarieAppendRow_(sheet, map, {
    start_timestamp: p.timestamp || '', station: p.stanowisko || '', type: p.typ || '',
    status: 'OTWARTA', operator: p.operator || '', shift: p.shift || '', type_cn: tr.cn,
  });
  sendFeishuBotMessage_('🔧 BREAKDOWN START / 故障开始\n' + (p.stanowisko || '?') + ' · ' + tr.en + ' / ' + tr.cn + (p.shift ? ' · Shift / 班次 ' + p.shift : '') + (p.operator ? '\nReported by / 报告人: ' + p.operator : ''));
  return jsonResponse({ status: 'ok' });
}

function handleAwariaEnd(ss, p) {
  var sheet = getOrCreateSheet(ss, 'Awarie', AWARIE_HEADERS);
  ensureColumns_(sheet, AWARIE_HEADERS);
  var map = awarieHeaderMap_(sheet);
  var data = sheet.getDataRange().getValues();
  // Zaokraglone do pelnych minut PRZY ZAPISIE (nie tylko przy wyswietlaniu)
  // - awaria trwajaca np. 61 min 20 s liczona jako roznica timestampow
  // dawala 61.333... min, co pokazywalo sie jako "61.3 min" wszedzie
  // (podsumowanie dnia, Statystyki, Excel). Zaokraglenie w jednym miejscu
  // (tu, przy zapisie) usuwa ulamki wszedzie na raz.
  var czasMin = Math.round(Number(p.czas_min) || 0);
  for (var i = data.length - 1; i >= 1; i--) {
    var obj = awarieRowToObj_(data[i], map);
    if (obj.start_timestamp === p.start_timestamp && obj.station === p.stanowisko && obj.status === 'OTWARTA') {
      var tr = translateType_(p.typ || obj.type);
      var rowIdx = i + 1;
      awarieSetField_(sheet, map, rowIdx, 'type', p.typ || obj.type);
      awarieSetField_(sheet, map, rowIdx, 'koniec_timestamp', p.koniec_timestamp || '');
      awarieSetField_(sheet, map, rowIdx, 'czas_min', czasMin);
      awarieSetField_(sheet, map, rowIdx, 'status', 'ZAMKNIETA');
      awarieSetField_(sheet, map, rowIdx, 'type_cn', tr.cn);
      sendFeishuBotMessage_('✅ BREAKDOWN END / 故障结束\n' + (p.stanowisko || '?') + ' · ' + tr.en + ' / ' + tr.cn + '\nDuration / 时长: ' + czasMin + ' min');
      return jsonResponse({ status: 'ok' });
    }
  }
  // Nie znaleziono otwartego wiersza (np. reset stanu w aplikacji) — dopisz kompletny wiersz.
  var tr2 = translateType_(p.typ || 'Awaria');
  awarieAppendRow_(sheet, map, {
    start_timestamp: p.start_timestamp || '', station: p.stanowisko || '', type: p.typ || '',
    koniec_timestamp: p.koniec_timestamp || '', czas_min: czasMin, status: 'ZAMKNIETA',
    operator: p.operator || '', shift: p.shift || '', type_cn: tr2.cn,
  });
  sendFeishuBotMessage_('✅ BREAKDOWN END / 故障结束\n' + (p.stanowisko || '?') + ' · ' + tr2.en + ' / ' + tr2.cn + '\nDuration / 时长: ' + czasMin + ' min');
  return jsonResponse({ status: 'ok' });
}

function handleAwariaCheck(ss, p) {
  var sheet = ss.getSheetByName('Awarie');
  if (!sheet) return jsonResponse({ open: false });
  var map = awarieHeaderMap_(sheet);
  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    var obj = awarieRowToObj_(data[i], map);
    if (obj.station === p.stanowisko && obj.status === 'OTWARTA') {
      var startIso = obj.start_timestamp;
      var diffMin = Math.round((new Date() - new Date(startIso)) / 60000);
      return jsonResponse({ open: true, awaria: { typ: obj.type, start: startIso, startIso: startIso, diffMin: diffMin, operator: obj.operator } });
    }
  }
  return jsonResponse({ open: false });
}

// Wszystkie AKTUALNIE otwarte awarie naraz (nie jedno stanowisko jak
// handleAwariaCheck) — do zywego panelu na Dashboardzie (duzy zegar per
// otwarta awaria, tykajacy w przegladarce bez dopytywania serwera co
// sekunde — tutaj tylko poczatkowy stan + station/typ/kto/zmiana).
function handleAwarieOtwarte(ss, p) {
  var sheet = ss.getSheetByName('Awarie');
  if (!sheet) return jsonResponse({ status: 'ok', otwarte: [] });
  var map = awarieHeaderMap_(sheet);
  var data = sheet.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var obj = awarieRowToObj_(data[i], map);
    if (obj.status !== 'OTWARTA') continue;
    out.push({ station: obj.station, type: obj.type, start_timestamp: obj.start_timestamp, operator: obj.operator || '', shift: obj.shift || '' });
  }
  return jsonResponse({ status: 'ok', otwarte: out });
}

// Historia Awarii pobierana na zywo (nie z pamieci telefonu) — kazdy
// operator na kazdym urzadzeniu widzi to samo. Tylko zamkniete awarie,
// opcjonalnie filtrowane po stanowisku, najnowsze pierwsze.
function handleAwariaHistoria(ss, p) {
  var sheet = ss.getSheetByName('Awarie');
  if (!sheet) return jsonResponse({ status: 'ok', historia: [] });
  var map = awarieHeaderMap_(sheet);
  var data = sheet.getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var obj = awarieRowToObj_(data[i], map);
    if (obj.status !== 'ZAMKNIETA') continue;
    if (p.stanowisko && obj.station !== p.stanowisko) continue;
    rows.push({ station: obj.station, type: obj.type, start_timestamp: obj.start_timestamp, koniec_timestamp: obj.koniec_timestamp, czas_min: Number(obj.czas_min) || 0, operator: obj.operator || '' });
  }
  rows.sort(function (a, b) { return new Date(b.koniec_timestamp) - new Date(a.koniec_timestamp); });
  return jsonResponse({ status: 'ok', historia: rows.slice(0, 20) });
}

// Poprawka czasu trwania zamknietej awarii (np. zapomniano kliknac KONIEC
// na czas i wynik jest zawyzony) — identyfikacja po stanowisku/typie/
// czasie startu, tak samo jak przy zamykaniu.
function handleEditAwariaDuration(ss, p) {
  var sheet = ss.getSheetByName('Awarie');
  if (!sheet) return jsonResponse({ status: 'error', msg: 'brak danych' });
  var map = awarieHeaderMap_(sheet);
  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    var obj = awarieRowToObj_(data[i], map);
    if (obj.start_timestamp === p.start_timestamp && obj.station === p.stanowisko && obj.type === p.typ && obj.status === 'ZAMKNIETA') {
      awarieSetField_(sheet, map, i + 1, 'czas_min', Math.round(Number(p.czas_min) || 0));
      return jsonResponse({ status: 'ok', updated: true });
    }
  }
  return jsonResponse({ status: 'ok', updated: false });
}

function handleDeleteAwaria(ss, p) {
  var sheet = ss.getSheetByName('Awarie');
  if (!sheet) return jsonResponse({ status: 'error', msg: 'brak danych' });
  var map = awarieHeaderMap_(sheet);
  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    var obj = awarieRowToObj_(data[i], map);
    if (obj.start_timestamp === p.start_timestamp && obj.station === p.stanowisko && obj.type === p.typ) {
      sheet.deleteRow(i + 1);
      return jsonResponse({ status: 'ok', deleted: true });
    }
  }
  return jsonResponse({ status: 'ok', deleted: false });
}

// Uruchom RECZNIE JEDEN RAZ (z listy funkcji w edytorze), zeby dopisac
// chinskie tlumaczenie (type_cn) do WSZYSTKICH juz istniejacych awarii,
// ktore powstaly PRZED wdrozeniem automatycznego tlumaczenia - inaczej
// stare wpisy (tooltip nad &#9888;, chipsy, eksport Excel) na zawsze
// zostalyby bez chinskiego tekstu, bo translateType_ liczy sie tylko przy
// START/KONIEC nowej awarii. Bezpiecznie uruchomic wielokrotnie - pomija
// wiersze, ktore juz maja wypelnione type_cn.
// Uruchom RECZNIE JEDEN RAZ, PRZED backfillTypeCn - naprawia skutki
// wczesniejszej kolizji kolumn. Zanim istnienie alert_15min_sent/
// alert_1h_sent bylo mi znane, appendRow()/getRange() z ta funkcja
// pisaly POZYCYJNIE, wiec wartosc "shift" ladowala sie fizycznie w
// kolumnie podpisanej "alert_15min_sent", a "type_cn" w
// "alert_1h_sent" - dla WSZYSTKICH awarii zapisanych PRZED naprawa tej
// kolizji (patrz awarieHeaderMap_ wyzej). Teraz kod czyta "shift"/
// "type_cn" po nazwie z ich prawdziwych (pustych dla tych starych
// wierszy) kolumn, wiec te awarie znikaly z filtrow po zmianie
// (np. wykrzyknik w Statystykach przestawal sie pokazywac).
// Heurystyka: prawdziwa flaga alertu to zawsze puste albo `true` - jesli
// w alert_15min_sent/alert_1h_sent siedzi COKOLWIEK INNEGO (litera zmiany,
// tekst po chinsku), to na 99% ta zagubiona wartosc - przenosimy ja do
// wlasciwej kolumny i czyscimy zrodlowa.
function migrateAwarieColumns() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Awarie');
  if (!sheet) return;
  var map = awarieHeaderMap_(sheet);
  if (!map.hasOwnProperty('shift') || !map.hasOwnProperty('alert_15min_sent')) return;
  function looksLikeStrayValue(v) {
    if (!v && v !== 0) return false;
    if (v === true || String(v).toUpperCase() === 'TRUE') return false;
    return true;
  }
  var data = sheet.getDataRange().getValues();
  var migratedShift = 0, migratedCn = 0;
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var rowIdx = i + 1;
    var curShift = row[map['shift']];
    var alert15 = row[map['alert_15min_sent']];
    if (!curShift && looksLikeStrayValue(alert15)) {
      awarieSetField_(sheet, map, rowIdx, 'shift', alert15);
      awarieSetField_(sheet, map, rowIdx, 'alert_15min_sent', '');
      migratedShift++;
    }
    if (map.hasOwnProperty('type_cn') && map.hasOwnProperty('alert_1h_sent')) {
      var curCn = row[map['type_cn']];
      var alert1h = row[map['alert_1h_sent']];
      if (!curCn && looksLikeStrayValue(alert1h)) {
        awarieSetField_(sheet, map, rowIdx, 'type_cn', alert1h);
        awarieSetField_(sheet, map, rowIdx, 'alert_1h_sent', '');
        migratedCn++;
      }
    }
  }
  Logger.log('migrateAwarieColumns: shift=' + migratedShift + ', type_cn=' + migratedCn);
}

function backfillTypeCn() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Awarie');
  if (!sheet) return;
  ensureColumns_(sheet, AWARIE_HEADERS);
  var map = awarieHeaderMap_(sheet);
  var data = sheet.getDataRange().getValues();
  var updated = 0;
  for (var i = 1; i < data.length; i++) {
    var obj = awarieRowToObj_(data[i], map);
    if (!obj.type || obj.type_cn) continue;
    awarieSetField_(sheet, map, i + 1, 'type_cn', translateType_(obj.type).cn);
    updated++;
  }
  Logger.log('backfillTypeCn: zaktualizowano ' + updated + ' wierszy');
}

// Uruchom RECZNIE JEDEN RAZ - zaokragla juz istniejace czas_min z ulamkami
// (np. 61.333 min) do pelnych minut. Nowe awarie od teraz zapisuja sie juz
// zaokraglone (patrz handleAwariaEnd/handleEditAwariaDuration), ale stare
// wpisy w arkuszu nadal maja ulamki, dopoki nie uruchomi sie tej migracji.
function roundCzasMin() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Awarie');
  if (!sheet) return;
  var map = awarieHeaderMap_(sheet);
  if (!map.hasOwnProperty('czas_min')) return;
  var data = sheet.getDataRange().getValues();
  var updated = 0;
  for (var i = 1; i < data.length; i++) {
    var raw = data[i][map['czas_min']];
    var n = Number(raw);
    if (raw === '' || isNaN(n)) continue;
    var rounded = Math.round(n);
    if (rounded === n) continue;
    awarieSetField_(sheet, map, i + 1, 'czas_min', rounded);
    updated++;
  }
  Logger.log('roundCzasMin: zaokraglono ' + updated + ' wierszy');
}

// ── REWORK PROCESSING (bufor per strefa) ────────────────────────────
// timestamp | date | zone | processed | recovered | final_scrap | note | notes | reasons_json | zone_label | operator | recovered_reasons_json
// (zone_label/operator/recovered_reasons_json dopisane NA KONCU, zeby nie
// przesunac kolumn juz zapisanych wczesniej wierszy)
var REWORK_PROCESSING_HEADERS = ['timestamp', 'date', 'zone', 'processed', 'recovered', 'final_scrap', 'note', 'notes', 'reasons_json', 'zone_label', 'operator', 'recovered_reasons_json'];

function handleReworkProcessing(ss, p) {
  var sheet = getOrCreateSheet(ss, 'ReworkProcessing', REWORK_PROCESSING_HEADERS);
  ensureColumns_(sheet, REWORK_PROCESSING_HEADERS);
  var row = [
    p.timestamp || '', p.date || '', p.zone || '', Number(p.processed) || 0,
    Number(p.recovered) || 0, Number(p.final_scrap) || 0, p.note || '', p.notes || '', p.reasons_json || '',
    p.zone_label || '', p.operator || '', p.recovered_reasons_json || '',
  ];
  // Edycja istniejacego przetworzenia (patrz editReworkEntry w apce) —
  // podmien wiersz o oryginalnym timestampie zamiast dopisywac nowy. Zwykle
  // (nie-edycyjne) wyslania NIE ustawiaja orig_timestamp, wiec zawsze
  // dopisuja nowy wiersz — przetwarzanie bufora jest z natury addytywne
  // (kilka sesji dziennie na te sama strefe to normalka), w odroznieniu od
  // Raportu Godzinnego/Dziennego gdzie kazdy klucz jest unikalny z definicji.
  if (p.orig_timestamp) {
    var data = sheet.getDataRange().getValues();
    for (var i = data.length - 1; i >= 1; i--) {
      if (data[i][0] === p.orig_timestamp) {
        sheet.getRange(i + 1, 1, 1, row.length).setValues([row]);
        return jsonResponse({ status: 'ok', updated: true });
      }
    }
  }
  sheet.appendRow(row);
  return jsonResponse({ status: 'ok', updated: false });
}

function handleDeleteReworkProcessing(ss, p) {
  var sheet = ss.getSheetByName('ReworkProcessing');
  if (!sheet) return jsonResponse({ status: 'error', msg: 'brak danych' });
  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    if (data[i][0] === p.timestamp) {
      sheet.deleteRow(i + 1);
      return jsonResponse({ status: 'ok', deleted: true });
    }
  }
  return jsonResponse({ status: 'ok', deleted: false });
}

function handleReworkBuffer(ss, p) {
  var zoneKey = p.zone;
  var stations = REWORK_ZONES[zoneKey] || [];

  var reworkTotal = 0;
  var byReason = {};
  var reportSheet = ss.getSheetByName('RaportDzienny');
  if (reportSheet) {
    var data = reportSheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (stations.indexOf(data[i][3]) < 0) continue;
      reworkTotal += Number(data[i][7]) || 0;
      addReworkReasonsFromReport_(byReason, data[i][12]);
    }
  }

  var recoveredTotal = 0, finalScrapTotal = 0;
  var reworkSheet = ss.getSheetByName('ReworkProcessing');
  if (reworkSheet) {
    var rdata = reworkSheet.getDataRange().getValues();
    for (var j = 1; j < rdata.length; j++) {
      if (rdata[j][2] !== zoneKey) continue;
      recoveredTotal += Number(rdata[j][4]) || 0;
      finalScrapTotal += Number(rdata[j][5]) || 0;
      addReasonQty_(byReason, rdata[j][8], -1);  // reasons_json = przyczyny "Do złomowania"
      addReasonQty_(byReason, rdata[j][11], -1); // recovered_reasons_json = przyczyny "Odzyskane"
    }
  }
  Object.keys(byReason).forEach(function (r) { byReason[r] = Math.max(0, byReason[r]); });

  var buffer = Math.max(0, reworkTotal - recoveredTotal - finalScrapTotal);
  return jsonResponse({ status: 'ok', rework_total: reworkTotal, recovered_total: recoveredTotal, final_scrap_total: finalScrapTotal, buffer: buffer, by_reason: byReason });
}

function handleReworkHistory(ss, p) {
  var sheet = ss.getSheetByName('ReworkProcessing');
  var historia = [];
  if (sheet) {
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      if (p.zone && row[2] !== p.zone) continue;
      historia.push({
        timestamp: row[0], date: normalizeDate_(row[1]), zone: row[2], processed: Number(row[3]) || 0,
        recovered: Number(row[4]) || 0, final_scrap: Number(row[5]) || 0, note: row[6], notes: row[7],
        reasons_json: row[8] || '', zone_label: row[9] || '', operator: row[10] || '', recovered_reasons_json: row[11] || '',
      });
    }
  }
  historia.sort(function (a, b) { return new Date(b.timestamp) - new Date(a.timestamp); });
  return jsonResponse({ status: 'ok', historia: historia.slice(0, 20) });
}

// ── USTAWIENIA (synchronizacja miedzy telefonami) ───────────────────
// klucz | wartosc | updated_at
function handleSetUstawienie(ss, p) {
  var sheet = getOrCreateSheet(ss, 'Ustawienia', ['klucz', 'wartosc', 'updated_at']);
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === p.klucz) {
      sheet.getRange(i + 1, 2, 1, 2).setValues([[p.wartosc || '', new Date()]]);
      return jsonResponse({ status: 'ok' });
    }
  }
  sheet.appendRow([p.klucz, p.wartosc || '', new Date()]);
  return jsonResponse({ status: 'ok' });
}

function handleGetUstawienia(ss, p) {
  var sheet = ss.getSheetByName('Ustawienia');
  if (!sheet) return jsonResponse({ status: 'ok', ustawienia: {} });
  var data = sheet.getDataRange().getValues();
  var ustawienia = {};
  for (var i = 1; i < data.length; i++) {
    ustawienia[data[i][0]] = data[i][1];
  }
  return jsonResponse({ status: 'ok', ustawienia: ustawienia });
}

// ── PODSUMOWANIE DNIA (Feishu, co rano) ──────────────────────────────
// Odpalane przez trigger czasowy (patrz ustawTriggerPodsumowania ponizej,
// uruchom RECZNIE JEDEN RAZ z edytora Apps Script, zeby zainstalowac
// codzienne wywolanie) — podsumowuje WCZORAJSZY dzien: wykonanie planu +
// pass rate na GP12 (ta sama metoda co Statystyki/Premie — plan z ZYWEGO
// cfm_monthly_plan, nie z migawki w wierszu) oraz Awarie (ile, ile minut,
// z podzialem na stanowisko).
function wyslijPodsumowanieDnia() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var wczoraj = new Date();
  wczoraj.setDate(wczoraj.getDate() - 1);
  var dateIso = Utilities.formatDate(wczoraj, Session.getScriptTimeZone() || 'Europe/Warsaw', 'yyyy-MM-dd');

  var monthlyPlan = {}, stationTargets = {};
  var ustSheet = ss.getSheetByName('Ustawienia');
  if (ustSheet) {
    var udata = ustSheet.getDataRange().getValues();
    for (var u = 1; u < udata.length; u++) {
      if (udata[u][0] === 'cfm_monthly_plan') { try { monthlyPlan = JSON.parse(udata[u][1] || '{}'); } catch (e) {} }
      if (udata[u][0] === 'cfm_station_targets') { try { stationTargets = JSON.parse(udata[u][1] || '{}'); } catch (e) {} }
    }
  }

  // Per-stanowisko (nie tylko GP12) - kazde stanowisko, ktore mialo
  // JAKIKOLWIEK raport tego dnia, dostaje wlasna linijke wykonania planu +
  // pass rate. Agregacja PRZEZ WSZYSTKIE zmiany stanowiska naraz (tak jak
  // wczesniej dla samego GP12), nie osobno per zmiana - inaczej wiadomosc
  // zrobilaby sie za dluga przy kilku zmianach na stanowisko.
  var byStationPlan = {};
  var stationOrder = [];
  var sheet = ss.getSheetByName('RaportDzienny');
  if (sheet) {
    var data = sheet.getDataRange().getValues();
    var seenShifts = {};
    for (var i = 1; i < data.length; i++) {
      var r = data[i];
      if (normalizeDate_(r[1]) !== dateIso) continue;
      var st = r[3];
      if (!byStationPlan[st]) { byStationPlan[st] = { actual: 0, ok: 0, plan: 0, ngCount: 0 }; stationOrder.push(st); }
      var sObj = byStationPlan[st];
      sObj.actual += Number(r[5]) || 0;
      sObj.ok += Number(r[9]) || 0;
      sObj.ngCount += (Number(r[6]) || 0) + (Number(r[7]) || 0);
      var key = st + '||' + r[2];
      if (!seenShifts[key]) { seenShifts[key] = true; sObj.plan += planForDate_(monthlyPlan, stationTargets, st, r[2], dateIso); }
    }
  }
  stationOrder.sort();
  var stationLines = stationOrder.map(function (st) {
    var s = byStationPlan[st];
    var completion = s.plan > 0 ? Math.round((s.actual / s.plan) * 100) : null;
    var passRate = s.actual > 0 ? ((s.ok / s.actual) * 100).toFixed(1) : null;
    return '  ' + st + ': ' + (completion === null ? '—' : completion + '%') + ' (' + s.actual + '/' + s.plan + ' pcs / 件), pass ' + (passRate === null ? '—' : passRate + '%');
  }).join('\n');

  var awSheet = ss.getSheetByName('Awarie');
  var awarieCount = 0, awarieMin = 0, byStation = {};
  if (awSheet) {
    var adata = awSheet.getDataRange().getValues();
    for (var j = 1; j < adata.length; j++) {
      var ar = adata[j];
      if (ar[5] !== 'ZAMKNIETA' || normalizeDate_(ar[0]).slice(0, 10) !== dateIso) continue;
      awarieCount++;
      var min = Number(ar[4]) || 0;
      awarieMin += min;
      byStation[ar[1]] = (byStation[ar[1]] || 0) + min;
    }
  }
  // round1_ obcina blad zmiennoprzecinkowy przy sumowaniu ulamkowych minut
  // (bez tego np. 226.90000000000003 min trafialoby wprost na Feishu).
  var awarieLines = Object.keys(byStation).sort(function(a, b) { return byStation[b] - byStation[a]; })
    .map(function(st) { return '  ' + st + ': ' + round1_(byStation[st]) + ' min'; }).join('\n');

  var dd = dateIso.split('-');
  var text = '☀️ DAILY SUMMARY / 日总结 ' + dd[2] + '/' + dd[1] + '/' + dd[0] + '\n\n' +
    'Plan completion & pass rate / 计划完成率与合格率:\n' + (stationLines || '  —') + '\n\n' +
    'Breakdowns / 故障: ' + awarieCount + ' (total / 总计 ' + round1_(awarieMin) + ' min)' + (awarieLines ? '\n' + awarieLines : '');
  sendFeishuBotMessage_(text);
}

// Uruchom TĘ funkcję RĘCZNIE JEDEN RAZ z edytora Apps Script (wybierz z
// listy funkcji u góry, kliknij Uruchom), żeby zainstalować codzienny
// trigger o 6:00 wysyłający podsumowanie na Feishu. Bezpieczne uruchomić
// wielokrotnie — najpierw usuwa stare triggery tej samej funkcji, żeby
// nie zdublować wysyłki.
function ustawTriggerPodsumowania() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'wyslijPodsumowanieDnia') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('wyslijPodsumowanieDnia').timeBased().atHour(6).everyDays(1).create();
}

// ── ESKALACJA DLUGO OTWARTYCH AWARII (trigger co 5 min) ─────────────
// ODTWORZONE od podstaw (best-effort) — oryginalna funkcja o tej samej
// nazwie zostala przypadkowo skasowana przy nadpisaniu tego pliku (trigger
// zostal, ale wywolywal juz nieistniejaca funkcje - "Script function not
// found"), a jej oryginalnego kodu nie dalo sie odzyskac z historii wersji
// Apps Script. Kolumny alert_15min_sent/alert_1h_sent w arkuszu Awarie
// (dodane przez ORYGINALNA wersje tej funkcji) zostaly zachowane i sa tu
// uzyte zgodnie z ich nazwa: flaga ustawiana PO wyslaniu danego alertu,
// zeby nie wyslac go ponownie przy kolejnym uruchomieniu triggera.
// Progi (15 min / 1h) i tresc wiadomosci to najlepsze przyblizenie na
// podstawie nazw kolumn - popraw, jesli oryginal robil to inaczej.
function checkAwariaEscalations() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Awarie');
  if (!sheet) return;
  var map = awarieHeaderMap_(sheet);
  if (!map.hasOwnProperty('alert_15min_sent') || !map.hasOwnProperty('alert_1h_sent')) return;
  var tz = Session.getScriptTimeZone() || 'Europe/Warsaw';
  var data = sheet.getDataRange().getValues();
  var now = new Date();
  for (var i = 1; i < data.length; i++) {
    var obj = awarieRowToObj_(data[i], map);
    if (obj.status !== 'OTWARTA' || !obj.start_timestamp) continue;
    var start = new Date(obj.start_timestamp);
    var elapsedMin = (now - start) / 60000;
    var rowIdx = i + 1;
    var startTxt = Utilities.formatDate(start, tz, 'HH:mm');
    if (elapsedMin >= 60 && !obj.alert_1h_sent) {
      // Powyzej 1h -> glowna grupa (szefowie) - powazniejsza eskalacja.
      sendFeishuBotMessage_('⏱️ BREAKDOWN OPEN 1H+ / 故障持续超过1小时\n' + obj.station + ' · ' + (obj.type || 'Awaria') + (obj.operator ? '\nReported by / 报告人: ' + obj.operator : '') + '\nOpen since / 开始于: ' + startTxt, FEISHU_BOT_WEBHOOK);
      awarieSetField_(sheet, map, rowIdx, 'alert_1h_sent', true);
    } else if (elapsedMin >= 15 && !obj.alert_15min_sent) {
      // 15 min -> grupa technikow, zeby ktos poszedl to naprawic zanim
      // eskaluje dalej. Dopoki FEISHU_BOT_WEBHOOK_TECHNICY nie jest
      // uzupelniony, NIE wysylamy tego wcale (celowo nie wpada na glowna
      // grupe jako fallback - to bylby spam nie dla tych odbiorcow).
      if (FEISHU_BOT_WEBHOOK_TECHNICY) {
        sendFeishuBotMessage_('⏱️ BREAKDOWN OPEN 15MIN+ / 故障持续超过15分钟\n' + obj.station + ' · ' + (obj.type || 'Awaria') + (obj.operator ? '\nReported by / 报告人: ' + obj.operator : '') + '\nOpen since / 开始于: ' + startTxt, FEISHU_BOT_WEBHOOK_TECHNICY);
      }
      awarieSetField_(sheet, map, rowIdx, 'alert_15min_sent', true);
    }
  }
}

// Uruchom RECZNIE JEDEN RAZ, zeby zainstalowac trigger co 5 minut (ten sam
// odstep co widoczny w historii wykonan sprzed znikniecia funkcji).
function ustawTriggerEscalations() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'checkAwariaEscalations') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkAwariaEscalations').timeBased().everyMinutes(5).create();
}

// ── WYPADKI (BHP) ────────────────────────────────────────────────────
// timestamp | date | station | severity | description | operator
// Osobny, prosty arkusz - w odroznieniu od Awarii nie ma stanu
// OTWARTA/ZAMKNIETA (wypadek zglasza sie raz, po fakcie), wiec tylko
// zapis + odczyt, bez logiki start/koniec.
var WYPADKI_HEADERS = ['timestamp', 'date', 'station', 'severity', 'description', 'operator'];
function handleZglosWypadek(ss, p) {
  var sheet = getOrCreateSheet(ss, 'Wypadki', WYPADKI_HEADERS);
  ensureColumns_(sheet, WYPADKI_HEADERS);
  var tz = Session.getScriptTimeZone() || 'Europe/Warsaw';
  var dateStr = p.date || Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  sheet.appendRow([p.timestamp || new Date().toISOString(), dateStr, p.stanowisko || '', p.severity || '', p.description || '', p.operator || '']);
  // Wypadek jest pilniejszy niz zwykla awaria maszyny - zawsze na glowna
  // grupe (ta sama co alert eskalacji 1h+), niezaleznie od powagi.
  sendFeishuBotMessage_('🚨 WORKPLACE INCIDENT / 工伤事故\n' + (p.stanowisko || '?') + ' · ' + (p.severity || '?') + (p.description ? '\n' + p.description : '') + (p.operator ? '\nReported by / 报告人: ' + p.operator : ''));
  return jsonResponse({ status: 'ok' });
}

// Cala historia (nie tylko zakres dat) - wypadki sa rzadkie, wiec prosciej
// zwrocic wszystko i pozwolic frontendowi (np. licznik "dni bez wypadku"
// na Dashboardzie) samemu przefiltrowac/policzyc, niz dodawac kolejny
// parametr zakresu tylko dla tego jednego, malego zrodla danych.
function handleWypadkiHistoria(ss, p) {
  var sheet = ss.getSheetByName('Wypadki');
  if (!sheet) return jsonResponse({ status: 'ok', historia: [] });
  var data = sheet.getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    rows.push({ timestamp: r[0], date: normalizeDate_(r[1]), station: r[2], severity: r[3], description: r[4], operator: r[5] || '' });
  }
  rows.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  return jsonResponse({ status: 'ok', historia: rows });
}
