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
 * Rola tego arkusza: dziala jako pomocniczy licznik stanu dla dwoch
 * funkcji, ktore faktycznie musza dzialac w obie strony:
 *   - Awaria: sprawdzenie czy na stanowisku jest juz otwarta awaria
 *     przed dodaniem nowej (SPRAWDZ / START / KONIEC)
 *   - Rework: bufor zaleglosci per strefa (REWORK_BUFFER / REWORK_HISTORY),
 *     zeby aplikacja mogla zwalidowac "odzyskane + zlom" przeciwko temu,
 *     co faktycznie jest w kolejce
 * Trwaly zapis danych produkcyjnych i tak idzie rownolegle do Feishu Base
 * (aplikacja wysyla do obu na raz, gdy oba sa skonfigurowane) — ten
 * arkusz nie jest zamiennikiem Feishu, tylko dodatkowa pamiecia
 * operacyjna dla dwoch funkcji ktorych Feishu nie potrafi obsluzyc.
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

function doGet(e) {
  var p = (e && e.parameter) || {};
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  try {
    switch (p.event_type) {
      case 'RAPORT_DZIENNY': return handleReport(ss, p);
      case 'START': return handleAwariaStart(ss, p);
      case 'KONIEC': return handleAwariaEnd(ss, p);
      case 'SPRAWDZ': return handleAwariaCheck(ss, p);
      case 'HISTORIA_DZIENNA': return handleHistoriaDzienna(ss, p);
      case 'REWORK_PROCESSING': return handleReworkProcessing(ss, p);
      case 'REWORK_BUFFER': return handleReworkBuffer(ss, p);
      case 'REWORK_HISTORY': return handleReworkHistory(ss, p);
      case 'TEST': return jsonResponse({ status: 'ok', msg: 'polaczenie dziala' });
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

// ── RAPORT ZMIANY ────────────────────────────────────────────────────
// timestamp | date | shift | station | operator | qty | scrap | rework | recovered | ok_count | pass_rate | notes | reasons_json
function handleReport(ss, p) {
  var sheet = getOrCreateSheet(ss, 'RaportDzienny', ['timestamp', 'date', 'shift', 'station', 'operator', 'qty', 'scrap', 'rework', 'recovered', 'ok_count', 'pass_rate', 'notes', 'reasons_json']);
  sheet.appendRow([
    p.timestamp || '', p.date || '', p.shift || '', p.station || '', p.operator || '',
    Number(p.qty) || 0, Number(p.scrap) || 0, Number(p.rework) || 0, Number(p.recovered) || 0,
    Number(p.ok_count) || 0, p.pass_rate || '', p.notes || '', p.reasons_json || '',
  ]);
  return jsonResponse({ status: 'ok' });
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
    var entry = { timestamp: r[0], date: r[1], shift: r[2], station: r[3], operator: r[4], qty: Number(r[5]) || 0, scrap: Number(r[6]) || 0, rework: Number(r[7]) || 0, recovered: Number(r[8]) || 0, ok_count: Number(r[9]) || 0, pass_rate: r[10], notes: r[11] };
    historia.push(entry);
    suma += entry.qty; scrap += entry.scrap; rework += entry.rework; recovered += entry.recovered;
  }
  return jsonResponse({ status: 'ok', historia: historia, suma: suma, scrap: scrap, rework: rework, recovered: recovered });
}

// ── AWARIE ──────────────────────────────────────────────────────────
// start_timestamp | station | type | koniec_timestamp | czas_min | status
function handleAwariaStart(ss, p) {
  var sheet = getOrCreateSheet(ss, 'Awarie', ['start_timestamp', 'station', 'type', 'koniec_timestamp', 'czas_min', 'status']);
  sheet.appendRow([p.timestamp || '', p.stanowisko || '', p.typ || '', '', '', 'OTWARTA']);
  return jsonResponse({ status: 'ok' });
}

function handleAwariaEnd(ss, p) {
  var sheet = getOrCreateSheet(ss, 'Awarie', ['start_timestamp', 'station', 'type', 'koniec_timestamp', 'czas_min', 'status']);
  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    var row = data[i];
    if (row[0] === p.start_timestamp && row[1] === p.stanowisko && row[5] === 'OTWARTA') {
      sheet.getRange(i + 1, 4, 1, 3).setValues([[p.koniec_timestamp || '', Number(p.czas_min) || 0, 'ZAMKNIETA']]);
      return jsonResponse({ status: 'ok' });
    }
  }
  // Nie znaleziono otwartego wiersza (np. reset stanu w aplikacji) — dopisz kompletny wiersz.
  sheet.appendRow([p.start_timestamp || '', p.stanowisko || '', p.typ || '', p.koniec_timestamp || '', Number(p.czas_min) || 0, 'ZAMKNIETA']);
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
      return jsonResponse({ open: true, awaria: { typ: row[2], start: startIso, startIso: startIso, diffMin: diffMin } });
    }
  }
  return jsonResponse({ open: false });
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

function handleReworkBuffer(ss, p) {
  var zone = p.zone;
  var stations = REWORK_ZONES[zone] || [];

  var reworkTotal = 0;
  var reportSheet = ss.getSheetByName('RaportDzienny');
  if (reportSheet) {
    var data = reportSheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (stations.indexOf(data[i][3]) >= 0) reworkTotal += Number(data[i][7]) || 0;
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
      }
    }
  }

  var buffer = Math.max(0, reworkTotal - recoveredTotal - finalScrapTotal);
  return jsonResponse({ status: 'ok', rework_total: reworkTotal, recovered_total: recoveredTotal, final_scrap_total: finalScrapTotal, buffer: buffer });
}

function handleReworkHistory(ss, p) {
  var sheet = ss.getSheetByName('ReworkProcessing');
  var historia = [];
  if (sheet) {
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      if (p.zone && row[2] !== p.zone) continue;
      historia.push({ timestamp: row[0], date: row[1], zone: row[2], processed: Number(row[3]) || 0, recovered: Number(row[4]) || 0, final_scrap: Number(row[5]) || 0, note: row[6], notes: row[7] });
    }
  }
  historia.sort(function (a, b) { return new Date(b.timestamp) - new Date(a.timestamp); });
  return jsonResponse({ status: 'ok', historia: historia.slice(0, 20) });
}
