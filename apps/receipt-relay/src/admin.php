<?php

declare(strict_types=1);

function admin_session_start(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }
    session_name('receipt_relay_admin');
    session_set_cookie_params([
        'httponly' => true,
        'secure' => request_is_https(),
        'samesite' => 'Strict',
        'path' => '/',
    ]);
    session_start();
}

function admin_escape(string $value): string
{
    return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function admin_csrf_token(): string
{
    if (!isset($_SESSION['csrf_token']) || !is_string($_SESSION['csrf_token'])) {
        $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
    }
    return $_SESSION['csrf_token'];
}

function admin_csrf_valid(): bool
{
    return isset($_POST['csrf_token'], $_SESSION['csrf_token'])
        && is_string($_POST['csrf_token'])
        && hash_equals($_SESSION['csrf_token'], $_POST['csrf_token']);
}

function admin_redirect(string $path): void
{
    header('Location: ' . $path, true, 303);
}

function admin_page(string $title, string $content): void
{
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: DENY');
    header('Referrer-Policy: same-origin');
    echo '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        . '<meta name="viewport" content="width=device-width, initial-scale=1">'
        . '<title>' . admin_escape($title) . ' - Receipt Relay</title>'
        . '<style>
        :root{font:16px/1.5 system-ui,sans-serif;color:#172033;background:#f3f6fb}
        body{margin:0}.wrap{max-width:1080px;margin:36px auto;padding:0 20px}
        h1,h2{line-height:1.2}.card{background:white;border:1px solid #dfe5ef;border-radius:12px;padding:20px;margin:18px 0}
        .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px}
        .metric{font-size:1.8rem;font-weight:700}.muted{color:#5d687c}.alert{padding:12px;background:#fff2ce;border-radius:8px;overflow-wrap:anywhere}
        label{display:block;font-weight:600;margin:10px 0 4px}input{font:inherit;padding:9px;max-width:100%;box-sizing:border-box}
        button{font:inherit;padding:9px 14px;border:0;border-radius:7px;background:#174ea6;color:#fff;cursor:pointer}
        .danger{background:#a83232}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px;border-bottom:1px solid #e6eaf0}
        form.inline{display:inline}pre{white-space:pre-wrap;overflow-wrap:anywhere}
        @media(max-width:600px){.wrap{margin:16px auto}table{font-size:.88rem}}
        </style></head><body><main class="wrap">' . $content . '</main></body></html>';
}

function bootstrap_admin(PDO $pdo): ?array
{
    $existing = $pdo->query('SELECT id, username, password_hash FROM admin_users WHERE id = 1')->fetch();
    if (is_array($existing)) {
        return $existing;
    }

    $config = relay_config();
    $username = $config['admin_bootstrap_username'] ?? '';
    $password = $config['admin_bootstrap_password'] ?? '';
    if (!is_string($username) || $username === '' || !is_string($password) || strlen($password) < 16) {
        return null;
    }

    try {
        $insert = $pdo->prepare(
            'INSERT INTO admin_users (id, username, password_hash) VALUES (1, :username, :password_hash)',
        );
        $insert->execute([
            'username' => $username,
            'password_hash' => password_hash($password, PASSWORD_DEFAULT),
        ]);
    } catch (PDOException $error) {
        if ($error->getCode() !== '23000') {
            throw $error;
        }
    }
    $existing = $pdo->query('SELECT id, username, password_hash FROM admin_users WHERE id = 1')->fetch();
    return is_array($existing) ? $existing : null;
}

function admin_render_login(?string $message = null): void
{
    $notice = $message ? '<p class="alert">' . admin_escape($message) . '</p>' : '';
    $csrf = admin_escape(admin_csrf_token());
    admin_page('Admin login', '<h1>Receipt Relay</h1><section class="card"><h2>Super-admin login</h2>'
        . $notice . '<form method="post" action="/admin"><input type="hidden" name="action" value="login">'
        . '<input type="hidden" name="csrf_token" value="' . $csrf . '">'
        . '<label for="username">Username</label><input id="username" name="username" autocomplete="username" required>'
        . '<label for="password">Password</label><input id="password" type="password" name="password" autocomplete="current-password" required>'
        . '<p><button type="submit">Sign in</button></p></form></section>');
}

function handle_admin_request(string $path, string $method): void
{
    admin_session_start();
    if ($path !== '/admin' && $path !== '/admin/') {
        http_response_code(404);
        admin_page('Not found', '<h1>Not found</h1>');
        return;
    }
    if ($method !== 'GET' && $method !== 'POST') {
        header('Allow: GET, POST, OPTIONS');
        error_response(405, 'METHOD_NOT_ALLOWED', 'Use GET or POST for the admin dashboard.');
        return;
    }

    try {
        $pdo = relay_db();
        $bootstrap = bootstrap_admin($pdo);
        if ($method === 'POST') {
            if (!admin_csrf_valid()) {
                http_response_code(400);
                admin_page('Invalid request', '<h1>Invalid or expired form token.</h1>');
                return;
            }
            $action = is_string($_POST['action'] ?? null) ? $_POST['action'] : '';
            if ($action === 'login') {
                if (!throttle_allow('admin:' . client_ip(), 10)) {
                    admin_render_login('Too many login attempts. Wait a minute and try again.');
                    return;
                }
                $username = is_string($_POST['username'] ?? null) ? trim($_POST['username']) : '';
                $password = is_string($_POST['password'] ?? null) ? $_POST['password'] : '';
                if ($bootstrap !== null && hash_equals($bootstrap['username'], $username)
                    && password_verify($password, $bootstrap['password_hash'])
                ) {
                    session_regenerate_id(true);
                    $_SESSION['admin_id'] = 1;
                    admin_redirect('/admin');
                    return;
                }
                admin_render_login('Invalid username or password.');
                return;
            }

            if (($_SESSION['admin_id'] ?? null) !== 1) {
                admin_render_login('Sign in to continue.');
                return;
            }
            if ($action === 'logout') {
                $_SESSION = [];
                session_destroy();
                admin_redirect('/admin');
                return;
            }
            if ($action === 'create_key') {
                $name = trim(is_string($_POST['name'] ?? null) ? $_POST['name'] : '');
                if ($name === '' || strlen($name) > 120) {
                    $_SESSION['flash'] = 'Enter a key name no longer than 120 characters.';
                    admin_redirect('/admin');
                    return;
                }
                $key = 'rk_' . bin2hex(random_bytes(16));
                $secret = 'rs_' . rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
                $insert = $pdo->prepare(
                    'INSERT INTO api_keys (name, api_key, secret_hash) VALUES (:name, :api_key, :secret_hash)',
                );
                $insert->execute([
                    'name' => $name,
                    'api_key' => $key,
                    'secret_hash' => password_hash($secret, PASSWORD_DEFAULT),
                ]);
                $_SESSION['new_key'] = ['key' => $key, 'secret' => $secret];
                admin_redirect('/admin');
                return;
            }
            if ($action === 'revoke_key') {
                $id = filter_var($_POST['key_id'] ?? null, FILTER_VALIDATE_INT);
                if ($id === false || $id === null || $id < 1) {
                    $_SESSION['flash'] = 'Invalid API key.';
                } else {
                    $revoke = $pdo->prepare(
                        'UPDATE api_keys SET revoked_at = UTC_TIMESTAMP() WHERE id = :id AND revoked_at IS NULL',
                    );
                    $revoke->execute(['id' => $id]);
                    $_SESSION['flash'] = $revoke->rowCount() > 0 ? 'API key revoked.' : 'API key was already revoked.';
                }
                admin_redirect('/admin');
                return;
            }
            if ($action === 'change_password') {
                $current = is_string($_POST['current_password'] ?? null) ? $_POST['current_password'] : '';
                $new = is_string($_POST['new_password'] ?? null) ? $_POST['new_password'] : '';
                if ($bootstrap === null || !password_verify($current, $bootstrap['password_hash'])) {
                    $_SESSION['flash'] = 'Current password is incorrect.';
                } elseif (strlen($new) < 16) {
                    $_SESSION['flash'] = 'New password must be at least 16 characters.';
                } else {
                    $change = $pdo->prepare('UPDATE admin_users SET password_hash = :password_hash WHERE id = 1');
                    $change->execute(['password_hash' => password_hash($new, PASSWORD_DEFAULT)]);
                    $_SESSION['flash'] = 'Password changed.';
                }
                admin_redirect('/admin');
                return;
            }
            $_SESSION['flash'] = 'Unknown dashboard action.';
            admin_redirect('/admin');
            return;
        }

        if (($_SESSION['admin_id'] ?? null) !== 1) {
            if ($bootstrap === null) {
                admin_render_login('Configure a bootstrap username and a password of at least 16 characters in src/config.local.php first.');
                return;
            }
            admin_render_login();
            return;
        }

        $stats = $pdo->query(
            "SELECT
                SUM(event_type = 'request' AND created_at >= UTC_TIMESTAMP() - INTERVAL 1 DAY) AS requests_24h,
                SUM(event_type = 'request' AND created_at >= UTC_TIMESTAMP() - INTERVAL 30 DAY) AS requests_30d,
                SUM(event_type = 'verification' AND outcome = 'VERIFIED' AND created_at >= UTC_TIMESTAMP() - INTERVAL 30 DAY) AS verified_30d,
                SUM(event_type = 'verification' AND created_at >= UTC_TIMESTAMP() - INTERVAL 30 DAY) AS verifications_30d
             FROM relay_events",
        )->fetch() ?: [];
        $providerStats = $pdo->query(
            "SELECT provider,
                SUM(event_type = 'request') AS requests,
                SUM(event_type = 'verification' AND outcome = 'VERIFIED') AS verified,
                SUM(event_type = 'verification') AS total,
                MAX(CASE WHEN event_type = 'verification' THEN created_at END) AS last_checked
             FROM relay_events
             WHERE provider IS NOT NULL AND created_at >= UTC_TIMESTAMP() - INTERVAL 30 DAY
             GROUP BY provider ORDER BY provider",
        )->fetchAll();
        $keys = $pdo->query(
            'SELECT id, name, api_key, created_at, last_used_at, revoked_at FROM api_keys ORDER BY id DESC',
        )->fetchAll();
        $recent = $pdo->query(
            "SELECT provider, outcome, created_at FROM relay_events
             WHERE event_type = 'verification' ORDER BY id DESC LIMIT 10",
        )->fetchAll();
        $flash = is_string($_SESSION['flash'] ?? null) ? $_SESSION['flash'] : null;
        unset($_SESSION['flash']);
        $newKey = is_array($_SESSION['new_key'] ?? null) ? $_SESSION['new_key'] : null;
        unset($_SESSION['new_key']);
        render_admin_dashboard($stats, $providerStats, $keys, $recent, $flash, $newKey);
    } catch (Throwable $error) {
        error_log('Receipt relay dashboard failed: ' . $error->getMessage());
        http_response_code(503);
        admin_page('Dashboard unavailable', '<h1>Dashboard unavailable</h1>'
            . '<p>Check the MySQL connection and import database/schema.sql.</p>');
    }
}

function render_admin_dashboard(
    array $stats,
    array $providerStats,
    array $keys,
    array $recent,
    ?string $flash,
    ?array $newKey,
): void {
    $csrf = admin_escape(admin_csrf_token());
    $notice = $flash ? '<p class="alert">' . admin_escape($flash) . '</p>' : '';
    if ($newKey !== null) {
        $notice .= '<div class="alert"><strong>Copy these credentials now; the secret will not be shown again.</strong>'
            . '<p>API key: <code>' . admin_escape($newKey['key']) . '</code><br>API secret: <code>'
            . admin_escape($newKey['secret']) . '</code></p></div>';
    }

    $providerRows = '';
    foreach ($providerStats as $row) {
        $providerRows .= '<tr><td>' . admin_escape((string)$row['provider']) . '</td><td>'
            . (int)$row['requests'] . '</td><td>' . (int)$row['verified'] . '</td><td>'
            . (int)$row['total'] . '</td><td>'
            . admin_escape((string)($row['last_checked'] ?? '-')) . '</td></tr>';
    }
    if ($providerRows === '') {
        $providerRows = '<tr><td colspan="5" class="muted">No requests or verification reports received in the last 30 days.</td></tr>';
    }

    $keyRows = '';
    foreach ($keys as $row) {
        $keyRows .= '<tr><td>' . admin_escape($row['name']) . '</td><td><code>'
            . admin_escape($row['api_key']) . '</code></td><td>'
            . admin_escape($row['last_used_at'] ?? 'Never') . '</td><td>'
            . ($row['revoked_at'] === null
                ? '<form class="inline" method="post" action="/admin"><input type="hidden" name="csrf_token" value="'
                    . $csrf . '"><input type="hidden" name="action" value="revoke_key"><input type="hidden" name="key_id" value="'
                    . (int)$row['id'] . '"><button class="danger" type="submit">Revoke</button></form>'
                : 'Revoked')
            . '</td></tr>';
    }
    if ($keyRows === '') {
        $keyRows = '<tr><td colspan="4" class="muted">No API keys created.</td></tr>';
    }

    $recentRows = '';
    foreach ($recent as $row) {
        $recentRows .= '<tr><td>' . admin_escape((string)$row['created_at']) . '</td><td>'
            . admin_escape((string)$row['provider']) . '</td><td>'
            . admin_escape((string)$row['outcome']) . '</td></tr>';
    }
    if ($recentRows === '') {
        $recentRows = '<tr><td colspan="3" class="muted">No verification reports received.</td></tr>';
    }

    $content = '<header><h1>Receipt Relay dashboard</h1><p class="muted">Aggregate API traffic and verification outcomes. Receipt references are not retained.</p>'
        . '<form class="inline" method="post" action="/admin"><input type="hidden" name="csrf_token" value="' . $csrf
        . '"><input type="hidden" name="action" value="logout"><button type="submit">Sign out</button></form></header>'
        . $notice
        . '<section class="grid"><article class="card"><div class="muted">API requests - 24 hours</div><div class="metric">'
        . (int)($stats['requests_24h'] ?? 0) . '</div></article><article class="card"><div class="muted">API requests - 30 days</div><div class="metric">'
        . (int)($stats['requests_30d'] ?? 0) . '</div></article><article class="card"><div class="muted">Verified receipts - 30 days</div><div class="metric">'
        . (int)($stats['verified_30d'] ?? 0) . '</div></article><article class="card"><div class="muted">Reported checks - 30 days</div><div class="metric">'
        . (int)($stats['verifications_30d'] ?? 0) . '</div></article></section>'
        . '<section class="card"><h2>Traffic and verification by provider - 30 days</h2><table><thead><tr><th>Provider</th><th>API requests</th><th>Verified</th><th>Total checks</th><th>Last check (UTC)</th></tr></thead><tbody>'
        . $providerRows . '</tbody></table></section>'
        . '<section class="card"><h2>API credentials</h2><p class="muted">Secrets are hashed in MySQL and displayed only once when created.</p>'
        . '<form method="post" action="/admin"><input type="hidden" name="csrf_token" value="' . $csrf
        . '"><input type="hidden" name="action" value="create_key"><label for="key-name">Key name</label>'
        . '<input id="key-name" name="name" maxlength="120" required><button type="submit">Create API key</button></form>'
        . '<table><thead><tr><th>Name</th><th>API key</th><th>Last used</th><th>Action</th></tr></thead><tbody>'
        . $keyRows . '</tbody></table></section>'
        . '<section class="card"><h2>Recent verification reports</h2><table><thead><tr><th>Time (UTC)</th><th>Provider</th><th>Outcome</th></tr></thead><tbody>'
        . $recentRows . '</tbody></table></section>'
        . '<section class="card"><h2>Change super-admin password</h2><form method="post" action="/admin">'
        . '<input type="hidden" name="csrf_token" value="' . $csrf . '"><input type="hidden" name="action" value="change_password">'
        . '<label for="current-password">Current password</label><input id="current-password" type="password" name="current_password" required>'
        . '<label for="new-password">New password (at least 16 characters)</label><input id="new-password" type="password" name="new_password" minlength="16" required>'
        . '<button type="submit">Change password</button></form></section>';
    admin_page('Dashboard', $content);
}
