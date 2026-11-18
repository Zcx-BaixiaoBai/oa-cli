// 通过真实浏览器完成 OA 登录（登录表单使用站点自身的加密逻辑），导出会话 Cookie。
// 账号密码从环境变量 OA_USER / OA_PASS 读取，不落盘。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { getOrigin } from './config.mjs';

const require = createRequire(import.meta.url);

function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    return require('playwright-core');
  }
}

export async function login({ user, pass, outFile, headless = true }) {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({
    headless,
    executablePath: process.env.CHROME_PATH || undefined
  });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();

    await page.goto(getOrigin() + '/wui/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input[type="text"], input[type="password"]', { timeout: 30000 });

    const inputs = page.locator('input[type="text"], input[type="password"]');
    await inputs.nth(0).fill(user);
    await inputs.nth(1).fill(pass);
    await page.locator('button, a').filter({ hasText: /登\s*录/ }).first().click();

    await page.waitForURL(/\/main\//, { timeout: 30000 });
    await page.waitForTimeout(1500);

    const state = await ctx.storageState();
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(state, null, 2));
    return state;
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const user = process.env.OA_USER;
  const pass = process.env.OA_PASS;
  const out = process.env.OA_SESSION || path.resolve('data/session.json');
  if (!user || !pass) {
    console.error('请先设置 OA_USER / OA_PASS 环境变量');
    process.exit(1);
  }
  const state = await login({ user, pass, outFile: out });
  console.log(`登录成功，Cookie 已写入 ${out}`);
  console.log('cookies:', state.cookies.map((c) => c.name).join(', '));
}