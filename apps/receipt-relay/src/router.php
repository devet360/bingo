<?php

declare(strict_types=1);

require_once __DIR__ . '/reference.php';
require_once __DIR__ . '/fetch.php';
require_once __DIR__ . '/throttle.php';

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
    header('Access-Control-Allow-Methods: GET, OPTIONS');
    header('Access-Control-Allow-Headers: Accept, Content-Type');
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

function handle_request(): void
{
    $method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');

    if ($method === 'OPTIONS') {
        http_response_code(204);
        header('Access-Control-Allow-Origin: *');
        header('Access-Control-Allow-Methods: GET, OPTIONS');
        header('Access-Control-Allow-Headers: Accept, Content-Type');
        return;
    }

    if ($method !== 'GET' && $method !== 'HEAD') {
        header('Allow: GET, HEAD, OPTIONS');
        error_response(405, 'METHOD_NOT_ALLOWED', 'Only GET is supported.');
        return;
    }

    $config = relay_config();
    $path = request_path();

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

    if (!preg_match('#^/receipts/([A-Za-z0-9_-]+)(?:/(.*))?$#', $path, $match)) {
        error_response(404, 'NOT_FOUND', 'Use GET /receipts/{provider}/{reference} or ?reference={reference}.');
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
        error_response($result['status'], $result['code'], $result['message']);
        return;
    }

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
