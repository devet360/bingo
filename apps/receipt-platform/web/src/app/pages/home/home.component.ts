import { Component, computed, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

interface ProviderEntry {
  code: string;
  name: string;
  method: string;
  region: string;
  monogram: string;
  evidence: string;
  kind: 'candidate' | 'relay' | 'existing';
}

type ProviderFilter = 'all' | 'candidate' | 'relay';

@Component({
  selector: 'app-home-page',
  imports: [RouterLink],
  templateUrl: './home.component.html',
  styleUrl: './home.component.css',
})
export class HomePageComponent {
  readonly providers: ProviderEntry[] = [
    { code: 'cbe', name: 'Commercial Bank of Ethiopia', method: 'Bank transfer', region: 'Ethiopia · ETB', monogram: 'C', evidence: 'Adapter port · disabled pending live test', kind: 'candidate' },
    { code: 'telebirr', name: 'Telebirr', method: 'Mobile money', region: 'Ethiopia · ETB', monogram: 'T', evidence: 'Relay required · not connected', kind: 'relay' },
    { code: 'mpesa', name: 'M-Pesa Ethiopia', method: 'Mobile money', region: 'Ethiopia · ETB', monogram: 'M', evidence: 'Relay required · not connected', kind: 'relay' },
    { code: 'boa', name: 'Bank of Abyssinia', method: 'Bank transfer', region: 'Ethiopia · ETB', monogram: 'A', evidence: 'Audit-only parser · not ported', kind: 'existing' },
    { code: 'dashen', name: 'Dashen Bank', method: 'Bank transfer', region: 'Ethiopia · ETB', monogram: 'D', evidence: 'Audit-only parser · not ported', kind: 'existing' },
    { code: 'awash', name: 'Awash Bank', method: 'Bank transfer', region: 'Ethiopia · ETB', monogram: 'W', evidence: 'Audit-only parser · not ported', kind: 'existing' },
    { code: 'cbebirr', name: 'CBE Birr', method: 'Mobile money', region: 'Ethiopia · ETB', monogram: 'B', evidence: 'Audit-only parser · not ported', kind: 'existing' },
    { code: 'ebirr', name: 'eBirr family', method: 'Mobile money', region: 'Ethiopia · ETB', monogram: 'e', evidence: 'Shared parser audit · not ported', kind: 'existing' },
    { code: 'siinqee', name: 'Siinqee Bank', method: 'Mobile money', region: 'Ethiopia · ETB', monogram: 'S', evidence: 'Shared parser audit · not ported', kind: 'existing' },
    { code: 'bunna', name: 'Bunna International Bank', method: 'Bank transfer', region: 'Ethiopia · ETB', monogram: 'B', evidence: 'Audit-only parser · not ported', kind: 'existing' },
    { code: 'zamzam', name: 'ZamZam Bank', method: 'Bank transfer', region: 'Ethiopia · ETB', monogram: 'Z', evidence: 'Audit-only parser · not ported', kind: 'existing' },
    { code: 'zemen', name: 'Zemen Bank', method: 'Bank transfer', region: 'Ethiopia · ETB', monogram: 'Z', evidence: 'Audit-only parser · not ported', kind: 'existing' },
  ];

  readonly activeFilter = signal<ProviderFilter>('all');
  readonly visibleProviders = computed(() => {
    const filter = this.activeFilter();
    return filter === 'all' ? this.providers : this.providers.filter((provider) => provider.kind === filter);
  });
  readonly candidateCount = this.providers.filter((provider) => provider.kind === 'candidate').length;
  readonly relayCount = this.providers.filter((provider) => provider.kind === 'relay').length;
  readonly requestExample = `{
  "provider": "cbe",
  "reference": "FT…",
  "receiverAccountSuffix": "23145909",
  "expected": {
    "amount": "125.00",
    "currency": "ETB"
  }
}`;

  setFilter(filter: ProviderFilter): void {
    this.activeFilter.set(filter);
  }

  focusCoverage(): void {
    document.getElementById('coverage')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}
