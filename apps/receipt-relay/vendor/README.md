# Vendored libraries

The relay runs as plain PHP files on hosting without Composer, so the one
library it needs is checked in unmodified:

| Library | Version | License | Used for |
| --- | --- | --- | --- |
| [smalot/pdfparser](https://github.com/smalot/pdfparser) | v2.13.1 (`a71c6dd38e60a995fdb4d36e4433b8b3557c65dc`) | LGPL-3.0 | Reading the M-Pesa receipt PDF |

`autoload.php` is the only file written here: a PSR-0 loader for the
`Smalot\PdfParser\` namespace, which the library's `composer.json` declares.

To upgrade, download the release tarball, replace
`smalot/pdfparser/src/` and `smalot/pdfparser/LICENSE.txt`, and update the
version above. Keep the sources unmodified.

The relay still works without this directory: the text endpoint answers
`EXTRACTION_FAILED` and the API falls back to the raw body.
