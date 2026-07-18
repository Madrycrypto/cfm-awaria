// CFM Feishu Proxy — Cloudflare Worker
//
// Przegladarka nie moze wywolywac open.feishu.cn bezposrednio (brak CORS,
// a app_secret nigdy nie moze trafic do kodu klienckiego). Ten worker stoi
// pomiedzy aplikacja CFM a Feishu Sheets API: trzyma app_secret jako sekret
// serwerowy, zarzadza tenant_access_token i udostepnia endpointy ktore
// wola CFM_raport_dzienny.html (raport zmiany + przyczyny jakosci + awarie).
//
// Wymagane sekrety (wrangler secret put ...):
//   FEISHU_APP_ID
//   FEISHU_APP_SECRET
//
// Deploy:
//   npm install -g wrangler
//   wrangler login
//   wrangler secret put FEISHU_APP_ID
//   wrangler secret put FEISHU_APP_SECRET
//   wrangler deploy
//
// Endpointy:
//   POST /api/report         -> dopisuje wiersz raportu zmiany + wiersze przyczyn scrap/rework
//   GET  /api/history        -> raporty z danego dnia dla stanowiska/operatora
//   POST /api/awaria         -> START / KONIEC awarii
//   GET  /api/awaria-check   -> czy dla stanowiska jest otwarta (niezamknieta) awaria
//
// Wymagane zakladki w arkuszu Feishu (utworz recznie, z naglowkiem w wierszu 1):
//   RaportDzienny   : timestamp | date | shift | station | operator | qty | scrap | rework | recovered | ok_count | pass_rate | notes
//   PrzyczynyJakosc : timestamp | date | shift | station | operator | category | reason | qty
//   Awarie          : start_timestamp | station | type | koniec_timestamp | czas_min | status

const FEISHU_BASE = 'https://open.feishu.cn';
const REPORT_SHEET_NAME = 'RaportDzienny';
const QUALITY_SHEET_NAME = 'PrzyczynyJakosc';
const AWARIA_SHEET_NAME = 'Awarie';
const REWORK_SHEET_NAME = 'ReworkProcessing';

// Musi byc zgodne z REWORK_ZONES w CFM_raport_dzienny.html
const REWORK_ZONES = {
  'OP33A_B': ['OP33A', 'OP33B'],
  'OP60_61': ['OP60/61'],
  'GP12': ['GP12'],
  'OP40': ['OP40 IN', 'OP40 OUT'],
  'OP51_52': ['OP51/52'],
};

let cachedToken = null;
let cachedTokenExpiresAt = 0;
const sheetIdCache = {};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() },
  });
}

async function getTenantAccessToken(env) {
  const now = Date.now();
  if (cachedToken && cachedTokenExpiresAt - now > 5 * 60 * 1000) {
    return cachedToken;
  }
  const res = await fetch(FEISHU_BASE + '/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
  });
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error('Feishu auth failed: ' + data.msg);
  }
  cachedToken = data.tenant_access_token;
  cachedTokenExpiresAt = now + data.expire * 1000;
  return cachedToken;
}

async function feishuFetch(env, path, options) {
  const token = await getTenantAccessToken(env);
  const res = await fetch(FEISHU_BASE + path, {
    ...options,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json; charset=utf-8',
      ...(options && options.headers),
    },
  });
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error('Feishu API error [' + path + ']: ' + data.msg);
  }
  return data;
}

// Znajduje sheetId (wewnetrzny identyfikator zakladki) po nazwie zakladki. Cache w pamieci workera.
async function resolveSheetId(env, spreadsheetToken, sheetName) {
  const cacheKey = spreadsheetToken + '::' + sheetName;
  if (sheetIdCache[cacheKey]) return sheetIdCache[cacheKey];
  const data = await feishuFetch(env, '/open-apis/sheets/v3/spreadsheets/' + spreadsheetToken + '/sheets/query', { method: 'GET' });
  const sheet = (data.data.sheets || []).find(function (s) { return s.title === sheetName; });
  if (!sheet) {
    throw new Error('Nie znaleziono zakladki "' + sheetName + '" w arkuszu. Utworz ja recznie w Feishu.');
  }
  sheetIdCache[cacheKey] = sheet.sheet_id;
  return sheet.sheet_id;
}

