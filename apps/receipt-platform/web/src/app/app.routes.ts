import { Routes } from '@angular/router';
import { HomePageComponent } from './pages/home/home.component';
import { ReceiptScanComponent } from './pages/scan/receipt-scan.component';
import { DashboardPageComponent } from './pages/dashboard/dashboard-page.component';
import { AdminPageComponent } from './pages/admin/admin-page.component';
import { DocsPageComponent } from './pages/docs/docs-page.component';
import { PlaygroundPageComponent } from './pages/playground/playground-page.component';
import { TelegramMiniAppComponent } from './pages/mini-app/telegram-mini-app.component';

export const routes: Routes = [
  { path: '', component: HomePageComponent, title: 'Verity | Receipt verification' },
  { path: 'scan', component: ReceiptScanComponent, title: 'Receipt scan | Verity' },
  { path: 'dashboard', component: DashboardPageComponent, title: 'Dashboard | Verity' },
  { path: 'admin', component: AdminPageComponent, title: 'Operations | Verity' },
  { path: 'docs', component: DocsPageComponent, title: 'API documentation | Verity' },
  { path: 'playground', component: PlaygroundPageComponent, title: 'API playground | Verity' },
  { path: 'mini-app', component: TelegramMiniAppComponent, title: 'Telegram Mini App | Verity' },
  { path: '**', redirectTo: '' },
];
