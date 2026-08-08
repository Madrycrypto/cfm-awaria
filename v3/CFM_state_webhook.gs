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
 * Rola tego arkusza: dziala jako pomocniczy licznik stanu dla funkcji,
 * ktore faktycznie musza dzialac w obie strony:
 *   - Awaria: sprawdzenie czy na stanowisku jest juz otwarta awaria
 *     przed dodaniem nowej (SPRAWDZ / START / KONIEC)
 *   - Rework: bufor zaleglosci per strefa (REWORK_BUFFER / REWORK_HISTORY),
 *     zeby aplikacja mogla zwalidowac "odzyskane + zlom" przeciwko temu,
 *     co faktycznie jest w kolejce
 *   - Ustawienia: wspolna konfiguracja Panelu Admina (pracownicy,
 *     stanowiska, przyczyny, typy awarii, cele, zmiany/nadgodziny) —
 *     apka zapisuje tu kopie kazdej zmiany (POST) i pobiera wszystko
 *     przy starcie (GET_USTAWIENIA), zeby kazdy telefon mial to samo
 *     bez recznego przepisywania na kazdym z osobna
 *   - Alerty na czat Feishu (przez dedykowanego custom bota, nie przez
 *     Base): natychmiastowa wiadomosc przy starcie awarii, eskalacja po
 *     15 min / 1h (checkAwariaEscalations, trigger czasowy co 5 min) i
 *     raport dobowy o 7:30 (sendDailyReport, trigger czasowy dzienny)
 * Trwaly zapis danych produkcyjnych i tak idzie rownolegle do Feishu Base
 * (aplikacja wysyla do obu na raz, gdy oba sa skonfigurowane) — ten
 * arkusz nie jest zamiennikiem Feishu, tylko dodatkowa pamiecia
 * operacyjna dla funkcji ktorych Feishu nie potrafi obsluzyc.
 *
 * Wdrozenie:
 *   1. Utworz nowy arkusz Google Sheets (dowolna nazwa, np. "CFM Stan")
 *   2. Rozszerzenia -> Apps Script
 *   3. Wklej cala zawartosc tego pliku, zastepujac domyslny Code.gs
 *   4. Wdroz -> Nowe wdrozenie -> Typ: Aplikacja internetowa
 *      - Wykonaj jako: Ja
 *      - Kto ma dostep: Wszyscy
 *   5. Skopiuj adres URL wdrozenia (konczy sie na /exec)
 *   6. W aplikacji CFM: Panel Admina -> Połączenie -> wklej w "Webhook URL"
 *
 * Zakladki tworza sie automatycznie przy pierwszym zapisie — nie trzeba
 * nic przygotowywac recznie w arkuszu.
 */

var REWORK_ZONES = {
  'OP33A_B': ['OP33A', 'OP33B'],
  'OP60_61': ['OP60/61'],
  'GP12': ['GP12'],
  'OP40': ['OP40 IN', 'OP40 OUT'],
  'OP51_52': ['OP51/52'],
};

// Dedykowany custom bot (webhook) w grupie alertow awarii — NIE ten sam co
// generyczny "Base Assistant" wspoldzielony przez wszystkie automatyzacje.
var WEBHOOK_BOT_AWARIA = 'https://open.feishu.cn/open-apis/bot/v2/hook/4c3cb956-3022-4e95-adbd-eaead7efedaa';

// Brak dostepu do prawdziwych User ID (wymaga uprawnien admina Feishu) —
// wzmianki sa wiec zwyklym tekstem, nie prawdziwym @ (bez powiadomienia
// systemowego). Latwo podmienic pozniej, jesli ID sie znajdzie.
var ESKALACJA_15MIN = 'Maciej Mostowski';
var ESKALACJA_1H = 'Bin Lu';