async function appendRows(env, spreadsheetToken, sheetId, colRange, rows) {
  return feishuFetch(env, '/open-apis/sheets/v2/spreadsheets/' + spreadsheetToken + '/values_append?insertDataOption=INSERT_ROWS', {
    method: 'POST',
    body: JSON.stringify({ valueRange: { range: sheetId + '!' + colRange, values: rows } }),
  });
}

// ── RAPORT ZMIANY + PRZYCZYNY JAKOSCI ──────────────────────────────
async function handleReport(request, env) {
  const body = await request.json();
  const spreadsheetToken = body.sheet_token;
  const sheetName = body.sheet_id || REPORT_SHEET_NAME;
  const d = body.data || {};
  if (!spreadsheetToken) return json({ status: 'error', msg: 'brak sheet_token' }, 400);

  const sheetId = await resolveSheetId(env, spreadsheetToken, sheetName);
  const row = [
    d.timestamp || '', d.date || '', d.shift || '', d.station || '', d.operator || '',
    Number(d.qty) || 0, Number(d.scrap) || 0, Number(d.rework) || 0, Number(d.recovered) || 0,
    Number(d.ok_count) || 0, d.pass_rate || '', d.notes || '',
  ];
  await appendRows(env, spreadsheetToken, sheetId, 'A1:L1', [row]);

  // Przyczyny scrap/rework -> osobna zakladka dla dzialu jakosci. Nie blokuje
  // zapisu glownego raportu, jesli zakladka jeszcze nie istnieje.
  const scrapEntries = body.scrap_entries || [];
  const reworkEntries = body.rework_entries || [];
  const reasonRows = [];
  scrapEntries.forEach(function (e) {
    reasonRows.push([d.timestamp || '', d.date || '', d.shift || '', d.station || '', d.operator || '', 'scrap', e.reason || '', Number(e.qty) || 0]);
  });
  reworkEntries.forEach(function (e) {
    reasonRows.push([d.timestamp || '', d.date || '', d.shift || '', d.station || '', d.operator || '', 'rework', e.reason || '', Number(e.qty) || 0]);
  });

  let qualityWarning = null;
  if (reasonRows.length) {
    try {
      const qualitySheetId = await resolveSheetId(env, spreadsheetToken, QUALITY_SHEET_NAME);
      await appendRows(env, spreadsheetToken, qualitySheetId, 'A1:H1', reasonRows);
    } catch (e) {
      qualityWarning = String((e && e.message) || e);
    }
  }

  return json({ status: 'ok', quality_warning: qualityWarning });
}

async function handleHistory(request, env) {
  const url = new URL(request.url);
  const spreadsheetToken = url.searchParams.get('sheet_token');
  const sheetName = url.searchParams.get('sheet_id') || REPORT_SHEET_NAME;
  const date = url.searchParams.get('date');
  const station = url.searchParams.get('station');
  const operator = url.searchParams.get('operator');
  if (!spreadsheetToken) return json({ status: 'error', msg: 'brak sheet_token' }, 400);

  const sheetId = await resolveSheetId(env, spreadsheetToken, sheetName);
  const data = await feishuFetch(env, '/open-apis/sheets/v2/spreadsheets/' + spreadsheetToken + '/values/' + sheetId + '!A2:L5000', { method: 'GET' });
  const rows = (data.data.valueRange && data.data.valueRange.values) || [];

  var historia = [];
  var suma = 0, scrap = 0, rework = 0, recovered = 0;
  rows.forEach(function (r) {
    if (!r || !r[1]) return;
    var rowDate = String(r[1]), rowStation = String(r[3] || ''), rowOperator = String(r[4] || '');
    if (date && rowDate !== date) return;
    if (station && rowStation !== station) return;
    if (operator && rowOperator !== operator) return;
    var entry = {
      timestamp: r[0], date: r[1], shift: r[2], station: r[3], operator: r[4],
      qty: Number(r[5]) || 0, scrap: Number(r[6]) || 0, rework: Number(r[7]) || 0,
      recovered: Number(r[8]) || 0, ok_count: Number(r[9]) || 0, pass_rate: r[10], notes: r[11],
    };
    historia.push(entry);
    suma += entry.qty; scrap += entry.scrap; rework += entry.rework; recovered += entry.recovered;
  });

  return json({ status: 'ok', historia: historia, suma: suma, scrap: scrap, rework: rework, recovered: recovered });
}

