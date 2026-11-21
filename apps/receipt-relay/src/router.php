<?php

declare(strict_types=1);

require_once __DIR__ . '/reference.php';
require_once __DIR__ . '/fetch.php';
require_once __DIR__ . '/throttle.php';
require_once __DIR__ . '/html_text.php';
require_once __DIR__ . '/pdf_text.php';
require_once __DIR__ . '/database.php';
require_once __DIR__ . '/admin.php';

function relay_config(): array
{
    static $config = null;
    if ($config === null) {
        $config = require __DIR__ . '/config.php';
    }
    return $config;
}

function json_response(int $status, array $body): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Accept, Content-Type, X-API-Key, X-API-Secret');
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
}

function error_response(int $status, string $code, string $message): void
{
    json_response($status, ['ok' => false, 'code' => $code, 'message' => $message]);
}

/** The request path with the app's own base directory removed. */
function request_path(): string
{
    $path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
    if (!is_string($path)) {
        return '/';
    }
    $script = str_replace('\\', '/', $_SERVER['SCRIPT_NAME'] ?? '/index.php');
    $base = rtrim(dirname($script), '/');
    if ($base !== '' && $base !== '/' && str_starts_with($path, $base)) {
        $path = substr($path, strlen($base));
    }
    $path = '/' . ltrim($path, '/');
    return rtrim($path, '/') ?: '/';
}

/** REMOTE_ADDR only: a forwarded header is caller-controlled and would bypass the limit. */
function client_ip(): string
{
    $ip = $_SERVER['REMOTE_ADDR'] ?? '';
    return $ip !== '' ? $ip : '0.0.0.0';
}

function request_is_https(): bool
{
    $https = strtolower((string)($_SERVER['HTTPS'] ?? ''));
    return in_array($https, ['on', '1'], true)
        || ($_SERVER['REQUEST_SCHEME'] ?? '') === 'https';
}

/**
 * The receipt as text lines, so the API receives kilobytes instead of the
 * bank's whole body. The API still parses the labels and runs the gate; this
 * only turns the document into lines.
 *
 * @return array{ok:true, lines:list<string>}|array{ok:true, notFound:true, message:string}|array{ok:false, message:string}
 */
function extract_text_body(string $providerCode, string $body): array
{
    if ($providerCode === 'telebirr') {
        $lines = html_to_lines($body);
        if (!$lines) {
            return ['ok' => false, 'message' => 'The Telebirr page had no readable text.'];
        }
        return ['ok' => true, 'lines' => $lines];
    }

    $envelope = mpesa_envelope_pdf($body);
    if (!$envelope['ok']) {
        return ['ok' => true, 'notFound' => true, 'message' => $envelope['message']];
    }
    $pdf = pdf_text_lines($envelope['pdf']);
    if (!$pdf['ok']) {
        return ['ok' => false, 'message' => $pdf['message']];
    }
    return ['ok' => true, 'lines' => $pdf['lines']];
}

function handle_request(): void
{
    try {
        handle_request_inner();
    } catch (Throwable $error) {
        error_log('Receipt relay request failed: ' . $error->getMessage());
        if (!headers_sent()) {
            error_response(503, 'SERVICE_UNAVAILABLE', 'The relay storage service is unavailable.');
        }
    }
}

