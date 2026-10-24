import { useState } from 'react';
const paths = {
  menu: 'M4 6h16M4 12h16M4 18h16', search: 'm21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  back: 'm12 4-8 8 8 8M4 12h16', close: 'm6 6 12 12M6 18 18 6', plus: 'M12 4v16M4 12h16',
  edit: 'm15 5 4 4M4 20l5-1L21 7a2.8 2.8 0 0 0-4-4L5 15z',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  phone: 'M22 16.9v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7l.5 3a2 2 0 0 1-.6 1.7L7.7 9.7a16 16 0 0 0 6.6 6.6l1.3-1.3a2 2 0 0 1 1.7-.6l3 .5a2 2 0 0 1 1.7 2z',
  video: 'm16 8 6-4v16l-6-4M4 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2',
  more: 'M12 4v.01M12 12v.01M12 20v.01', info: 'M12 11v6M12 7v.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  attach: 'm21 11-9 9a6 6 0 0 1-8.5-8.5L13 2a4 4 0 0 1 5.7 5.7L8.2 18.2a2 2 0 0 1-2.8-2.8L15 6',
  send: 'm22 2-7 20-4-9-9-4 20-7ZM22 2 11 13',
  smile: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0M8 9h.01M16 9h.01M8 14s1.5 3 4 3 4-3 4-3',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8',
  shield: 'M12 22s9-4 9-11V4l-9-3-9 3v7c0 7 9 11 9 11m-4-10 3 3 5-5',
  check: 'm4 12 5 5L20 6', refresh: 'M20 7V2l-4 4M4 17v5l4-4M20 7a9 9 0 0 0-15-2M4 17a9 9 0 0 0 15 2',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2',
  pin: 'm16 3 5 5-4 2-3 6-6-6 6-3 2-4ZM8 16l-5 5M9 9l6 6',
  archive: 'M3 4h18v5H3zM5 9v11h14V9M10 13h4',
  doubleCheck: 'm2 12 4 4L16 5m-6 10 3 3L23 8',
  download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  expand: 'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5',
} as const;
export function Icon({ name, size = 24 }: { name: keyof typeof paths; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
const themeKey = 'commonroom:appearance:v1';
export function initializeTheme() {
  try { const saved = localStorage.getItem(themeKey); if (saved === 'dark' || saved === 'light') document.documentElement.dataset['theme'] = saved; } catch { /* Presentation remains usable when storage is denied. */ }
}
export function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.dataset['theme'] === 'dark');
  return <button type="button" className="theme-toggle" aria-label="Night mode" title="Night mode" aria-pressed={dark} onClick={() => { const next = !dark, value = next ? 'dark' : 'light'; setDark(next); document.documentElement.dataset['theme'] = value; try { localStorage.setItem(themeKey, value); } catch { /* Keep the selected theme for this page. */ } }}><Icon name="moon" /> Night mode <span className="toggle-track" aria-hidden="true"><span /></span></button>;
}