// Ostatni pojedynczy wpis dla stanowiska, niezaleznie z ktorego dnia (nie tylko dzis).
async function handleLastEntry(request, env) {
  const url = new URL(request.url);
  const spreadsheetToken = url.searchParams.get('sheet_token');
  const sheetName = url.searchParams.get('sheet_id') || REPORT_SHEET_NAME;
  const station = url.searchParams.get('station');
  if (!spreadsheetToken) return json({ status: 'error', msg: 'brak sheet_token' }, 400);

  const sheetId = await resolveSheetId(env, spreadsheetToken, sheetName);
  const data = await feishuFetch(env, '/open-apis/sheets/v2/spreadsheets/' + spreadsheetToken + '/values/' + sheetId + '!A2:L20000', { method: 'GET' });
  const rows = (data.data.valueRange && data.data.valueRange.values) || [];

  var latest = null;
  rows.forEach(function (r) {
    if (!r || !r[0]) return;
    if (station && r[3] !== station) return;
    if (!latest || new Date(r[0]) > new Date(latest[0])) latest = r;
  });
  if (!latest) return json({ status: 'ok', entry: null });

  return json({
    status: 'ok',
    entry: {
      timestamp: latest[0], date: latest[1], shift: latest[2], station: latest[3], operator: latest[4],
      qty: Number(latest[5]) || 0, scrap: Number(latest[6]) || 0, rework: Number(latest[7]) || 0,
      recovered: Number(latest[8]) || 0, ok_count: Number(latest[9]) || 0, pass_rate: latest[10],
    },
  });
}

// ── REWORK PROCESSING (bufor per strefa) ────────────────────────────
// Rework moze byc przetworzony kilka dni po powstaniu, zbiorczo z kilku
// stanowisk. Bufor = SUMA(rework z RaportDzienny dla stacji w strefie)
// - SUMA(recovered z ReworkProcessing dla strefy) - SUMA(final_scrap dla strefy).
// Kolumny zakladki ReworkProcessing: timestamp | date | zone | processed | recovered | final_scrap | note | notes
async function handleReworkBuffer(request, env) {
  const url = new URL(request.url);
  const spreadsheetToken = url.searchParams.get('sheet_token');
  const zone = url.searchParams.get('zone');
  if (!spreadsheetToken) return json({ status: 'error', msg: 'brak sheet_token' }, 400);
  if (!zone || !REWORK_ZONES[zone]) return json({ status: 'error', msg: 'nieznana strefa' }, 400);
  const stations = REWORK_ZONES[zone];

  const reportSheetId = await resolveSheetId(env, spreadsheetToken, REPORT_SHEET_NAME);
  const reportData = await feishuFetch(env, '/open-apis/sheets/v2/spreadsheets/' + spreadsheetToken + '/values/' + reportSheetId + '!A2:L20000', { method: 'GET' });
  const reportRows = (reportData.data.valueRange && reportData.data.valueRange.values) || [];
  let reworkTotal = 0;
  reportRows.forEach(function (r) {
    if (r && stations.indexOf(r[3]) >= 0) reworkTotal += Number(r[7]) || 0;
  });

  let recoveredTotal = 0, finalScrapTotal = 0;
  try {
    const reworkSheetId = await resolveSheetId(env, spreadsheetToken, REWORK_SHEET_NAME);
    const reworkData = await feishuFetch(env, '/open-apis/sheets/v2/spreadsheets/' + spreadsheetToken + '/values/' + reworkSheetId + '!A2:H20000', { method: 'GET' });
    const reworkRows = (reworkData.data.valueRange && reworkData.data.valueRange.values) || [];
    reworkRows.forEach(function (r) {
      if (r && r[2] === zone) { recoveredTotal += Number(r[4]) || 0; finalScrapTotal += Number(r[5]) || 0; }
    });
  } catch (e) { /* zakladka ReworkProcessing jeszcze nie istnieje - bufor liczony tylko z rework */ }

  const buffer = Math.max(0, reworkTotal - recoveredTotal - finalScrapTotal);
  return json({ status: 'ok', rework_total: reworkTotal, recovered_total: recoveredTotal, final_scrap_total: finalScrapTotal, buffer: buffer });
}

