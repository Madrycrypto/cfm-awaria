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
    var adata = awSheet.getDataRange().getValues();
    for (var k = 1; k < adata.length; k++) {
      var ar = adata[k];
      if (ar[5] !== 'ZAMKNIETA') continue;
      var ad = normalizeDate_(ar[0]).slice(0, 10);
      if (p.start && ad < p.start) continue;
      if (p.end && ad > p.end) continue;
      awarieHistoria.push({ date: ad, station: ar[1], type: ar[2], shift: ar[7] || '', czas_min: Number(ar[4]) || 0 });
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
      if (!byKey[key]) byKey[key] = { station: r[3], shift: r[2], sumQty: 0, sumOk: 0, sumPlan: 0, count: 0 };
      byKey[key].sumQty += Number(r[5]) || 0;
      byKey[key].sumOk += Number(r[9]) || 0;
      byKey[key].sumPlan += planForDate_(monthlyPlan, stationTargets, r[3], r[2], d);
      byKey[key].count += 1;
    }
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
    var adata = awSheet.getDataRange().getValues();
    for (var j = 1; j < adata.length; j++) {
      var ar = adata[j];
      if (ar[5] !== 'ZAMKNIETA') continue;
      var ad = normalizeDate_(ar[0]).slice(0, 10);
      if (p.start && ad < p.start) continue;
      if (p.end && ad > p.end) continue;
      var dtKey = ar[1] + '||' + (ar[7] || '');
      downtimeByKey[dtKey] = (downtimeByKey[dtKey] || 0) + (Number(ar[4]) || 0);
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
// start_timestamp | station | type | koniec_timestamp | czas_min | status | operator | shift
// (shift dopisany NA KONCU — zmiana to tozsamosc grupy A/B/C operatora w
// momencie zgloszenia awarii, potrzebna do poprawnego przypisania
// przestoju do wlasciwej grupy w wyliczeniu premii; zapisywana tylko przy
// START, KONIEC jej nie nadpisuje. Type NATOMIAST jest teraz nadpisywany
// przy KONCU — opis przyczyny przenosi sie z app-side ze startu na koniec
// (operator startujacy awarie czesto jeszcze nie wie co dokladnie sie
// stalo; dopiero KONIEC niesie ostateczny typ+opis), START zapisuje na razie
// tylko sama kategorie bez opisu.)
var AWARIE_HEADERS = ['start_timestamp', 'station', 'type', 'koniec_timestamp', 'czas_min', 'status', 'operator', 'shift'];
function handleAwariaStart(ss, p) {
  var sheet = getOrCreateSheet(ss, 'Awarie', AWARIE_HEADERS);
  ensureColumns_(sheet, AWARIE_HEADERS);
  sheet.appendRow([p.timestamp || '', p.stanowisko || '', p.typ || '', '', '', 'OTWARTA', p.operator || '', p.shift || '']);
  return jsonResponse({ status: 'ok' });
}

function handleAwariaEnd(ss, p) {
  var sheet = getOrCreateSheet(ss, 'Awarie', AWARIE_HEADERS);
  ensureColumns_(sheet, AWARIE_HEADERS);
  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    var row = data[i];
    if (row[0] === p.start_timestamp && row[1] === p.stanowisko && row[5] === 'OTWARTA') {
      sheet.getRange(i + 1, 3, 1, 4).setValues([[p.typ || row[2], p.koniec_timestamp || '', Number(p.czas_min) || 0, 'ZAMKNIETA']]);
      return jsonResponse({ status: 'ok' });
    }
  }
  // Nie znaleziono otwartego wiersza (np. reset stanu w aplikacji) — dopisz kompletny wiersz.
  sheet.appendRow([p.start_timestamp || '', p.stanowisko || '', p.typ || '', p.koniec_timestamp || '', Number(p.czas_min) || 0, 'ZAMKNIETA', p.operator || '', p.shift || '']);
  return jsonResponse({ status: 'ok' });
}

function handleAwariaCheck(ss, p) {
  var sheet = ss.getSheetByName('Awarie');
  if (!sheet) return jsonResponse({ open: false });
  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    var row = data[i];
    if (row[1] === p.stanowisko && row[5] === 'OTWARTA') {
      var startIso = row[0];
      var diffMin = Math.round((new Date() - new Date(startIso)) / 60000);
      return jsonResponse({ open: true, awaria: { typ: row[2], start: startIso, startIso: startIso, diffMin: diffMin, operator: row[6] } });
    }
  }
  return jsonResponse({ open: false });
}

// Historia Awarii pobierana na zywo (nie z pamieci telefonu) — kazdy
// operator na kazdym urzadzeniu widzi to samo. Tylko zamkniete awarie,
// opcjonalnie filtrowane po stanowisku, najnowsze pierwsze.
function handleAwariaHistoria(ss, p) {
  var sheet = ss.getSheetByName('Awarie');
  if (!sheet) return jsonResponse({ status: 'ok', historia: [] });
  var data = sheet.getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (r[5] !== 'ZAMKNIETA') continue;
    if (p.stanowisko && r[1] !== p.stanowisko) continue;
    rows.push({ station: r[1], type: r[2], start_timestamp: r[0], koniec_timestamp: r[3], czas_min: Number(r[4]) || 0, operator: r[6] || '' });
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
  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    var r = data[i];
    if (r[0] === p.start_timestamp && r[1] === p.stanowisko && r[2] === p.typ && r[5] === 'ZAMKNIETA') {
      sheet.getRange(i + 1, 5).setValue(Number(p.czas_min) || 0);
      return jsonResponse({ status: 'ok', updated: true });
    }
  }
  return jsonResponse({ status: 'ok', updated: false });
}

function handleDeleteAwaria(ss, p) {
  var sheet = ss.getSheetByName('Awarie');
  if (!sheet) return jsonResponse({ status: 'error', msg: 'brak danych' });
  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    var r = data[i];
    if (r[0] === p.start_timestamp && r[1] === p.stanowisko && r[2] === p.typ) {
      sheet.deleteRow(i + 1);
      return jsonResponse({ status: 'ok', deleted: true });
    }
  }
  return jsonResponse({ status: 'ok', deleted: false });
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
