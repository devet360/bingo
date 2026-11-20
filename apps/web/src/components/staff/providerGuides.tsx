'use client';

import { useState, type ReactNode } from 'react';
import { Button, Panel } from '@/components/ui';

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="relative">
      <Button
        size="sm"
        variant="ghost"
        className="absolute right-2 top-2"
        onClick={() => void copy()}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
      <pre className="overflow-x-auto rounded-xl border border-line bg-ink/70 p-4 pr-20 text-[11px] leading-relaxed text-text">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function GuideStep({ number, title, children }: {
  number: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3 border-t border-line/60 pt-4 first:border-0 first:pt-0">
      <h3 className="text-sm font-bold text-text">
        <span className="mr-2 text-mint">{number}.</span>{title}
      </h3>
      <div className="space-y-3 text-xs leading-relaxed text-muted">{children}</div>
    </section>
  );
}

export function ProviderGuidesTab() {
  return (
    <div className="space-y-4">
      <Panel className="p-4">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-mint/80">
          Games Provider documentation
        </p>
        <h2 className="mt-1 font-display text-xl font-black tracking-tight">
          Operator setup & integration
        </h2>
        <p className="mt-2 max-w-3xl text-xs leading-relaxed text-muted">
          Follow the operator guide to add and manage a provider tenant. Use the
          integration guide when connecting another operator's wallet and launch flow.
          The matching Markdown references are
          {' '}<code>docs/GAMES-PROVIDER-OPERATOR-GUIDE.md</code> and
          {' '}<code>docs/GAMES-PROVIDER-INTEGRATION.md</code>.
        </p>
      </Panel>

      <Panel className="space-y-4 p-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-gold/80">
            Guide 1
          </p>
          <h2 className="mt-1 text-base font-bold text-text">Add a new operator</h2>
        </div>
        <GuideStep number="1" title="Confirm deployment and secrets">
          <p>
            Ensure Games Provider has a migrated database and a strong
            <code> PROVIDER_ADMIN_TOKEN</code> for the CLI. Configure the Bingo callback URL,
            currency, allowed iframe origin, and a per-operator HMAC secret. The callback
            code, Games Provider operator code, and Bingo provider code must match.
          </p>
          <p>
            To open this read-only dashboard inside Bingo web, set the same 32+ character
            <code> CONSOLE_TOKEN_SECRET</code> on Bingo API and Games Provider, and add the
            Bingo web origin to <code>ALLOWED_PARENT_ORIGINS</code>.
          </p>
        </GuideStep>
        <GuideStep number="2" title="Create the operator in Games Provider">
          <p>
            Stake and payout values are integer minor units. Keep the returned HMAC secret
            in a secret manager; the CLI prints it once.
          </p>
          <CodeBlock code={`npm run operator -w @bingo/games-provider -- create \\
  --code partner01 \\
  --name "Partner One" \\
  --callback-url https://api.example.com/games/callback/partner01 \\
  --origins https://app.example.com \\
  --currency ETB --locale en \\
  --min-stake 100 --max-stake 50000 \\
  --max-win 1000000 --max-bets 100 \\
  --games crash`} />
        </GuideStep>
        <GuideStep number="3" title="Register the provider and game in Bingo">
          <p>
            In <strong>Super Admin → Games</strong>, add the provider with code
            <code> partner01</code>, the Games Provider base URL, currency, and the same
            webhook secret. Add game ID <code>crash</code>; Bingo generates its launch
            URL from the provider base URL, operator code, external game ID, and session
            details. Use the advanced custom URL override only for a provider with a
            non-standard launch route.
          </p>
        </GuideStep>
        <GuideStep number="4" title="Probe, activate, and verify in staging">
          <CodeBlock code={`npm run operator -w @bingo/games-provider -- probe --code partner01
npm run operator -w @bingo/games-provider -- activate --code partner01`} />
          <p>
            Launch a staging session, test balance/bet/win/rollback, verify the round proof,
            and inspect active sessions and wallet outbox rows in the Provider dashboard.
            Enable the provider and game only after the checks pass.
          </p>
        </GuideStep>
        <GuideStep number="5" title="Operate and rotate credentials">
          <p>
            Use <code>update</code> to adjust origins, limits, games, or maintenance mode;
            use <code>suspend</code> to block new sessions. Coordinate secret rotation on
            both sides, probe again, and keep the previous key until pending deliveries have
            drained.
          </p>
          <CodeBlock code={`npm run operator -w @bingo/games-provider -- update \\
  --code partner01 --maintenance true --games crash
npm run operator -w @bingo/games-provider -- suspend --code partner01`} />
        </GuideStep>
      </Panel>

      <Panel className="space-y-4 p-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-gold/80">
            Guide 2
          </p>
          <h2 className="mt-1 text-base font-bold text-text">Integrate another operator</h2>
        </div>
        <GuideStep number="1" title="Create a short-lived launch session">
          <p>
            The operator owns the wallet. Create a cryptographically random session token,
            bind it to a player and operator, then embed the launch URL. URL-encode each
            substituted value and do not log or expose the token.
          </p>
          <CodeBlock code="https://games.example.com/play?operator=partner01&game=crash&token=<session-token>&lang=en&currency=ETB" />
        </GuideStep>
        <GuideStep number="2" title="Verify the callback signature on raw bytes">
          <p>
            Verify <code>x-provider-signature</code> as lowercase hex
            HMAC-SHA256 of <code>providerCode + &quot;.&quot; + rawBody</code>. Preserve the
            exact bytes received; parsing and re-serializing JSON changes the signature.
          </p>
          <CodeBlock code={`import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody, signature, secret, providerCode) {
  const supplied = (signature || '').replace(/^sha256=/, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(supplied)) return false;
  const expected = createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(providerCode + '.'), rawBody]))
    .digest();
  const given = Buffer.from(supplied, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}`} />
        </GuideStep>
        <GuideStep number="3" title="Implement idempotent wallet movements">
          <p>
            Accept <code>balance</code>, <code>bet</code>, <code>win</code>, and
            <code> rollback</code> requests. Amounts are positive integer minor units.
            Atomically apply each unique transaction once and return the same successful
            result on a legitimate retry.
          </p>
          <CodeBlock code={`// Bet/win/rollback response
{
  data: {
    accepted: true,
    replayed: false,
    balance: "9900"
  }
}`} />
        </GuideStep>
        <GuideStep number="4" title="Sign balance responses and answer probes">
          <p>
            Return the current balance, currency, Unix timestamp in seconds, and the
            callback's nonce. Sign the period-delimited values with the shared secret.
            The signed probe at <code>&lt;callback-url&gt;/probe</code> is non-monetary and
            must return a 2xx response.
          </p>
          <CodeBlock code={`const timestamp = Math.floor(Date.now() / 1000);
const balance = String(balanceMinor);
const signature = createHmac('sha256', secret)
  .update(sessionId + '.' + currency + '.' + balance + '.' + timestamp + '.' + nonce)
  .digest('hex');

return { data: { currency, balance, timestamp, nonce, signature } };`} />
        </GuideStep>
        <GuideStep number="5" title="Test failures and settlement recovery">
          <p>
            Test duplicate callbacks, timeouts, wallet rejection, expired sessions,
            operator suspension, and provider restarts in staging. Never reject a committed
            win or rollback solely because its launch session has closed. Monitor unresolved
            bets and dead/capped outbox entries from the Provider dashboard.
          </p>
        </GuideStep>
      </Panel>
    </div>
  );
}