function sendBotMessage_(text) {
  try {
    UrlFetchApp.fetch(WEBHOOK_BOT_AWARIA, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ msg_type: 'text', content: { text: text } }),
      muteHttpExceptions: true,
    });
  } catch (err) {
    // Nie przerywaj glownej logiki (zapis do arkusza) z powodu bledu wysylki czatu.
  }
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  try {
    switch (p.event_type) {
      case 'RAPORT_DZIENNY': return handleReport(ss, p);
      case 'START': return handleAwariaStart(ss, p);
      case 'KONIEC': return handleAwariaEnd(ss, p);
      case 'SPRAWDZ': return handleAwariaCheck(ss, p);
      case 'AWARIA_HISTORIA': return handleAwariaHistoria(ss, p);
      case 'HISTORIA_DZIENNA': return handleHistoriaDzienna(ss, p);
      case 'RAPORT_GODZINNY': return handleRaportGodzinny(ss, p);
      case 'HISTORIA_GODZINNA': return handleHistoriaGodzinna(ss, p);
      case 'REWORK_PROCESSING': return handleReworkProcessing(ss, p);
      case 'REWORK_BUFFER': return handleReworkBuffer(ss, p);
      case 'REWORK_HISTORY': return handleReworkHistory(ss, p);
      case 'GET_USTAWIENIA': return handleGetUstawienia(ss, p);
      case 'TEST': return jsonResponse({ status: 'ok', msg: 'polaczenie dziala' });
      default: return jsonResponse({ status: 'error', msg: 'nieznany event_type: ' + p.event_type });
    }
  } catch (err) {
    return jsonResponse({ status: 'error', msg: String(err) });
  }
}

// POST uzywany tylko przez zapis ustawien (Panel Admina) — body jako
// text/plain JSON, zeby uniknac CORS preflight (Apps Script nie obsluguje
// OPTIONS), tak samo jak przy odczycie przez doGet.
function doPost(e) {
  var p = {};
  try {
    var raw = e && e.postData && e.postData.contents;
    if (raw) p = JSON.parse(raw);
  } catch (parseErr) {
    return jsonResponse({ status: 'error', msg: 'niepoprawny JSON: ' + String(parseErr) });
  }
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

// ── RAPORT DOBOWY (7:30, poprzednia doba) ───────────────────────────
// Wywolywana przez trigger czasowy (Apps Script -> Triggers -> Add Trigger ->
// sendDailyReport -> Time-driven -> Day timer -> 7-8am). Podsumowuje
// wczorajsza produkcje ze wszystkich stanowisk (3 zmiany razem) i wysyla
// przez tego samego dedykowanego bota co eskalacje awarii.
function sendDailyReport() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var reportSheet = ss.getSheetByName('RaportDzienny');
  if (!reportSheet) return;

  var tz = Session.getScriptTimeZone() || 'Europe/Warsaw';
  var yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  var dateStr = Utilities.formatDate(yesterday, tz, 'yyyy-MM-dd');

  var dailyTargets = getStationDailyTargets_(ss);
  var stations = Object.keys(dailyTargets).length ? Object.keys(dailyTargets) : ['OP30', 'OP33A', 'OP33B', 'OP40 IN', 'OP40 OUT', 'OP51/52', 'OP60/61', 'GP12'];

  var totals = {};
  stations.forEach(function(st) { totals[st] = { qty: 0, scrap: 0, rework: 0, recovered: 0 }; });

  var data = reportSheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (row[1] !== dateStr) continue;
    var station = row[3];
    if (!totals[station]) totals[station] = { qty: 0, scrap: 0, rework: 0, recovered: 0 };
    totals[station].qty += Number(row[5]) || 0;
    totals[station].scrap += Number(row[6]) || 0;
    totals[station].rework += Number(row[7]) || 0;
    totals[station].recovered += Number(row[8]) || 0;
  }

  var lines = ['📊 RAPORT DOBOWY · 每日报告 ' + dateStr];
  stations.forEach(function(st) {
    var t = totals[st];
    var ok = Math.max(0, t.qty - t.scrap - t.rework + t.recovered);
    var passRate = t.qty > 0 ? (ok / t.qty * 100) : null;
    var cel = dailyTargets[st] || 0;
    var pctPlan = cel > 0 ? (t.qty / cel * 100) : null;
    lines.push(
      st + ': ' + t.qty + (cel > 0 ? '/' + cel : '') + ' szt' +
      (pctPlan !== null ? ' (' + pctPlan.toFixed(0) + '%)' : '') +
      (passRate !== null ? ' | pass rate 合格率 ' + passRate.toFixed(1) + '%' : ' | brak danych · 无数据')
    );
  });
  lines.push('');
  lines.push(ESKALACJA_15MIN + ' ' + ESKALACJA_1H);

  sendBotMessage_(lines.join('\n'));
}

