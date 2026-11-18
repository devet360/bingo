<?php

declare(strict_types=1);

/**
 * Keep the public endpoint from being used to hammer the banks. File-based and
 * fails open: a read-only temp directory must not take the relay down.
 */
function throttle_allow(string $ip, int $limit, ?string $dir = null): bool
{
    $dir ??= rtrim(sys_get_temp_dir(), '/\\') . DIRECTORY_SEPARATOR . 'bingo-receipt-relay';

    try {
        if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) {
            return true;
        }

        if (mt_rand(1, 100) === 1) {
            foreach (glob($dir . DIRECTORY_SEPARATOR . '*.json') ?: [] as $stale) {
                if (@filemtime($stale) < time() - 3600) {
                    @unlink($stale);
                }
            }
        }

        $file = $dir . DIRECTORY_SEPARATOR . sha1($ip) . '.json';
        $handle = @fopen($file, 'c+');
        if ($handle === false) {
            return true;
        }

        try {
            if (!flock($handle, LOCK_EX)) {
                return true;
            }
            $now = time();
            $window = intdiv($now, 60);
            $raw = stream_get_contents($handle);
            $state = is_string($raw) && $raw !== '' ? json_decode($raw, true) : null;
            if (!is_array($state) || ($state['window'] ?? null) !== $window) {
                $state = ['window' => $window, 'count' => 0];
            }
            $state['count'] = (int)$state['count'] + 1;
            ftruncate($handle, 0);
            rewind($handle);
            fwrite($handle, json_encode($state));
            fflush($handle);
            flock($handle, LOCK_UN);
            return $state['count'] <= $limit;
        } finally {
            fclose($handle);
        }
    } catch (Throwable $e) {
        return true;
    }
}
