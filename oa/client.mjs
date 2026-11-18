// OA HTTP 客户端：使用浏览器登录得到的 Cookie 访问站点内部接口。
// 目标站点由 OA_BASE 环境变量提供，请求只发往该站点，不跟随跨站跳转。
import { getOrigin, getHostname } from './config.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

export function cookieHeader(storageState) {
  const host = getHostname();
  return storageState.cookies
    .filter((c) => c.domain.replace(/^\./, '').endsWith(host))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

export class OaClient {
  constructor(storageState) {
    this.origin = getOrigin();
    this.cookie = cookieHeader(storageState);
  }

  async post(path, params = {}) {
    const body = new URLSearchParams(params).toString();
    const res = await fetch(this.origin + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        Cookie: this.cookie
      },
      body,
      redirect: 'manual'
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`POST ${path} -> ${res.status}: ${text.slice(0, 200)}`);
    }
    if (text.includes('登录信息超时') || text.includes('"errorCode":"002"')) {
      throw new Error('会话已失效，请重新执行 node oa/login.mjs');
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async getBinary(pathWithQuery) {
    const res = await fetch(this.origin + pathWithQuery, {
      headers: { 'User-Agent': UA, Cookie: this.cookie },
      redirect: 'follow'
    });
    if (!res.ok) throw new Error(`GET ${pathWithQuery} -> ${res.status}`);
    return {
      contentType: res.headers.get('content-type') || '',
      disposition: res.headers.get('content-disposition') || '',
      buffer: Buffer.from(await res.arrayBuffer())
    };
  }
}