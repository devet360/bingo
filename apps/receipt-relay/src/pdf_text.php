<?php

declare(strict_types=1);

/**
 * M-Pesa receipts arrive as a JSON envelope whose base64Data is a PDF.
 *
 * The relay decodes the envelope and reads the PDF's text here so the API
 * receives a few kilobytes instead of the 350 KB envelope. The PDF reader is
 * smalot/pdfparser (LGPL-3.0), vendored under vendor/ because the host has no
 * Composer. If the vendor tree is missing the caller fails over to the raw
 * answer, so an incomplete upload can never break verification.
 */

const PDF_TEXT_MAX_BYTES = 200000;

function pdf_reader_available(): bool
{
    if (!class_exists('\\Smalot\\PdfParser\\Parser')) {
        $autoload = dirname(__DIR__) . '/vendor/autoload.php';
        if (!is_file($autoload)) {
            return false;
        }
        require_once $autoload;
    }

    return class_exists('\\Smalot\\PdfParser\\Parser')
        && function_exists('gzuncompress')
        && function_exists('iconv')
        && function_exists('mb_strlen');
}

/**
 * @return array{ok:true, lines:list<string>}|array{ok:false, message:string}
 */
function pdf_text_lines(string $pdf): array
{
    if (strncmp($pdf, '%PDF-', 5) !== 0) {
        return ['ok' => false, 'message' => 'The receipt is not a PDF.'];
    }
    if (!pdf_reader_available()) {
        return ['ok' => false, 'message' => 'PDF text extraction is not available on this relay.'];
    }

    try {
        $parser = new \Smalot\PdfParser\Parser();
        $text = $parser->parseContent($pdf)->getText();
    } catch (\Throwable $e) {
        return ['ok' => false, 'message' => 'The receipt PDF could not be read.'];
    }
    if (!is_string($text) || trim($text) === '') {
        return ['ok' => false, 'message' => 'The receipt PDF has no readable text.'];
    }

    $lines = [];
    $bytes = 0;
    foreach (preg_split('/\r\n|\r|\n/', $text) ?: [] as $line) {
        $line = trim($line);
        if ($line === '') {
            continue;
        }
        $bytes += strlen($line);
        if ($bytes > PDF_TEXT_MAX_BYTES || count($lines) >= 4000) {
            break;
        }
        $lines[] = $line;
    }
    if (!$lines) {
        return ['ok' => false, 'message' => 'The receipt PDF has no readable text.'];
    }

    return ['ok' => true, 'lines' => $lines];
}

/**
 * The bank's own envelope, fail closed: a non-"0" code, bad base64 or a body
 * that is not a PDF means there is no receipt to show.
 *
 * @return array{ok:true, pdf:string}|array{ok:false, message:string}
 */
function mpesa_envelope_pdf(string $body): array
{
    $payload = json_decode($body, true);
    if (!is_array($payload)) {
        return ['ok' => false, 'message' => 'M-Pesa answered with an unreadable response.'];
    }

    if ((string) ($payload['responseCode'] ?? '') !== '0') {
        $description = $payload['responseDescription'] ?? '';
        $description = is_string($description)
            ? trim((string) preg_replace('/\s+/', ' ', $description))
            : '';
        return [
            'ok' => false,
            'message' => $description !== ''
                ? 'M-Pesa has no receipt for this reference: ' . substr($description, 0, 160)
                : 'M-Pesa has no receipt for this reference.',
        ];
    }

    $encoded = $payload['base64Data'] ?? null;
    if (!is_string($encoded) || $encoded === '') {
        return ['ok' => false, 'message' => 'M-Pesa has no receipt for this reference (missing-pdf).'];
    }

    $clean = str_replace(["\r", "\n"], '', $encoded);
    if (strlen($clean) % 4 !== 0 || preg_match('#^[A-Za-z0-9+/]+={0,2}$#', $clean) !== 1) {
        return ['ok' => false, 'message' => 'M-Pesa has no receipt for this reference (bad-base64).'];
    }

    $pdf = base64_decode($clean, true);
    if (!is_string($pdf) || strncmp($pdf, '%PDF-', 5) !== 0) {
        return ['ok' => false, 'message' => 'M-Pesa has no receipt for this reference (not-pdf).'];
    }

    return ['ok' => true, 'pdf' => $pdf];
}