function handle_request_inner(): void
{
    $method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
    $path = request_path();

    if ($method === 'OPTIONS') {
        http_response_code(204);
        header('Access-Control-Allow-Origin: *');
        header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
        header('Access-Control-Allow-Headers: Accept, Content-Type, X-API-Key, X-API-Secret');
        return;
    }

    if ($path === '/openapi.json' || $path === '/docs') {
        if ($method !== 'GET' && $method !== 'HEAD') {
            header('Allow: GET, HEAD, OPTIONS');
            error_response(405, 'METHOD_NOT_ALLOWED', 'Only GET and the verification-event POST are supported.');
            return;
        }
        serve_api_docs($path);
        return;
    }

    if ($path === '/admin' || str_starts_with($path, '/admin/')) {
        if (!request_is_https()) {
            error_response(400, 'HTTPS_REQUIRED', 'Use HTTPS for the admin dashboard.');
            return;
        }
        handle_admin_request($path, $method);
        return;
    }

    if ($method !== 'GET' && $method !== 'HEAD' && !($method === 'POST' && $path === '/events/verification')) {
        header('Allow: GET, HEAD, POST, OPTIONS');
        error_response(405, 'METHOD_NOT_ALLOWED', 'Unsupported request method.');
        return;
    }

    $config = relay_config();

    if ($path === '/' || $path === '/health') {
        json_response(200, [
            'ok' => true,
            'app' => $config['app'],
            'version' => $config['version'],
            'providers' => array_keys($config['providers']),
            'time' => gmdate('c'),
        ]);
        return;
    }

    if ($path === '/events/verification') {
        if (!request_is_https()) {
            error_response(400, 'HTTPS_REQUIRED', 'Use HTTPS for authenticated API requests.');
            return;
        }
        handle_verification_event();
        return;
    }

    if (!preg_match('#^/receipts/([A-Za-z0-9_-]+)(?:/(.*))?$#', $path, $match)) {
        error_response(404, 'NOT_FOUND', 'Use GET /receipts/{provider}/{reference} or ?reference={reference}.');
        return;
    }

    if (!request_is_https()) {
        error_response(400, 'HTTPS_REQUIRED', 'Use HTTPS for authenticated API requests.');
        return;
    }

    $apiKey = authenticated_api_key();
    if ($apiKey === null) {
        error_response(401, 'UNAUTHORIZED', 'A valid X-API-Key and X-API-Secret are required.');
        return;
    }
    $requestedProvider = strtolower($match[1]);
    $knownProvider = isset($config['providers'][$requestedProvider]) ? $requestedProvider : null;
    record_relay_event('request', $knownProvider, null, (int)$apiKey['id']);

    $format = isset($_GET['format']) && is_string($_GET['format'])
        ? strtolower(trim($_GET['format']))
        : 'raw';
    if ($format !== 'raw' && $format !== 'text') {
        error_response(400, 'INVALID_FORMAT', 'Use format=text, or leave it out for the raw body.');
        return;
    }

    $providerCode = strtolower($match[1]);
    $provider = $config['providers'][$providerCode] ?? null;
    if ($provider === null) {
        error_response(
            404,
            'UNKNOWN_PROVIDER',
            'This relay verifies: ' . implode(', ', array_keys($config['providers'])) . '.',
        );
        return;
    }

    // The path form suits a bare reference. A pasted receipt link goes in
    // ?reference=, because web servers reject its encoded slashes in the path.
    $rawReference = isset($_GET['reference']) && is_string($_GET['reference'])
        ? $_GET['reference']
        : rawurldecode($match[2] ?? '');
    $reference = extract_reference($provider, $rawReference);
    if ($reference === null) {
        error_response(400, 'INVALID_REFERENCE', 'That does not look like a ' . $provider['name'] . ' receipt reference.');
        return;
    }

    $throttle = $config['throttle'] ?? [];
    if (!empty($throttle['enabled'])) {
        $limit = max(1, (int)($throttle['per_ip_per_minute'] ?? 30));
        if (!throttle_allow(client_ip(), $limit)) {
            error_response(429, 'RATE_LIMITED', 'Too many requests. Wait a minute and try again.');
            return;
        }
    }

    $url = sprintf($provider['url'], rawurlencode($reference));
    $result = fetch_receipt($url, $provider, $config['user_agent']);

    if (!$result['ok']) {
        record_relay_event('lookup', $providerCode, $result['code'], (int)$apiKey['id']);
        error_response($result['status'], $result['code'], $result['message']);
        return;
    }

    if ($format === 'text') {
        $extracted = extract_text_body($providerCode, $result['body']);
        if (!empty($extracted['notFound'])) {
            record_relay_event('lookup', $providerCode, 'NOT_FOUND', (int)$apiKey['id']);
            json_response(200, [
                'ok' => true,
                'provider' => $providerCode,
                'reference' => $reference,
                'status' => $result['status'],
                'format' => 'text',
                'notFound' => true,
                'message' => $extracted['message'],
                'sourceUrl' => $url,
                'fetchedAt' => gmdate('c'),
            ]);
            return;
        }
        if (!$extracted['ok']) {
            record_relay_event('lookup', $providerCode, 'EXTRACTION_FAILED', (int)$apiKey['id']);
            error_response(422, 'EXTRACTION_FAILED', $extracted['message']);
            return;
        }
        record_relay_event('lookup', $providerCode, 'FETCHED', (int)$apiKey['id']);
        json_response(200, [
            'ok' => true,
            'provider' => $providerCode,
            'reference' => $reference,
            'status' => $result['status'],
            'format' => 'text',
            'text' => implode("\n", $extracted['lines']),
            'sourceUrl' => $url,
            'fetchedAt' => gmdate('c'),
        ]);
        return;
    }

    record_relay_event('lookup', $providerCode, 'FETCHED', (int)$apiKey['id']);
    json_response(200, [
        'ok' => true,
        'provider' => $providerCode,
        'reference' => $reference,
        'status' => $result['status'],
        'contentType' => $result['contentType'],
        'bodyBase64' => base64_encode($result['body']),
        'sourceUrl' => $url,
        'fetchedAt' => gmdate('c'),
    ]);
}