// Cel/zmiane z zakladki Ustawienia (ten sam co w Panelu Admina -> Cele) x
// liczba zmian = cel na cala dobe.
function getStationDailyTargets_(ss) {
  var sheet = ss.getSheetByName('Ustawienia');
  if (!sheet) return {};
  var data = sheet.getDataRange().getValues();
  var perShift = {}, liczbaZmian = 3;
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === 'cfm_station_targets') {
      try { perShift = JSON.parse(data[i][1]); } catch (e) {}
    }
    if (data[i][0] === 'cfm_shifts') {
      try {
        var sh = JSON.parse(data[i][1]);
        if (sh && sh.liczba) liczbaZmian = sh.liczba;
      } catch (e) {}
    }
  }
  var daily = {};
  Object.keys(perShift).forEach(function(st) { daily[st] = Number(perShift[st]) * liczbaZmian; });
  return daily;
}

// ── RAPORT ZMIANY ────────────────────────────────────────────────────
// timestamp | date | shift | station | operator | qty | scrap | rework | recovered | ok_count | pass_rate | notes | reasons_json
// Jeden wpis na date+shift+station+operator — poprawka (edytuj) nadpisuje
// ten sam wiersz zamiast dopisywac duplikat, zeby sumy sie nie podwajaly.
// Uwaga: to dziala tylko po stronie arkusza Google — automatyzacja Feishu
// Base i tak moze tylko dopisywac (write-only), wiec tam poprawiony wpis
// pojawi sie jako DODATKOWY wiersz z nowszym timestampem, nie nadpisze
// poprzedniego (ten sam ograniczenie co przy awariach).
//
// "recovered" apka wysyla teraz zawsze jako 0 — rework nie jest naprawiany
// w tej samej zmianie co powstal, wiec w Raporcie Zmiany nie ma juz pola do
// tego. Jedyne miejsce, gdzie cos faktycznie zostaje odzyskane, to
// ReworkProcessing (przetwarzanie bufora, ponizej) — dzieki temu kazda
// sztuka liczy sie tylko raz, zamiast podwojnie (raz w zmianie, raz w buforze).
function handleReport(ss, p) {
  var sheet = getOrCreateSheet(ss, 'RaportDzienny', ['timestamp', 'date', 'shift', 'station', 'operator', 'qty', 'scrap', 'rework', 'recovered', 'ok_count', 'pass_rate', 'notes', 'reasons_json']);
  var row = [
    p.timestamp || '', p.date || '', p.shift || '', p.station || '', p.operator || '',
    Number(p.qty) || 0, Number(p.scrap) || 0, Number(p.rework) || 0, Number(p.recovered) || 0,
    Number(p.ok_count) || 0, p.pass_rate || '', p.notes || '', p.reasons_json || '',
  ];
  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    var r = data[i];
    if (r[1] === p.date && r[2] === p.shift && r[3] === p.station && r[4] === p.operator) {
      sheet.getRange(i + 1, 1, 1, row.length).setValues([row]);
      return jsonResponse({ status: 'ok', updated: true });
    }
  }
  sheet.appendRow(row);
  return jsonResponse({ status: 'ok', updated: false });
}

function handleHistoriaDzienna(ss, p) {
  var sheet = ss.getSheetByName('RaportDzienny');
  if (!sheet) return jsonResponse({ status: 'error', msg: 'brak danych' });
  var data = sheet.getDataRange().getValues();
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Europe/Warsaw', 'yyyy-MM-dd');
  var historia = [], suma = 0, scrap = 0, rework = 0, recovered = 0;
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (r[1] !== today) continue;
    if (p.stanowisko && r[3] !== p.stanowisko) continue;
    if (p.operator && r[4] !== p.operator) continue;
    var entry = { timestamp: r[0], date: r[1], shift: r[2], station: r[3], operator: r[4], qty: Number(r[5]) || 0, scrap: Number(r[6]) || 0, rework: Number(r[7]) || 0, recovered: Number(r[8]) || 0, ok_count: Number(r[9]) || 0, pass_rate: r[10], notes: r[11], reasons_json: r[12] || '' };
    historia.push(entry);
    suma += entry.qty; scrap += entry.scrap; rework += entry.rework; recovered += entry.recovered;
  }
  return jsonResponse({ status: 'ok', historia: historia, suma: suma, scrap: scrap, rework: rework, recovered: recovered });
}

