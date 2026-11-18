<?php

declare(strict_types=1);

require __DIR__ . '/../src/reference.php';
require __DIR__ . '/../src/throttle.php';

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
