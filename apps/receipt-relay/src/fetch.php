<?php

declare(strict_types=1);

/**
 * Fetch the bank's own answer with curl. Redirects are off: the URL is a
 * fixed provider template, so a redirect means something unexpected.
 *
 * Returns ['ok' => true, 'status' => int, 'contentType' => string, 'body' => string]
 * or ['ok' => false, 'status' => int, 'code' => string, 'message' => string].
 */
function fetch_receipt(string $url, array $provider, string $userAgent): array
{
    if (!function_exists('curl_init')) {
        return [
            'ok' => false,
            'status' => 500,
            'code' => 'RELAY_MISCONFIGURED',
            'message' => 'The relay host is missing the PHP curl extension.',
        ];
    }

    $maxBytes = (int)($provider['max_bytes'] ?? 2 * 1024 * 1024);
    $body = '';
    $tooLarge = false;
    $contentType = '';

    $curl = curl_init($url);
    if ($curl === false) {
        return ['ok' => false, 'status' => 502, 'code' => 'UPSTREAM_ERROR', 'message' => 'Could not start the request.'];
    }

    $headers = array_merge(['User-Agent: ' . $userAgent, 'Accept: */*'], $provider['headers'] ?? []);

    curl_setopt_array($curl, [
        CURLOPT_RETURNTRANSFER => false,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_CONNECTTIMEOUT => (int)($provider['connect_timeout'] ?? 5),
        CURLOPT_TIMEOUT => (int)($provider['timeout'] ?? 20),
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_ENCODING => '',
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_WRITEFUNCTION => function ($_curl, string $chunk) use (&$body, &$tooLarge, $maxBytes): int {
            if ($tooLarge) {
                return 0;
            }
            if (strlen($body) + strlen($chunk) > $maxBytes) {
                $tooLarge = true;
                return 0;
            }
            $body .= $chunk;
            return strlen($chunk);
        },
        CURLOPT_HEADERFUNCTION => function ($_curl, string $line) use (&$contentType): int {
            if (stripos($line, 'content-type:') === 0) {
                $contentType = trim(substr($line, 13));
            }
            return strlen($line);
        },
    ]);
    // PHP 8.3 deprecates CURLOPT_PROTOCOLS in favour of the string form.
    if (defined('CURLOPT_PROTOCOLS_STR')) {
        curl_setopt($curl, constant('CURLOPT_PROTOCOLS_STR'), 'https');
    } else {
        curl_setopt($curl, CURLOPT_PROTOCOLS, CURLPROTO_HTTPS);
    }

    curl_exec($curl);
    $errno = curl_errno($curl);
    $status = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    curl_close($curl);

    if ($tooLarge) {
        return ['ok' => false, 'status' => 502, 'code' => 'TOO_LARGE', 'message' => 'The bank response was larger than expected.'];
    }
    if ($errno === CURLE_OPERATION_TIMEDOUT) {
        return ['ok' => false, 'status' => 504, 'code' => 'TIMEOUT', 'message' => 'The bank did not answer in time.'];
    }
    if ($errno !== 0 || $status === 0) {
        return ['ok' => false, 'status' => 502, 'code' => 'UPSTREAM_ERROR', 'message' => 'Could not connect to the bank.'];
    }
    if ($status >= 300 && $status < 400) {
        return ['ok' => false, 'status' => 502, 'code' => 'UPSTREAM_ERROR', 'message' => 'The bank answered with a redirect.'];
    }

    return ['ok' => true, 'status' => $status, 'contentType' => $contentType, 'body' => $body];
}
