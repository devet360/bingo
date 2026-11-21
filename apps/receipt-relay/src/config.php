<?php

declare(strict_types=1);

/**
 * Endpoints are fixed templates: the caller supplies a reference, never a URL.
 * Keep the byte caps and timeouts in line with apps/api's receipt client.
 */
$config = [
    'app' => 'bingo-receipt-relay',
    'version' => '2.0.0',
    'user_agent' => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'providers' => [
        'telebirr' => [
            'name' => 'Telebirr',
            'url' => 'https://transactioninfo.ethiotelecom.et/receipt/%s',
            'reference_pattern' => '/^[A-Za-z0-9][A-Za-z0-9._-]{5,63}$/',
            'link_patterns' => [
                '~^https?://(?:www\.)?transactioninfo\.ethiotelecom\.et/receipt/([^/?#]+)~i',
            ],
            'headers' => [],
            'connect_timeout' => 5,
            'timeout' => 20,
            'max_bytes' => 2 * 1024 * 1024,
        ],
        'mpesa' => [
            'name' => 'M-Pesa',
            'url' => 'https://m-pesabusiness.safaricom.et/api/receipt/getReceipt?trxNo=%s',
            'reference_pattern' => '/^[A-Za-z0-9][A-Za-z0-9._-]{5,63}$/',
            'link_patterns' => [
                '~^https?://(?:www\.)?m-pesabusiness\.safaricom\.et/[^\s"<>]*[?&]trxNo=([^&#\s]+)~i',
            ],
            'headers' => [
                'Accept: application/json, text/plain, */*',
                'Referer: https://m-pesabusiness.safaricom.et/',
            ],
            'connect_timeout' => 5,
            'timeout' => 20,
            // ceil(5 MB / 3) * 4 + 64 KB: the M-Pesa envelope carries a base64 PDF.
            'max_bytes' => 7056044,
        ],
    ],
    'throttle' => [
        'enabled' => true,
        'per_ip_per_minute' => 30,
    ],
    'database' => [],
    'admin_bootstrap_username' => '',
    'admin_bootstrap_password' => '',
];

$localConfigPath = __DIR__ . '/config.local.php';
if (is_file($localConfigPath)) {
    $localConfig = require $localConfigPath;
    if (is_array($localConfig)) {
        $config = array_replace_recursive($config, $localConfig);
    }
}

return $config;
