<?php

declare(strict_types=1);

/**
 * Telebirr HTML to plain text lines, the counterpart of the API's htmlToLines.
 *
 * The relay can answer with text instead of the 26 KB receipt page, which is
 * most of the bandwidth. The API still runs its own label parsing and gate, so
 * both sides must split the page the same way: <br> and block endings start a
 * line, and a cell boundary becomes a tab.
 */

/** Remove <script>...</script> and <style>...</style> blocks in linear time. */
function strip_script_style(string $html): string
{
    foreach (['script', 'style'] as $tag) {
        $lower = strtolower($html);
        $open = '<' . $tag;
        $close = '</' . $tag;
        $out = '';
        $pos = 0;
        while (true) {
            $start = strpos($lower, $open, $pos);
            if ($start === false) {
                $out .= substr($html, $pos);
                break;
            }
            $out .= substr($html, $pos, $start - $pos);
            $end = strpos($lower, $close, $start + strlen($open));
            if ($end === false) {
                break;
            }
            $gt = strpos($lower, '>', $end);
            $pos = $gt === false ? strlen($html) : $gt + 1;
        }
        $html = $out;
    }

    return $html;
}

/** Remove <!-- ... --> blocks; Telebirr hides disabled invoice rows there. */
function strip_html_comments(string $html): string
{
    $out = '';
    $pos = 0;
    while (true) {
        $start = strpos($html, '<!--', $pos);
        if ($start === false) {
            $out .= substr($html, $pos);
            break;
        }
        $out .= substr($html, $pos, $start - $pos);
        $end = strpos($html, '-->', $start + 4);
        if ($end === false) {
            break;
        }
        $pos = $end + 3;
    }

    return $out;
}

/**
 * Non-empty, trimmed text lines.
 *
 * @return list<string>
 */
function html_to_lines(string $html): array
{
    $text = strip_html_comments(strip_script_style($html));
    $text = (string) preg_replace('/<br\s*\/?>/i', "\n", $text);
    $text = (string) preg_replace('/<\/t[dh]>\s*<t[dh][^<>]*>/i', "\t", $text);
    $text = (string) preg_replace('/<\/tr>/i', "\n", $text);
    $text = (string) preg_replace('/<\/(?:div|p|li|h\d)>/i', "\n", $text);
    $text = (string) preg_replace('/<[^<>]*>/', ' ', $text);
    $text = html_entity_decode($text, ENT_QUOTES | ENT_HTML5, 'UTF-8');
    // html_entity_decode leaves a non-breaking space; trim() would keep it.
    $text = str_replace("\xC2\xA0", ' ', $text);

    $lines = [];
    foreach (explode("\n", $text) as $line) {
        $line = trim($line);
        if ($line !== '') {
            $lines[] = $line;
        }
    }

    return $lines;
}
