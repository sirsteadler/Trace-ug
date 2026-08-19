'use client';

import { useEffect } from 'react';

export function RegisterSW(): null {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    // Registration failure is not fatal: the app works online without it.
    void navigator.serviceWorker.register('/sw.js').catch(() => {});
  }, []);
  return null;
}
