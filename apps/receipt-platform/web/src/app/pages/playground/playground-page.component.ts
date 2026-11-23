import { Component, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-playground-page',
  imports: [RouterLink],
  template: `<main class="playground"><header><a class="wordmark" routerLink="/">verity<span>.</span></a><nav><a routerLink="/docs">API docs</a><a routerLink="/dashboard">Dashboard</a></nav></header><section class="play-hero"><p class="eyebrow">SANDBOX · REQUEST BUILDER</p><h1>Shape a request.<br /><span>Keep secrets private.</span></h1><p>This local editor validates the JSON shape only. It does not send a request or require an API key.</p></section><section class="play-card"><div class="play-card-head"><div><span class="step-label">REQUEST BODY</span><h2>Create verification</h2></div><span class="method">POST /v1/verifications</span></div><label for="request-json">Request JSON</label><textarea id="request-json" rows="14" [value]="body()" (input)="updateBody($event)" spellcheck="false" aria-describedby="validation-result"></textarea><div class="play-actions"><button type="button" (click)="validate()">Validate JSON</button><button type="button" class="reset" (click)="reset()">Reset example</button></div><p id="validation-result" class="validation" [class.invalid]="isInvalid()" role="status" aria-live="polite">{{ result() }}</p><div class="proxy-note"><strong>Live requests are disabled.</strong> A production playground must proxy short-lived scoped credentials on the server; this deployment has no such proxy yet, so this page never transmits your request or credentials.</div></section><footer>Verity · Request shape validation only</footer></main>`,
  styles: [`.playground{max-width:1050px;min-height:100vh;margin:auto;padding:0 30px 40px;color:#20342a;font-family:'DM Sans',Inter,system-ui,sans-serif}.playground>header{height:72px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #e6ece7}.playground a{color:#496554;text-decoration:none;font-size:13px}.playground nav{display:flex;gap:22px}.wordmark{font-size:20px!important;font-weight:700;color:#1d3029!important;letter-spacing:-.06em}.wordmark span{color:#62b690}.play-hero{padding:44px 0 24px}.eyebrow,.step-label{font-size:10px;color:#49876a;font-weight:700;letter-spacing:.16em}.play-hero h1{font-size:clamp(34px,5vw,50px);line-height:1.08;letter-spacing:-.055em;margin:12px 0}.play-hero h1 span{color:#5b9a77}.play-hero p:last-child{color:#68796e;line-height:1.6;font-size:13px}.play-card{max-width:820px;padding:22px;background:#fff;border:1px solid #e3ebe4;border-radius:12px;box-shadow:0 8px 26px #20392a08}.play-card-head{display:flex;justify-content:space-between;gap:16px;align-items:start;margin-bottom:18px}.play-card h2{font-size:19px;margin:7px 0}.method{padding:7px 9px;background:#eef5ef;border-radius:5px;color:#467055;font:11px ui-monospace,monospace}.play-card label{display:block;margin-bottom:8px;font-size:12px;font-weight:600;color:#52675a}.play-card textarea{width:100%;resize:vertical;padding:15px;border:1px solid #d9e4dc;border-radius:8px;background:#15231d;color:#d9e9de;font:12px/1.7 ui-monospace,monospace}.play-card textarea:focus{outline:3px solid #83bd9655;border-color:#6eaf87}.play-actions{display:flex;gap:10px;margin-top:12px}.play-actions button{height:40px;padding:0 14px;border:0;border-radius:6px;background:#1b5137;color:white;font-size:12px;font-weight:600;cursor:pointer}.play-actions .reset{border:1px solid #dbe5dd;background:white;color:#4f6657}.validation{min-height:19px;font-size:12px;color:#36724f}.validation.invalid{color:#a03939}.proxy-note{padding:14px;border:1px solid #eddab8;background:#fffaf1;border-radius:8px;color:#75684f;font-size:11px;line-height:1.55}.proxy-note strong{display:block;color:#614c2a;margin-bottom:3px}.playground footer{margin-top:30px;padding-top:18px;border-top:1px solid #e6ece7;color:#849087;font-size:11px}@media(max-width:600px){.playground{padding:0 16px 30px}.play-card{padding:16px}.method{font-size:9px}.play-card-head{flex-direction:column}}`],
})
export class PlaygroundPageComponent {
  readonly body = signal(JSON.stringify({ provider: 'cbe', reference: 'FT…', expected: { amount: '125.00', currency: 'ETB' } }, null, 2));
  readonly result = signal('Use “Validate JSON” to check the request shape locally.');
  readonly isInvalid = signal(false);

  updateBody(event: Event): void {
    if (event.target instanceof HTMLTextAreaElement) this.body.set(event.target.value);
  }

  validate(): void {
    try {
      const value: unknown = JSON.parse(this.body());
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request body must be a JSON object.');
      const request = value as Record<string, unknown>;
      if (typeof request['provider'] !== 'string' || !/^[a-z0-9_-]{2,48}$/.test(request['provider'])) throw new Error('provider must be a lowercase provider code.');
      if (typeof request['reference'] !== 'string' || request['reference'].trim().length < 6) throw new Error('reference must contain at least 6 characters.');
      this.result.set('Valid JSON shape. This page did not send a network request.');
      this.isInvalid.set(false);
    } catch (error) {
      this.result.set(error instanceof Error ? error.message : 'Invalid request body.');
      this.isInvalid.set(true);
    }
  }

  reset(): void {
    this.body.set(JSON.stringify({ provider: 'cbe', reference: 'FT…', expected: { amount: '125.00', currency: 'ETB' } }, null, 2));
    this.result.set('Use “Validate JSON” to check the request shape locally.');
    this.isInvalid.set(false);
  }
}