function serve_api_docs(string $path): void
{
    $specPath = dirname(__DIR__) . '/docs/openapi.json';
    if ($path === '/openapi.json') {
        if (!is_file($specPath)) {
            error_response(503, 'DOCS_UNAVAILABLE', 'The OpenAPI document is missing.');
            return;
        }
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-cache');
        readfile($specPath);
        return;
    }

    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-cache');
    echo '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        . '<meta name="viewport" content="width=device-width, initial-scale=1">'
        . '<title>Receipt Relay API</title>'
        . '<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui.css">'
        . '</head><body><div id="swagger-ui"></div>'
        . '<script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script>'
        . '<script>SwaggerUIBundle({url:"openapi.json",dom_id:"#swagger-ui"});</script>'
        . '</body></html>';
}

function handle_verification_event(): void
{
    $apiKey = authenticated_api_key();
    if ($apiKey === null) {
        error_response(401, 'UNAUTHORIZED', 'A valid X-API-Key and X-API-Secret are required.');
        return;
    }

    $contentType = strtolower(trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0]));
    if ($contentType !== 'application/json') {
        error_response(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
        return;
    }

    $stream = fopen('php://input', 'rb');
    $body = $stream === false ? false : fread($stream, 4097);
    if (is_resource($stream)) {
        fclose($stream);
    }
    if (!is_string($body) || strlen($body) > 4096) {
        error_response(413, 'REQUEST_TOO_LARGE', 'The event body is too large.');
        return;
    }
    $event = json_decode($body, true);
    $providers = ['telebirr', 'mpesa'];
    $statuses = [
        'VERIFIED', 'FAILED', 'NOT_FOUND', 'NOT_MATCHED', 'NOT_VERIFIED',
        'UNREACHABLE', 'UNSUPPORTED', 'INVALID_REFERENCE',
    ];
    if (!is_array($event)
        || !in_array($event['provider'] ?? null, $providers, true)
        || !in_array($event['status'] ?? null, $statuses, true)
        || array_diff(array_keys($event), ['provider', 'status']) !== []
    ) {
        error_response(400, 'INVALID_EVENT', 'Provide a supported provider and verification status.');
        return;
    }

    record_relay_event('verification', $event['provider'], $event['status'], (int)$apiKey['id']);
    json_response(202, ['ok' => true]);
}
