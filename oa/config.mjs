// 运行配置：目标 OA 地址从环境变量读取，不写死在代码里。
export function getOrigin() {
  const raw = process.env.OA_BASE;
  if (!raw) {
    throw new Error('请先设置环境变量 OA_BASE，例如：export OA_BASE=https://oa.example.com');
  }
  const u = new URL(raw);
  if (u.protocol !== 'https:') throw new Error('OA_BASE 必须是 https 地址');
  if (u.username || u.password) throw new Error('OA_BASE 不要包含账号密码');
  if (u.pathname !== '/' && u.pathname !== '') throw new Error('OA_BASE 只填站点根地址，不要带路径');
  return u.origin;
}

export function getHostname() {
  return new URL(getOrigin()).hostname;
}