// 按流程类型取样：每个流程（workflowid）各拉一条完整样例（表单 + 流转轨迹 + 附件）。
// 用法：node oa/sample.mjs [--scopes done,view,doing] [--skip-files]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { OaClient } from './client.mjs';
import { listScope, syncRows, ensureSchema } from './sync.mjs';

function parseArgs(argv) {
  const out = { scopes: ['done', 'view', 'doing'], outDir: 'data', skipFiles: false, concurrency: 6 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scopes') out.scopes = argv[++i].split(',');
    else if (a === '--out') out.outDir = argv[++i];
    else if (a === '--skip-files') out.skipFiles = true;
    else if (a === '--concurrency') out.concurrency = Number(argv[++i]) || 6;
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv);
  const sessionFile = process.env.OA_SESSION || path.resolve('data/session.json');
  if (!fs.existsSync(sessionFile)) {
    console.error(`未找到会话文件 ${sessionFile}，请先执行 node oa/login.mjs`);
    process.exit(1);
  }
  const client = new OaClient(JSON.parse(fs.readFileSync(sessionFile, 'utf8')));

  fs.mkdirSync(args.outDir, { recursive: true });
  const db = new DatabaseSync(path.resolve(args.outDir, 'oa.db'));
  ensureSchema(db);

  const seen = new Map();
  for (const scope of args.scopes) {
    const { rows, total } = await listScope(client, scope);
    console.log(`[${scope}] ${total} 条`);
    for (const row of rows) {
      if (!row.workflowid) continue;
      if (!seen.has(row.workflowid)) seen.set(row.workflowid, row);
    }
  }

  const samples = [...seen.values()];
  console.log(`共 ${samples.length} 种流程类型，每种取 1 条样例`);
  for (const s of samples) console.log(`  ${s.workflowid}\t${s.workflow}\t${s.requestname}`);

  const result = await syncRows({ client, rows: samples, outDir: args.outDir, skipFiles: args.skipFiles, db, concurrency: args.concurrency });
  db.close();
  console.log('完成：', result);
}