async function handleReworkHistory(request, env) {
  const url = new URL(request.url);
  const spreadsheetToken = url.searchParams.get('sheet_token');
  const zone = url.searchParams.get('zone');
  if (!spreadsheetToken) return json({ status: 'error', msg: 'brak sheet_token' }, 400);

  const sheetId = await resolveSheetId(env, spreadsheetToken, REWORK_SHEET_NAME);
  const data = await feishuFetch(env, '/open-apis/sheets/v2/spreadsheets/' + spreadsheetToken + '/values/' + sheetId + '!A2:H20000', { method: 'GET' });
  const rows = (data.data.valueRange && data.data.valueRange.values) || [];

  var historia = [];
  rows.forEach(function (r) {
    if (!r || (zone && r[2] !== zone)) return;
    historia.push({ timestamp: r[0], date: r[1], zone: r[2], processed: Number(r[3]) || 0, recovered: Number(r[4]) || 0, final_scrap: Number(r[5]) || 0, note: r[6], notes: r[7] });
  });
  historia.sort(function (a, b) { return new Date(b.timestamp) - new Date(a.timestamp); });

  return json({ status: 'ok', historia: historia.slice(0, 20) });
}

async function handleReworkProcessing(request, env) {
  const body = await request.json();
  const spreadsheetToken = body.sheet_token;
  const d = body.data || {};
  if (!spreadsheetToken) return json({ status: 'error', msg: 'brak sheet_token' }, 400);

  const sheetId = await resolveSheetId(env, spreadsheetToken, REWORK_SHEET_NAME);
  const row = [d.timestamp || '', d.date || '', d.zone || '', Number(d.processed) || 0, Number(d.recovered) || 0, Number(d.final_scrap) || 0, d.note || '', d.notes || ''];
  await appendRows(env, spreadsheetToken, sheetId, 'A1:H1', [row]);

  const finalScrapEntries = body.final_scrap_entries || [];
  let qualityWarning = null;
  if (finalScrapEntries.length) {
    try {
      const qualitySheetId = await resolveSheetId(env, spreadsheetToken, QUALITY_SHEET_NAME);
      const reasonRows = finalScrapEntries.map(function (e) {
        return [d.timestamp || '', d.date || '', '', d.zone || '', '', 'rework_final_scrap', e.reason || '', Number(e.qty) || 0];
      });
      await appendRows(env, spreadsheetToken, qualitySheetId, 'A1:H1', reasonRows);
    } catch (e) { qualityWarning = String((e && e.message) || e); }
  }

  return json({ status: 'ok', quality_warning: qualityWarning });
}

