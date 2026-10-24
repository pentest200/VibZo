import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { login, register, search } from './chat-fixture.js';
import { tinyGif, waveTone } from '../fixtures/media.js';
test('two browsers upload, scan, send and download private files, recover staged files and show rejection', async ({ page, browser, request }) => {
  const alice = await register(request, 'file_sender'), bob = await register(request, 'file_receiver'), context = await browser.newContext(), other = await context.newPage();
  const content = Buffer.from('Browser attachment bytes, scanned and sent.\n');
  try {
    await login(page, alice.email); await login(other, bob.email); await search(page, bob.username); await page.getByRole('button', { name: `Open conversation with ${bob.username}`, exact: true }).click();
    await page.getByRole('button', { name: 'Attach files', exact: true }).click(); await page.getByLabel('Attach a file', { exact: true }).setInputFiles({ name: 'browser-notes.txt', mimeType: 'text/plain', buffer: content });
    await expect(page.locator('.attachment-picker')).toContainText('Ready to send', { timeout: 45000 });
    await page.reload(); await page.getByRole('button', { name: 'Attach files', exact: true }).click(); await expect(page.getByRole('checkbox', { name: 'browser-notes.txt', exact: true })).toBeEnabled();
    await page.getByRole('checkbox', { name: 'browser-notes.txt', exact: true }).check();
    await page.getByRole('button', { name: 'Send message', exact: true }).click(); await expect(page.locator('.message-list')).toContainText('Download browser-notes.txt');
    await other.getByRole('button', { name: 'Refresh inbox' }).click(); await other.locator('.inbox-link').filter({ hasText: 'file_sender' }).click();
    const result = other.waitForEvent('download'); await other.getByRole('button', { name: 'Download browser-notes.txt', exact: true }).click(); const download = await result;
    expect(download.suggestedFilename()).toBe('browser-notes.txt'); expect(await readFile((await download.path())!)).toEqual(content);
    await page.getByRole('button', { name: 'Attach files', exact: true }).click(); await page.getByLabel('Attach a file', { exact: true }).setInputFiles({ name: 'active.txt', mimeType: 'text/plain', buffer: Buffer.from('<html>active content</html>') });
    await expect(page.locator('.attachment-picker')).toContainText('File rejected', { timeout: 30000 }); await expect(page.getByRole('checkbox', { name: 'active.txt', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Remove active.txt', exact: true }).click(); await expect(page.locator('.attachment-picker')).toContainText('Removing file');
    await page.screenshot({ path: '.cache/qa/attachments-desktop.png', fullPage: true }); await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByLabel('Attach a file', { exact: true })).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.cache/qa/attachments-mobile.png', fullPage: true });
  } finally { await context.close(); }
});

test('private images, GIFs, generated video and audio open and play inside the website on desktop and mobile', async ({ page, browser, request }) => {
  test.setTimeout(180000);
  const a = await register(request, 'mediasender'), b = await register(request, 'mediareceiver'), context = await browser.newContext(), other = await context.newPage();
  try {
    await login(page, a.email); await login(other, b.email); await search(page, b.username); await page.getByRole('button', { name: `Open conversation with ${b.username}`, exact: true }).click();
    const generated = await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 120; const drawing = canvas.getContext('2d')!; drawing.fillStyle = '#7969d2'; drawing.fillRect(0, 0, 160, 120);
      const png = Array.from(new Uint8Array(await (await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/png'))).arrayBuffer()));
      const video: { mime: string; bytes: number[]; name: string }[] = [];
      for (const mime of ['video/webm;codecs=vp8', 'video/mp4']) {
        if (!MediaRecorder.isTypeSupported(mime)) throw new Error(`Generated fixture recorder unavailable: ${mime}`);
        const stream = canvas.captureStream(10), recorder = new MediaRecorder(stream, { mimeType: mime }), chunks: Blob[] = [];
        recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
        const stopped = new Promise<void>(resolve => { recorder.onstop = () => resolve(); });
        recorder.start(); const timer = setInterval(() => { drawing.fillStyle = `hsl(${performance.now() % 360} 50% 50%)`; drawing.fillRect(0, 0, 160, 120); }, 50);
        await new Promise(resolve => setTimeout(resolve, 1100)); recorder.stop(); await stopped; clearInterval(timer); stream.getTracks().forEach(track => track.stop());
        video.push({ mime: mime.split(';')[0]!, name: mime.includes('mp4') ? 'clip.mp4' : 'clip.webm', bytes: Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer())) });
      }
      return { png, video };
    });
    const files = [{ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from(generated.png), published: 'photo.webp' }, { name: 'animation.gif', mimeType: 'image/gif', buffer: tinyGif, published: 'animation.gif' }, { name: 'tone.wav', mimeType: 'audio/wav', buffer: waveTone(2), published: 'tone.wav' }, ...generated.video.map(file => ({ name: file.name, mimeType: file.mime, buffer: Buffer.from(file.bytes), published: file.name }))];
    await page.getByRole('button', { name: 'Attach files', exact: true }).click();
    for (const file of files) { await page.getByLabel('Attach a file', { exact: true }).setInputFiles(file); await expect(page.getByRole('checkbox', { name: file.published, exact: true })).toBeEnabled({ timeout: 45000 }); await page.getByRole('checkbox', { name: file.published, exact: true }).check(); }
    await page.getByRole('button', { name: 'Send message', exact: true }).click(); await expect(page.getByRole('button', { name: 'Download photo.webp', exact: true })).toBeVisible();
    await other.getByRole('button', { name: 'Refresh inbox', exact: true }).click(); await other.locator('.inbox-link').filter({ hasText: 'mediasender' }).click();
    for (const width of [1280, 390]) {
      await other.setViewportSize({ width, height: 844 });
      for (const file of files) {
        const card = other.locator('.message-list .inline-media-card').filter({ has: other.getByRole('button', { name: `Download ${file.published}`, exact: true }) });
        await card.scrollIntoViewIfNeeded();
        expect(await other.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(await card.evaluate(node => { const bubble = node.closest('.message')!.getBoundingClientRect(), rect = node.getBoundingClientRect(); return rect.left >= bubble.left && rect.right <= bubble.right + 1; })).toBe(true);
        if (file.name === 'tone.wav' || file.name.startsWith('clip.')) {
          const inline = card.locator('audio,video'); await expect.poll(async () => inline.evaluate(node => (node as HTMLMediaElement).readyState)).toBeGreaterThanOrEqual(1);
          await inline.evaluate(node => (node as HTMLMediaElement).play()); await expect.poll(async () => inline.evaluate(node => (node as HTMLMediaElement).currentTime)).toBeGreaterThan(0.15); await inline.evaluate(node => (node as HTMLMediaElement).pause());
        } else await expect.poll(async () => card.locator('img').evaluate(node => (node as HTMLImageElement).complete && (node as HTMLImageElement).naturalWidth > 0)).toBe(true);
        await other.screenshot({ path: `.cache/qa/inline-${file.published.replace('.', '-')}-${width}.png` });
        await other.getByRole('button', { name: `${file.name === 'tone.wav' ? 'Listen to' : 'View'} ${file.published}`, exact: true }).click(); const dialog = other.getByRole('dialog', { name: file.published, exact: true }); await expect(dialog).toBeVisible();
        if (file.name === 'tone.wav' || file.name.startsWith('clip.')) {
          const media = dialog.locator('audio,video'); await expect.poll(async () => media.evaluate(node => (node as HTMLMediaElement).readyState)).toBeGreaterThanOrEqual(1);
          await media.evaluate(node => (node as HTMLMediaElement).play()); await expect.poll(async () => media.evaluate(node => (node as HTMLMediaElement).currentTime)).toBeGreaterThan(0.15); await media.evaluate(node => (node as HTMLMediaElement).pause());
        } else await expect.poll(async () => dialog.locator('img').evaluate(node => (node as HTMLImageElement).complete && (node as HTMLImageElement).naturalWidth > 0)).toBe(true);
        expect(await dialog.evaluate(node => { const box = node.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight; })).toBe(true);
        await other.screenshot({ path: `.cache/qa/media-${file.published.replace('.', '-')}-${width}.png` }); await other.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(other.locator('.media-stage audio,.media-stage video')).toHaveCount(0);
      }
    }
  } finally { await context.close(); }
});
