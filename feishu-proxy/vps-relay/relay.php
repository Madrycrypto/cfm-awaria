<?php
/**
 * CFM Feishu Base Relay — PHP
 *
 * Prosty przekaznik CORS pomiedzy aplikacja CFM (przegladarka telefonu) a
 * automatyzacjami "Gdy odebrano webhook" w Feishu Base. Zero kluczy API
 * Feishu, zero App ID/Secret — tylko docelowe URL-e webhookow wygenerowane
 * w UI samej Bazy (Workflow -> nowa automatyzacja -> wyzwalacz webhook).
 *
 * Base automation przez webhook potrafi tylko DODAC rekord — nie ma
 * odpowiednika do odczytu danych z powrotem bez "custom app" (ktorego
 * unikamy, bo wymaga uprawnien admina). Dlatego endpointy odczytu ponizej
 * zwracaja status=error, a aplikacja CFM automatycznie przelacza sie wtedy
 * na dane zapisane lokalnie na telefonie (to juz wbudowane w apke).
 *
 * Wymagania: PHP z rozszerzeniem curl (standard na kazdym hostingu, w tym
 * Hostinger). Serwuj przez HTTPS — apka CFM dziala po HTTPS i przegladarka
 * zablokuje polaczenie do zwyklego http://.
 */

// ── KONFIGURACJA ─────────────────────────────────────────────────────
// Wklej tutaj 4 adresy webhookow automatyzacji z Feishu Base (patrz README).
$WEBHOOK_REPORT  = 'https://www.feishu.cn/base/automation/webhook/event/XXXXXXXX'; // RaportDzienny
$WEBHOOK_QUALITY = 'https://www.feishu.cn/base/automation/webhook/event/XXXXXXXX'; // PrzyczynyJakosc
$WEBHOOK_AWARIA  = 'https://www.feishu.cn/base/automation/webhook/event/XXXXXXXX'; // Awarie
$WEBHOOK_REWORK  = 'https://www.feishu.cn/base/automation/webhook/event/XXXXXXXX'; // ReworkProcessing
// ─────────────────────────────────────────────────────────────────────

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('Content-Type: application/json; charset=utf-8');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

function forward_to_feishu($url, $payload) {
    if (strpos($url, 'XXXXXXXX') !== false) return false; // nie skonfigurowano jeszcze tego webhooka
    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload));
    curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_TIMEOUT, 10);
    curl_exec($ch);
    $ok = curl_errno($ch) === 0;
    curl_close($ch);
    return $ok;
}

function read_json_body() {
    $raw = file_get_contents('php://input');
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$path = preg_replace('#^.*(/api/[a-z-]+)$#', '$1', $path);
$method = $_SERVER['REQUEST_METHOD'];

if ($path === '/api/report' && $method === 'POST') {
    $body = read_json_body();
    $d = isset($body['data']) ? $body['data'] : [];
    forward_to_feishu($WEBHOOK_REPORT, $d);

    foreach ((isset($body['scrap_entries']) ? $body['scrap_entries'] : []) as $e) {
        forward_to_feishu($WEBHOOK_QUALITY, [
            'timestamp' => isset($d['timestamp']) ? $d['timestamp'] : '',
            'date' => isset($d['date']) ? $d['date'] : '',
            'shift' => isset($d['shift']) ? $d['shift'] : '',
            'station' => isset($d['station']) ? $d['station'] : '',
            'operator' => isset($d['operator']) ? $d['operator'] : '',
            'category' => 'scrap',
            'reason' => isset($e['reason']) ? $e['reason'] : '',
            'qty' => isset($e['qty']) ? $e['qty'] : 0,
        ]);
    }
    foreach ((isset($body['rework_entries']) ? $body['rework_entries'] : []) as $e) {
        forward_to_feishu($WEBHOOK_QUALITY, [
            'timestamp' => isset($d['timestamp']) ? $d['timestamp'] : '',
            'date' => isset($d['date']) ? $d['date'] : '',
            'shift' => isset($d['shift']) ? $d['shift'] : '',
            'station' => isset($d['station']) ? $d['station'] : '',
            'operator' => isset($d['operator']) ? $d['operator'] : '',
            'category' => 'rework',
            'reason' => isset($e['reason']) ? $e['reason'] : '',
            'qty' => isset($e['qty']) ? $e['qty'] : 0,
        ]);
    }
    echo json_encode(['status' => 'ok']);
    exit;
}

if ($path === '/api/awaria' && $method === 'POST') {
    $body = read_json_body();
    forward_to_feishu($WEBHOOK_AWARIA, [
        'event' => isset($body['event']) ? $body['event'] : '',
        'station' => isset($body['station']) ? $body['station'] : '',
        'type' => isset($body['type']) ? $body['type'] : '',
        'timestamp' => isset($body['timestamp']) ? $body['timestamp'] : '',
        'start_timestamp' => isset($body['start_timestamp']) ? $body['start_timestamp'] : '',
        'koniec_timestamp' => isset($body['koniec_timestamp']) ? $body['koniec_timestamp'] : '',
        'czas_min' => isset($body['czas_min']) ? $body['czas_min'] : '',
    ]);
    echo json_encode(['status' => 'ok']);
    exit;
}

if ($path === '/api/rework-processing' && $method === 'POST') {
    $body = read_json_body();
    $d = isset($body['data']) ? $body['data'] : [];
    forward_to_feishu($WEBHOOK_REWORK, $d);

    foreach ((isset($body['final_scrap_entries']) ? $body['final_scrap_entries'] : []) as $e) {
        forward_to_feishu($WEBHOOK_QUALITY, [
            'timestamp' => isset($d['timestamp']) ? $d['timestamp'] : '',
            'date' => isset($d['date']) ? $d['date'] : '',
            'shift' => '',
            'station' => isset($d['zone']) ? $d['zone'] : '',
            'operator' => '',
            'category' => 'rework_final_scrap',
            'reason' => isset($e['reason']) ? $e['reason'] : '',
            'qty' => isset($e['qty']) ? $e['qty'] : 0,
        ]);
    }
    echo json_encode(['status' => 'ok']);
    exit;
}

// Odczyt niedostepny w trybie Base-webhook — apka CFM automatycznie
// przelacza sie na dane lokalne z telefonu, gdy dostanie status=error.
$readOnlyPaths = ['/api/history', '/api/last-entry', '/api/rework-buffer', '/api/rework-history', '/api/awaria-check'];
if (in_array($path, $readOnlyPaths)) {
    echo json_encode(['status' => 'error', 'msg' => 'odczyt niedostepny w trybie Feishu Base webhook']);
    exit;
}

http_response_code(404);
echo json_encode(['status' => 'error', 'msg' => 'unknown endpoint']);
