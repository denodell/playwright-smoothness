// Angular, bootstrapped in JIT mode (no Angular CLI). ZONE is replaced at build time:
// true loads Zone.js, which wraps every event listener, as most existing Angular apps do;
// false is zoneless change detection, the default for new apps since Angular 21.
import '@angular/compiler';
import { Component, provideZoneChangeDetection, provideZonelessChangeDetection, signal } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { busyWait } from './work.js';

declare const ZONE: boolean;

@Component({
  selector: 'app-root',
  standalone: true,
  template: `
    <main>
      <button id="checkout" (click)="onCheckout()"><span class="label">Checkout</span></button>
      <input id="search" aria-label="Search" (keydown)="onSearchKey()" />
      <p id="count">{{ count() }}</p>
    </main>
  `,
})
class AppComponent {
  count = signal(0);
  onCheckout() {
    busyWait(150);
    this.count.update((c) => c + 1);
  }
  onSearchKey() {
    busyWait(60);
  }
}

async function start() {
  if (ZONE) await import('zone.js');
  await bootstrapApplication(AppComponent, {
    providers: [ZONE ? provideZoneChangeDetection() : provideZonelessChangeDetection()],
  });
}
start();