// ── RAPORT GODZINNY ──────────────────────────────────────────────────
// Osobna zakladka od RaportDzienny — to tylko ROBOCZA lista w ciagu zmiany,
// nie zasila bufora reworku ani Feishu bezposrednio. Suma godzinnych
// wpisow (qty + rework per przyczyna) sluzy do WSTEPNEGO WYPELNIENIA
// Raportu Zmiany na koncu zmiany — dopiero wyslanie Raportu Zmiany
// faktycznie zapisuje dane i zasila bufor, zeby nic nie liczylo sie podwojnie.
// timestamp | date | shift | hour | station | operator | qty | rework | rework_reasons_json | rework_other_desc | delay
function handleRaportGodzinny(ss, p) {
  var sheet = getOrCreateSheet(ss, 'RaportGodzinny', ['timestamp', 'date', 'shift', 'hour', 'station', 'operator', 'qty', 'rework', 'rework_reasons_json', 'rework_other_desc', 'delay']);
  var tz = Session.getScriptTimeZone() || 'Europe/Warsaw';
  var dateStr = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  sheet.appendRow([
    p.timestamp || '', dateStr, p.shift || '', p.hour || '', p.station || '', p.operator || '',
    Number(p.qty) || 0, Number(p.rework) || 0, p.rework_reasons_json || '', p.rework_other_desc || '', p.delay || '',
  ]);
  return jsonResponse({ status: 'ok' });
}

function handleHistoriaGodzinna(ss, p) {
  var sheet = ss.getSheetByName('RaportGodzinny');
  if (!sheet) return jsonResponse({ status: 'ok', historia: [], suma: 0, rework: 0 });
  var tz = Session.getScriptTimeZone() || 'Europe/Warsaw';
  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var data = sheet.getDataRange().getValues();
  var historia = [], suma = 0, rework = 0;
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (r[1] !== today) continue;
    if (p.stanowisko && r[4] !== p.stanowisko) continue;
    if (p.operator && r[5] !== p.operator) continue;
    if (p.shift && r[2] !== p.shift) continue;
    var qty = Number(r[6]) || 0, reworkVal = Number(r[7]) || 0;
    historia.push({ timestamp: r[0], date: r[1], shift: r[2], godzina: r[3], station: r[4], operator: r[5], qty: qty, rework: reworkVal, rework_reasons_json: r[8] || '', rework_other_desc: r[9] || '', delay: r[10] });
    suma += qty; rework += reworkVal;
  }
  return jsonResponse({ status: 'ok', historia: historia, suma: suma, rework: rework });
}

// ── AWARIE ──────────────────────────────────────────────────────────
// start_timestamp | station | type | koniec_timestamp | czas_min | status | operator | alert_15min_sent | alert_1h_sent
// Kolejne pola sa zawsze dopisywane na koncu (nie wstawiane w srodku), zeby
// nie przesunac istniejacych kolumn i nie zepsuc juz zapisanych wierszy —
// dziala tak samo dla nowego arkusza i dla juz uzywanego.
function handleAwariaStart(ss, p) {
  var sheet = getOrCreateSheet(ss, 'Awarie', ['start_timestamp', 'station', 'type', 'koniec_timestamp', 'czas_min', 'status', 'operator']);
  ensureAwarieOperatorColumn(sheet);
  ensureAwarieAlertColumns(sheet);
  sheet.appendRow([p.timestamp || '', p.stanowisko || '', p.typ || '', '', '', 'OTWARTA', p.operator || '', '', '']);
  sendBotMessage_(
    '🔴 Nowa awaria · 新故障: ' + (p.stanowisko || '') + '\n' +
    'Typ · 类型: ' + (p.typ || '') + '\n' +
    'Operator · 操作员: ' + (p.operator || '-') + '\n' +
    'Start · 开始时间: ' + (p.timestamp || '')
  );
  return jsonResponse({ status: 'ok' });
}

function handleAwariaEnd(ss, p) {
  var sheet = getOrCreateSheet(ss, 'Awarie', ['start_timestamp', 'station', 'type', 'koniec_timestamp', 'czas_min', 'status', 'operator']);
  ensureAwarieOperatorColumn(sheet);
  ensureAwarieAlertColumns(sheet);
  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    var row = data[i];
    if (row[0] === p.start_timestamp && row[1] === p.stanowisko && row[5] === 'OTWARTA') {
      sheet.getRange(i + 1, 4, 1, 3).setValues([[p.koniec_timestamp || '', Number(p.czas_min) || 0, 'ZAMKNIETA']]);
      return jsonResponse({ status: 'ok' });
    }
  }
  // Nie znaleziono otwartego wiersza (np. reset stanu w aplikacji) — dopisz kompletny wiersz.
  sheet.appendRow([p.start_timestamp || '', p.stanowisko || '', p.typ || '', p.koniec_timestamp || '', Number(p.czas_min) || 0, 'ZAMKNIETA', p.operator || '', '', '']);
  return jsonResponse({ status: 'ok' });
}

