<?php

declare(strict_types=1);

/**
 * Minimal PSR-0 autoloader for the vendored libraries.
 *
 * The relay deploys as plain files on shared hosting with no Composer, so the
 * smalot/pdfparser tree is committed under vendor/ and classes are loaded on
 * demand here. Only its own namespace is touched.
 */
spl_autoload_register(static function (string $class): void {
    $prefix = 'Smalot\\PdfParser\\';
    if (strncmp($class, $prefix, strlen($prefix)) !== 0) {
        return;
    }
    $path = __DIR__ . '/smalot/pdfparser/src/' . str_replace('\\', '/', $class) . '.php';
    if (is_file($path)) {
        require $path;
    }
});
