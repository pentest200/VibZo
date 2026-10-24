import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

export async function accessible(page: Page, info: TestInfo, name: string) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
  // Store rules/targets, never private DOM, message bodies, URLs or account data.
  const summarize = (rows: typeof result.violations) => rows.map(row => ({ id: row.id, impact: row.impact, targets: row.nodes.map(node => node.target), checks: [...new Set(row.nodes.flatMap(node => [...node.any, ...node.all, ...node.none].map(check => check.id)))],
    contrast: row.nodes.flatMap(node => node.any.filter(check => check.id === 'color-contrast').map(check => ({
      foreground: /^#[a-f0-9]{6}$/i.test(String(check.data?.fgColor)) ? String(check.data.fgColor) : null,
      background: /^#[a-f0-9]{6}$/i.test(String(check.data?.bgColor)) ? String(check.data.bgColor) : null,
      ratio: typeof check.data?.contrastRatio === 'number' && Number.isFinite(check.data.contrastRatio) ? check.data.contrastRatio : null,
    }))) }));
  const summary = JSON.stringify({ engine: result.testEngine, violations: summarize(result.violations), incomplete: summarize(result.incomplete) });
  if (Buffer.byteLength(summary) > 262144) throw new Error('Accessibility summary exceeds bounded artifact size');
  await mkdir(info.outputDir, { recursive: true }); const path = info.outputPath(`a11y-${name}.json`);
  await writeFile(path, summary, { mode: 0o600, flag: 'wx' });
  await info.attach(`a11y-${name}`, { contentType: 'application/json', path });
  expect(result.violations.map(row => ({ rule: row.id, targets: row.nodes.map(node => node.target) })), `Accessibility violations on ${name}`).toEqual([]);
}
export async function reflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal page scrolling').toBe(true);
}
