// CFM Feishu Base Relay — Node.js (bez zaleznosci, tylko wbudowane moduly)
//
// Prosty przekaznik CORS pomiedzy aplikacja CFM (przegladarka telefonu) a
// automatyzacjami "Gdy odebrano webhook" w Feishu Base. Zero kluczy API
// Feishu, zero App ID/Secret — tylko docelowe URL-e webhookow wygenerowane
// w UI samej Bazy (Workflow -> nowa automatyzacja -> wyzwalacz webhook).
//
// Base automation przez webhook potrafi tylko DODAC rekord — nie ma
// odpowiednika do odczytu danych z powrotem bez "custom app" (ktorego
// unikamy, bo wymaga uprawnien admina). Dlatego endpointy odczytu ponizej
// zwracaja status=error, a aplikacja CFM automatycznie przelacza sie wtedy
// na dane zapisane lokalnie na telefonie (to juz wbudowane w apke).
//
// Uruchomienie:  node relay.js        (port 3000, zmien PORT ponizej)
// Produkcyjnie:  uruchom pod PM2/systemd i za reverse proxy Nginx z HTTPS —
// apka CFM dziala po HTTPS, przegladarka zablokuje polaczenie do zwyklego http://.

const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;

// ── KONFIGURACJA ─────────────────────────────────────────────────────
// Wklej tutaj 4 adresy webhookow automatyzacji z Feishu Base (patrz README).
const WEBHOOK_REPORT = 'https://www.feishu.cn/base/automation/webhook/event/XXXXXXXX'; // RaportDzienny
const WEBHOOK_QUALITY = 'https://www.feishu.cn/base/automation/webhook/event/XXXXXXXX'; // PrzyczynyJakosc
const WEBHOOK_AWARIA = 'https://www.feishu.cn/base/automation/webhook/event/XXXXXXXX'; // Awarie
const WEBHOOK_REWORK = 'https://www.feishu.cn/base/automation/webhook/event/XXXXXXXX'; // ReworkProcessing
// ─────────────────────────────────────────────────────────────────────

function forwardToFeishu(targetUrl, payload) {
  return new Promise((resolve) => {
    if (targetUrl.indexOf('XXXXXXXX') >= 0) { resolve(false); return; } // nie skonfigurowano jeszcze
    const u = new URL(targetUrl);
    const body = JSON.stringify(payload);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 10000,
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve(true));
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(raw)); } catch (e) { resolve({}); }
    });
  });
}

const READ_ONLY_PATHS = ['/api/history', '/api/last-entry', '/api/rework-buffer', '/api/rework-history', '/api/awaria-check'];

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const path = req.url.split('?')[0];

  try {
    if (path === '/api/report' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const d = body.data || {};
      await forwardToFeishu(WEBHOOK_REPORT, d);

      for (const e of body.scrap_entries || []) {
        await forwardToFeishu(WEBHOOK_QUALITY, {
          timestamp: d.timestamp || '', date: d.date || '', shift: d.shift || '',
          station: d.station || '', operator: d.operator || '',
          category: 'scrap', reason: e.reason || '', qty: e.qty || 0,
        });
      }
      for (const e of body.rework_entries || []) {
        await forwardToFeishu(WEBHOOK_QUALITY, {
          timestamp: d.timestamp || '', date: d.date || '', shift: d.shift || '',
          station: d.station || '', operator: d.operator || '',
          category: 'rework', reason: e.reason || '', qty: e.qty || 0,
        });
      }
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (path === '/api/awaria' && req.method === 'POST') {
      const body = await readJsonBody(req);
      await forwardToFeishu(WEBHOOK_AWARIA, {
        event: body.event || '', station: body.station || '', type: body.type || '',
        timestamp: body.timestamp || '', start_timestamp: body.start_timestamp || '',
        koniec_timestamp: body.koniec_timestamp || '', czas_min: body.czas_min || '',
      });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (path === '/api/rework-processing' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const d = body.data || {};
      await forwardToFeishu(WEBHOOK_REWORK, d);

      for (const e of body.final_scrap_entries || []) {
        await forwardToFeishu(WEBHOOK_QUALITY, {
          timestamp: d.timestamp || '', date: d.date || '', shift: '',
          station: d.zone || '', operator: '',
          category: 'rework_final_scrap', reason: e.reason || '', qty: e.qty || 0,
        });
      }
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (READ_ONLY_PATHS.indexOf(path) >= 0) {
      res.end(JSON.stringify({ status: 'error', msg: 'odczyt niedostepny w trybie Feishu Base webhook' }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ status: 'error', msg: 'unknown endpoint' }));
  } catch (e) {
    res.writeHead(500);
    res.end(JSON.stringify({ status: 'error', msg: String((e && e.message) || e) }));
  }
});

server.listen(PORT, () => console.log('CFM relay listening on port ' + PORT));