function ensureAwarieOperatorColumn(sheet) {
  if (!sheet.getRange(1, 7).getValue()) sheet.getRange(1, 7).setValue('operator');
}

function ensureAwarieAlertColumns(sheet) {
  if (!sheet.getRange(1, 8).getValue()) sheet.getRange(1, 8).setValue('alert_15min_sent');
  if (!sheet.getRange(1, 9).getValue()) sheet.getRange(1, 9).setValue('alert_1h_sent');
}

// Wywolywana co 5 minut przez trigger czasowy (Apps Script -> Triggers ->
// Add Trigger -> checkAwariaEscalations -> Time-driven -> Minutes timer -> Every 5 minutes).
// Skanuje otwarte awarie i eskaluje po 15 min / 1h, wysylajac przez dedykowanego
// bota (WEBHOOK_BOT_AWARIA) — kolumny H/I pilnuja, zeby nie wyslac dwa razy.
function checkAwariaEscalations() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Awarie');
  if (!sheet) return;
  ensureAwarieAlertColumns(sheet);
  var data = sheet.getDataRange().getValues();
  var now = new Date();
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (row[5] !== 'OTWARTA') continue;
    var startIso = row[0];
    if (!startIso) continue;
    var diffMin = (now - new Date(startIso)) / 60000;
    var station = row[1], type = row[2], operator = row[6] || '-';
    var alert15Sent = row[7], alert60Sent = row[8];

    if (diffMin >= 60 && !alert60Sent) {
      sendBotMessage_(
        '🆘 ESKALACJA (1h bez reakcji) · 升级提醒（1小时无响应）: ' + station + '\n' +
        'Typ · 类型: ' + type + '\n' +
        'Operator · 操作员: ' + operator + '\n' +
        'Otwarta od · 已持续: ' + Math.round(diffMin) + ' min · 分钟\n' +
        ESKALACJA_1H
      );
      sheet.getRange(i + 1, 9).setValue(true);
    } else if (diffMin >= 15 && !alert15Sent) {
      sendBotMessage_(
        '⚠️ ESKALACJA (15 min bez reakcji) · 升级提醒（15分钟无响应）: ' + station + '\n' +
        'Typ · 类型: ' + type + '\n' +
        'Operator · 操作员: ' + operator + '\n' +
        'Otwarta od · 已持续: ' + Math.round(diffMin) + ' min · 分钟\n' +
        ESKALACJA_15MIN
      );
      sheet.getRange(i + 1, 8).setValue(true);
    }
  }
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
      return jsonResponse({ open: true, awaria: { typ: row[2], operator: row[6] || '', start: startIso, startIso: startIso, diffMin: diffMin } });
    }
  }
  return jsonResponse({ open: false });
}

// Historia zamknietych awarii — czytana na zywo z arkusza, nie z pamieci
// telefonu, zeby czyszczenie danych po stronie serwera faktycznie czyscilo
// to, co widzi operator (wczesniej apka trzymala kopie lokalnie i pokazywala
// ja nawet po wyczyszczeniu arkusza).
function handleAwariaHistoria(ss, p) {
  var sheet = ss.getSheetByName('Awarie');
  if (!sheet) return jsonResponse({ status: 'ok', historia: [] });
  var data = sheet.getDataRange().getValues();
  var historia = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (row[5] !== 'ZAMKNIETA') continue;
    if (p.stanowisko && row[1] !== p.stanowisko) continue;
    historia.push({ station: row[1], type: row[2], start_timestamp: row[0], koniec_timestamp: row[3], czas_min: row[4], operator: row[6] || '' });
  }
  historia.sort(function (a, b) { return new Date(b.start_timestamp) - new Date(a.start_timestamp); });
  return jsonResponse({ status: 'ok', historia: historia.slice(0, 20) });
}

