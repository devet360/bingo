import { Component, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

declare global {
  interface Window {
    Telegram?: {
      WebApp: {
        initData: string;
        ready(): void;
        expand(): void;
        setHeaderColor(color: string): void;
        setBackgroundColor(color: string): void;
      };
    };
  }
}

@Component({
  selector: 'app-telegram-mini-app',
  imports: [RouterLink],
  template: `<main class="mini-page"><header><a class="wordmark" routerLink="/">verity<span>.</span></a><span class="mini-badge">TELEGRAM MINI APP</span></header><section class="mini-card"><div class="mini-icon" aria-hidden="true">v.</div><p class="eyebrow">TELEGRAM ENTRY</p><h1>Continue to Verity.</h1><p class="mini-copy">The Mini App accepts Telegram identity only after the backend verifies the signed <code>initData</code>. Client-side Telegram profile fields are never trusted.</p><div class="mini-status" role="status" aria-live="polite"><span class="status-dot" [class.ready]="insideTelegram()"></span><div><strong>{{ insideTelegram() ? 'Telegram client detected' : 'Open this page from Telegram' }}</strong><p>{{ status() }}</p></div></div><a class="mini-link" routerLink="/scan">Open receipt scanner <span aria-hidden="true">→</span></a>        <p class="mini-footnote">{{ identityValidated() ? 'The server validated this launch signature. Account linking and verification actions still require a linked platform account.' : 'User account linking and authenticated verification actions stay unavailable until the account-link service is configured.' }}</p></section><footer>Verity · Telegram access is server-validated</footer></main>`,
  styles: [`.mini-page{max-width:680px;min-height:100vh;margin:auto;padding:0 24px 32px;color:#20342a;font-family:'DM Sans',Inter,system-ui,sans-serif}.mini-page>header{height:68px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #e6ece7}.mini-page a{color:#496554;text-decoration:none}.wordmark{font-size:20px;font-weight:700;color:#1d3029;letter-spacing:-.06em}.wordmark span{color:#62b690}.mini-badge{font-size:9px;letter-spacing:.1em;color:#55755f}.mini-card{margin:56px auto 0;padding:30px;background:#fff;border:1px solid #e1e9e3;border-radius:16px;box-shadow:0 12px 34px #20392a0d}.mini-icon{display:grid;place-items:center;width:42px;height:42px;border:1px solid #93c8a5;border-radius:12px;color:#34764c;font-weight:700;margin-bottom:24px}.eyebrow{font-size:10px;color:#49876a;font-weight:700;letter-spacing:.16em}.mini-card h1{font-size:clamp(30px,6vw,43px);letter-spacing:-.055em;margin:9px 0 12px}.mini-copy{color:#68796e;font-size:13px;line-height:1.65}.mini-copy code{padding:2px 4px;background:#f0f5f0;border-radius:3px;color:#376547}.mini-status{display:flex;gap:12px;align-items:flex-start;padding:15px;margin:22px 0;border:1px solid #e3ebe4;border-radius:9px;background:#f7faf7}.status-dot{width:9px;height:9px;margin-top:4px;border-radius:50%;background:#d6a254}.status-dot.ready{background:#58a575;box-shadow:0 0 0 3px #58a5752a}.mini-status strong{font-size:12px}.mini-status p{margin:5px 0 0;color:#68796e;font-size:11px;line-height:1.5}.mini-link{display:inline-flex;gap:9px;align-items:center;padding:12px 15px;border-radius:7px;background:#1b5137;color:#fff!important;font-weight:600;font-size:12px}.mini-footnote{margin:20px 0 0;color:#8a7a5d;font-size:11px;line-height:1.6}.mini-page footer{margin-top:28px;color:#849087;font-size:11px}@media(max-width:520px){.mini-page{padding:0 14px 24px}.mini-card{margin-top:32px;padding:22px}}`],
})
export class TelegramMiniAppComponent implements OnInit {
  readonly insideTelegram = signal(false);
  readonly identityValidated = signal(false);
  readonly status = signal('Telegram init data has not been submitted for server-side validation.');

  ngOnInit(): void {
    const telegram = window.Telegram?.WebApp;
    if (!telegram) return;
    if (!telegram.initData) {
      this.status.set('No signed launch data was provided by Telegram.');
      return;
    }
    telegram.ready();
    telegram.expand();
    telegram.setHeaderColor('#f4f7f4');
    telegram.setBackgroundColor('#f4f7f4');
    this.insideTelegram.set(true);
    this.status.set('Checking Telegram signature with the platform API…');
    void fetch('/telegram/mini-app/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: telegram.initData }),
      credentials: 'omit',
    }).then(async (response) => {
      if (!response.ok) throw new Error('The server did not accept Telegram launch data.');
      const identity: unknown = await response.json();
      if (!identity || typeof identity !== 'object' || !('id' in identity)) throw new Error('The server returned an invalid identity response.');
      this.identityValidated.set(true);
      this.status.set('Telegram launch signature validated by the server.');
    }).catch(() => {
      this.identityValidated.set(false);
      this.status.set('Server validation is unavailable. The app did not trust Telegram profile data from the browser.');
    });
  }
}
