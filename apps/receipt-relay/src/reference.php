<?php

declare(strict_types=1);

/**
 * Take the reference from a typed value or a pasted receipt link, then check
 * its shape. The provider's URL template, never the caller's text, decides
 * where the request goes.
 */
function extract_reference(array $provider, string $raw): ?string
{
    $value = trim($raw);
    if ($value === '' || strlen($value) > 512) {
        return null;
    }

    if (preg_match('#^https?://#i', $value)) {
        $found = null;
        foreach ($provider['link_patterns'] as $pattern) {
            if (preg_match($pattern, $value, $match)) {
                $found = rawurldecode($match[1]);
                break;
            }
        }
        if ($found === null) {
            return null;
        }
        $value = trim($found);
    }

    $value = trim($value, " \t\n\r\0\x0B<>\"'");
    if ($value === '' || !preg_match($provider['reference_pattern'], $value)) {
        return null;
    }
    return $value;
}
