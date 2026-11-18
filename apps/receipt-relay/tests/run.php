<?php

declare(strict_types=1);

require __DIR__ . '/../src/reference.php';
require __DIR__ . '/../src/throttle.php';
require __DIR__ . '/../src/html_text.php';
require __DIR__ . '/../src/pdf_text.php';

$failures = 0;

function check(string $name, bool $ok): void
{
    global $failures;
    if ($ok) {
        echo "ok: {$name}\n";
        return;
    }
    $failures++;
    fwrite(STDERR, "FAIL: {$name}\n");
}

$config = require __DIR__ . '/../src/config.php';
$telebirr = $config['providers']['telebirr'];
$mpesa = $config['providers']['mpesa'];

check('telebirr plain reference', extract_reference($telebirr, 'DG12345678') === 'DG12345678');
check(
    'telebirr receipt link',
    extract_reference($telebirr, 'https://transactioninfo.ethiotelecom.et/receipt/DG12345678') === 'DG12345678',
);
check('telebirr rejects path tricks', extract_reference($telebirr, '../../etc/passwd') === null);
check('telebirr rejects spaces', extract_reference($telebirr, 'DG1234 5678') === null);
check('telebirr rejects foreign links', extract_reference($telebirr, 'https://evil.example/receipt/DG12345678') === null);

check('mpesa plain reference', extract_reference($mpesa, 'SFJ8K2LM9P') === 'SFJ8K2LM9P');
check(
    'mpesa receipt link',
    extract_reference($mpesa, 'https://m-pesabusiness.safaricom.et/api/receipt/getReceipt?trxNo=SFJ8K2LM9P') === 'SFJ8K2LM9P',
);
check('mpesa rejects spaces', extract_reference($mpesa, 'SFJ8 K2LM9P') === null);
check('mpesa rejects other query links', extract_reference($mpesa, 'https://m-pesabusiness.safaricom.et/api/receipt/getReceipt?other=1') === null);

// ---- text extraction (format=text) ----

$html = '<html><head><title>telebirr receipt</title></head><body>'
    . '<table><tr><td>Payer Name</td><td>ABEBE KEBEDE</td></tr>'
    . '<tr><td>Settled Amount</td><td>104 Birr</td></tr></table>'
    . '<!-- <tr><td>Excise Tax</td><td>0 Birr</td></tr> -->'
    . '<br><p>Total Paid Amount</p><p>106 Birr</p></body></html>';
$lines = html_to_lines($html);
check('html text keeps a table row on one line', str_contains($lines[0], "Payer Name\tABEBE KEBEDE"));
check('html text drops commented rows', array_filter($lines, fn ($l) => str_contains($l, 'Excise Tax')) === []);
check('html text starts lines at <br> and </p>', in_array('Total Paid Amount', $lines, true) && in_array('106 Birr', $lines, true));
$scripted = html_to_lines('<style>.x{color:red}</style><script>var a = 1;</script><div>ok</div>');
check('html text strips scripts and styles', $scripted === ['ok']);
$entities = html_to_lines('<div>A &amp; B &#39;quoted&#39;</div>');
check('html text decodes entities', $entities === ["A & B 'quoted'"]);

check('mpesa envelope rejects a non-JSON body', mpesa_envelope_pdf('not json')['ok'] === false);
$missing = mpesa_envelope_pdf((string) json_encode([
    'responseCode' => '2032',
    'responseDescription' => 'The transaction receipt number does not exist.',
]));
check(
    'mpesa envelope maps a non-zero code to "no receipt"',
    $missing['ok'] === false && str_contains($missing['message'], 'does not exist'),
);
$pdfBody = "%PDF-1.4\n";
$valid = mpesa_envelope_pdf((string) json_encode(['responseCode' => '0', 'base64Data' => base64_encode($pdfBody)]));
check('mpesa envelope decodes the PDF', $valid['ok'] === true && $valid['pdf'] === $pdfBody);
$badBase64 = mpesa_envelope_pdf((string) json_encode(['responseCode' => '0', 'base64Data' => 'not base64!!']));
check('mpesa envelope rejects bad base64', $badBase64['ok'] === false && str_contains($badBase64['message'], 'bad-base64'));

check('pdf text extraction is available', pdf_reader_available() === true);
$fixture = (string) file_get_contents(__DIR__ . '/fixtures/text.pdf');
$pdfText = pdf_text_lines($fixture);
check(
    'pdf text reads the receipt line',
    $pdfText['ok'] === true && in_array('TRANSACTION ID', $pdfText['lines'], true),
);
check('pdf text rejects a non-PDF', pdf_text_lines('hello')['ok'] === false);

$tmp = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'relay-throttle-test-' . bin2hex(random_bytes(4));
check(
    'throttle allows up to the limit',
    throttle_allow('1.2.3.4', 2, $tmp) === true && throttle_allow('1.2.3.4', 2, $tmp) === true,
);
check('throttle blocks past the limit', throttle_allow('1.2.3.4', 2, $tmp) === false);
check('throttle counts each IP separately', throttle_allow('5.6.7.8', 2, $tmp) === true);
foreach (glob($tmp . DIRECTORY_SEPARATOR . '*') ?: [] as $file) {
    @unlink($file);
}
@rmdir($tmp);

if ($failures > 0) {
    fwrite(STDERR, "{$failures} relay test(s) failed.\n");
    exit(1);
}
echo "All relay tests passed.\n";
