<?php

declare(strict_types=1);

function relay_db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }

    $database = relay_config()['database'] ?? [];
    foreach (['host', 'name', 'user', 'password'] as $required) {
        if (!isset($database[$required]) || !is_string($database[$required]) || $database[$required] === '') {
            throw new RuntimeException('MySQL is not configured.');
        }
    }
    if (!in_array('mysql', PDO::getAvailableDrivers(), true)) {
        throw new RuntimeException('The PHP PDO MySQL extension is not enabled.');
    }

    $dsn = sprintf(
        'mysql:host=%s;dbname=%s;charset=utf8mb4',
        $database['host'],
        $database['name'],
    );
    $pdo = new PDO($dsn, $database['user'], $database['password'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);
    $pdo->exec("SET time_zone = '+00:00'");
    return $pdo;
}

/**
 * Returns the active API key row after verifying its secret, otherwise null.
 *
 * @return array<string, mixed>|null
 */
function authenticated_api_key(): ?array
{
    $headers = function_exists('getallheaders') ? getallheaders() : [];
    if (!is_array($headers)) {
        $headers = [];
    }
    $key = $_SERVER['HTTP_X_API_KEY'] ?? find_header($headers, 'X-API-Key');
    $secret = $_SERVER['HTTP_X_API_SECRET'] ?? find_header($headers, 'X-API-Secret');
    if (!is_string($key) || !preg_match('/^rk_[a-f0-9]{32}$/', $key)
        || !is_string($secret) || !preg_match('/^rs_[A-Za-z0-9_-]{43}$/', $secret)
    ) {
        return null;
    }

    $pdo = relay_db();
    $query = $pdo->prepare(
        'SELECT id, secret_hash FROM api_keys WHERE api_key = :api_key AND revoked_at IS NULL LIMIT 1',
    );
    $query->execute(['api_key' => $key]);
    $row = $query->fetch();
    if (!is_array($row) || !password_verify($secret, $row['secret_hash'])) {
        return null;
    }

    $update = $pdo->prepare('UPDATE api_keys SET last_used_at = UTC_TIMESTAMP() WHERE id = :id');
    $update->execute(['id' => $row['id']]);
    return $row;
}

function find_header(array $headers, string $name): ?string
{
    foreach ($headers as $headerName => $value) {
        if (strcasecmp((string)$headerName, $name) === 0 && is_string($value)) {
            return $value;
        }
    }
    return null;
}

function record_relay_event(string $type, ?string $provider, ?string $outcome, int $apiKeyId): void
{
    $statement = relay_db()->prepare(
        'INSERT INTO relay_events (event_type, provider, outcome, api_key_id) '
        . 'VALUES (:event_type, :provider, :outcome, :api_key_id)',
    );
    $statement->execute([
        'event_type' => $type,
        'provider' => $provider,
        'outcome' => $outcome,
        'api_key_id' => $apiKeyId,
    ]);
}