// ── AWARIE ──────────────────────────────────────────────────────────
// Kolumny zakladki Awarie: start_timestamp | station | type | koniec_timestamp | czas_min | status
async function handleAwaria(request, env) {
  const body = await request.json();
  const spreadsheetToken = body.sheet_token;
  if (!spreadsheetToken) return json({ status: 'error', msg: 'brak sheet_token' }, 400);
  const sheetId = await resolveSheetId(env, spreadsheetToken, AWARIA_SHEET_NAME);

  if (body.event === 'START') {
    const row = [body.timestamp || '', body.station || '', body.type || '', '', '', 'OTWARTA'];
    await appendRows(env, spreadsheetToken, sheetId, 'A1:F1', [row]);
    return json({ status: 'ok' });
  }

  if (body.event === 'KONIEC') {
    const data = await feishuFetch(env, '/open-apis/sheets/v2/spreadsheets/' + spreadsheetToken + '/values/' + sheetId + '!A2:F5000', { method: 'GET' });
    const rows = (data.data.valueRange && data.data.valueRange.values) || [];
    var matchRowIdx = -1;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r && r[0] === body.start_timestamp && r[1] === body.station && r[5] === 'OTWARTA') { matchRowIdx = i; break; }
    }
    if (matchRowIdx >= 0) {
      var sheetRow = matchRowIdx + 2; // dane od wiersza 2 (naglowek w 1)
      await feishuFetch(env, '/open-apis/sheets/v2/spreadsheets/' + spreadsheetToken + '/values', {
        method: 'PUT',
        body: JSON.stringify({ valueRange: { range: sheetId + '!D' + sheetRow + ':F' + sheetRow, values: [[body.koniec_timestamp || '', Number(body.czas_min) || 0, 'ZAMKNIETA']] } }),
      });
    } else {
      // Nie znaleziono otwartego wiersza (np. reset stanu w aplikacji) — dopisz kompletny wiersz, zeby nie stracic danych.
      const row = [body.start_timestamp || '', body.station || '', body.type || '', body.koniec_timestamp || '', Number(body.czas_min) || 0, 'ZAMKNIETA'];
      await appendRows(env, spreadsheetToken, sheetId, 'A1:F1', [row]);
    }
    return json({ status: 'ok' });
  }

  return json({ status: 'ok' });
}

async function handleAwariaCheck(request, env) {
  const url = new URL(request.url);
  const spreadsheetToken = url.searchParams.get('sheet_token');
  const station = url.searchParams.get('station');
  if (!spreadsheetToken) return json({ status: 'error', msg: 'brak sheet_token' }, 400);
  const sheetId = await resolveSheetId(env, spreadsheetToken, AWARIA_SHEET_NAME);
  const data = await feishuFetch(env, '/open-apis/sheets/v2/spreadsheets/' + spreadsheetToken + '/values/' + sheetId + '!A2:F5000', { method: 'GET' });
  const rows = (data.data.valueRange && data.data.valueRange.values) || [];

  var open = null;
  rows.forEach(function (r) {
    if (r && r[1] === station && r[5] === 'OTWARTA') open = r;
  });
  if (!open) return json({ open: false });
  var startIso = open[0];
  var diffMin = Math.round((Date.now() - new Date(startIso).getTime()) / 60000);
  return json({ open: true, awaria: { typ: open[2], start: startIso, startIso: startIso, diffMin: diffMin } });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    var url = new URL(request.url);
    try {
      if (url.pathname === '/api/report' && request.method === 'POST') return await handleReport(request, env);
      if (url.pathname === '/api/history' && request.method === 'GET') return await handleHistory(request, env);
      if (url.pathname === '/api/last-entry' && request.method === 'GET') return await handleLastEntry(request, env);
      if (url.pathname === '/api/awaria' && request.method === 'POST') return await handleAwaria(request, env);
      if (url.pathname === '/api/awaria-check' && request.method === 'GET') return await handleAwariaCheck(request, env);
      if (url.pathname === '/api/rework-buffer' && request.method === 'GET') return await handleReworkBuffer(request, env);
      if (url.pathname === '/api/rework-history' && request.method === 'GET') return await handleReworkHistory(request, env);
      if (url.pathname === '/api/rework-processing' && request.method === 'POST') return await handleReworkProcessing(request, env);
      return json({ status: 'error', msg: 'unknown endpoint' }, 404);
    } catch (e) {
      return json({ status: 'error', msg: String((e && e.message) || e) }, 500);
    }
  },
};