// ── REWORK PROCESSING (bufor per strefa) ────────────────────────────
// timestamp | date | zone | processed | recovered | final_scrap | note | notes | reasons_json
function handleReworkProcessing(ss, p) {
  var sheet = getOrCreateSheet(ss, 'ReworkProcessing', ['timestamp', 'date', 'zone', 'processed', 'recovered', 'final_scrap', 'note', 'notes', 'reasons_json']);
  sheet.appendRow([
    p.timestamp || '', p.date || '', p.zone || '', Number(p.processed) || 0,
    Number(p.recovered) || 0, Number(p.final_scrap) || 0, p.note || '', p.notes || '', p.reasons_json || '',
  ]);
  return jsonResponse({ status: 'ok' });
}

// Bufor per przyczyna: ile z kazdego konkretnego powodu rework (np. "wystajace
// paski") wciaz czeka na ostateczne rozstrzygniecie — rework z RaportDzienny
// minus to, co juz zezlomowano (final_scrap) z tego samego powodu. Naprawione
// (odzyskane) sztuki NIE sa odejmowane per przyczyna — "odzyskane" liczy sie
// tylko zbiorczo (przetworzono minus finalny zlom), bez przypisania do
// konkretnego powodu, bo naprawiona sztuka przestaje byc istotna dla analizy
// przyczyn jakosciowych. Patrz ustalenia z uzytkownikiem w rozmowie.
function addReasonQty_(map, reasonsJson, sign) {
  if (!reasonsJson) return;
  var entries = [];
  try { entries = JSON.parse(reasonsJson); } catch (e) { return; }
  entries.forEach(function(e) {
    if (!e || !e.reason) return;
    map[e.reason] = (map[e.reason] || 0) + sign * (Number(e.qty) || 0);
  });
}

function handleReworkBuffer(ss, p) {
  var zone = p.zone;
  var stations = REWORK_ZONES[zone] || [];

  var reworkTotal = 0;
  var byReason = {};
  var reportSheet = ss.getSheetByName('RaportDzienny');
  if (reportSheet) {
    var data = reportSheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (stations.indexOf(data[i][3]) >= 0) {
        reworkTotal += Number(data[i][7]) || 0;
        var reasons = {};
        try { reasons = JSON.parse(data[i][12] || '{}'); } catch (e) {}
        addReasonQty_(byReason, JSON.stringify(reasons.rework || []), 1);
      }
    }
  }

  var recoveredTotal = 0, finalScrapTotal = 0;
  var reworkSheet = ss.getSheetByName('ReworkProcessing');
  if (reworkSheet) {
    var rdata = reworkSheet.getDataRange().getValues();
    for (var j = 1; j < rdata.length; j++) {
      if (rdata[j][2] === zone) {
        recoveredTotal += Number(rdata[j][4]) || 0;
        finalScrapTotal += Number(rdata[j][5]) || 0;
        addReasonQty_(byReason, rdata[j][8], -1); // final_scrap entries (reasons_json)
      }
    }
  }

  Object.keys(byReason).forEach(function(r) { byReason[r] = Math.max(0, byReason[r]); });
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
      historia.push({ timestamp: row[0], date: row[1], zone: row[2], processed: Number(row[3]) || 0, recovered: Number(row[4]) || 0, final_scrap: Number(row[5]) || 0, note: row[6], notes: row[7], reasons_json: row[8] || '' });
    }
  }
  historia.sort(function (a, b) { return new Date(b.timestamp) - new Date(a.timestamp); });
  return jsonResponse({ status: 'ok', historia: historia.slice(0, 20) });
}

// ── USTAWIENIA (wspolna konfiguracja dla wszystkich telefonow) ─────────
// klucz | wartosc (JSON string zapisany przez apke) | zaktualizowano
// Apka wysyla tu kopie kazdego zapisu z Panelu Admina (pracownicy,
// stanowiska, przyczyny, typy awarii, cele, zmiany/nadgodziny) i przy
// starcie pobiera wszystko, zeby kazdy telefon mial to samo bez
// recznego przepisywania.
function handleGetUstawienia(ss, p) {
  var sheet = ss.getSheetByName('Ustawienia');
  var out = {};
  if (sheet) {
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (data[i][0]) out[data[i][0]] = data[i][1];
    }
  }
  return jsonResponse({ status: 'ok', ustawienia: out });
}

function handleSetUstawienie(ss, p) {
  if (!p.klucz) return jsonResponse({ status: 'error', msg: 'brak klucza' });
  var sheet = getOrCreateSheet(ss, 'Ustawienia', ['klucz', 'wartosc', 'zaktualizowano']);
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
