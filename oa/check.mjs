// 数据完整性体检：比对表单元数据与实际落库内容，输出覆盖率报告。
// 用法：node oa/check.mjs [--out data]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const args = { outDir: 'data' };
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--out') args.outDir = process.argv[++i];
}

const db = new DatabaseSync(path.resolve(args.outDir, 'oa.db'));
const rawDir = path.resolve(args.outDir, 'raw');

const ids = db.prepare('select requestid, scope from workflow').all();
const pct = (a, b) => (b === 0 ? '—' : `${a}/${b} (${((a / b) * 100).toFixed(1)}%)`);

let mainPerfect = 0;
let mainFieldTotal = 0;
let mainFieldGot = 0;
let labeled = 0;
let labeledTotal = 0;
let deletedFlows = 0;
let detailTables = 0;
let detailExpected = 0;
let detailMissingIds = [];
const missingByFlow = [];

for (const { requestid } of ids) {
  let form;
  try {
    form = JSON.parse(fs.readFileSync(path.join(rawDir, `${requestid}.json`), 'utf8'));
  } catch {
    continue;
  }
  // 主表字段
  const meta = form.tableInfo?.main?.fieldinfomap || {};
  const maindata = form.maindata || {};
  if (Object.keys(maindata).length === 0) deletedFlows++;
  const metaKeys = Object.keys(meta).map((k) => `field${k}`).filter((k) => !['field-4', 'field-10'].includes(k));
  const missing = metaKeys.filter((k) => !(k in maindata));
  mainFieldTotal += metaKeys.length;
  mainFieldGot += metaKeys.length - missing.length;
  if (missing.length === 0) mainPerfect++;
  else missingByFlow.push({ requestid, missing: missing.length });

  // 字段中文名
  for (const k of Object.keys(maindata)) {
    if (k === 'field-3' || k === 'field-5') continue; // OA 内置标识字段，无中文名
    labeledTotal++;
    const fid = k.replace(/^field/, '');
    const hit = db.prepare('select 1 from field_label where fieldid = ? limit 1').get(fid);
    if (hit) labeled++;
  }

  // 明细表：用元数据里的 recordnum 预估应有行数
  for (const [mark, table] of Object.entries(form.tableInfo || {})) {
    if (!mark.startsWith('detail_')) continue;
    detailTables++;
    const expect = Number(table.recordnum || 0);
    detailExpected += expect;
    if (expect > 0) {
      const got = db.prepare('select count(*) c from detail_row where requestid = ? and detailmark = ?').get(requestid, mark).c;
      if (got === 0) detailMissingIds.push(`${requestid}/${mark}(应有${expect})`);
    }
  }
}

const attTotal = db.prepare('select count(*) c from attachment').get().c;
const attLocal = db.prepare('select count(*) c from attachment where local_path is not null').get().c;
const attExists = db
  .prepare('select local_path from attachment where local_path is not null')
  .all()
  .filter((r) => fs.existsSync(r.local_path)).length;
const withNodes = db.prepare('select count(distinct requestid) c from approval_node').get().c;
const detailRows = db.prepare('select count(*) c from detail_row').get().c;

console.log('== OA 数据完整性体检 ==');
console.log('流程记录数:', ids.length);
console.log('主表字段完整率:', pct(mainFieldGot, mainFieldTotal), '| 无缺字段的流程:', pct(mainPerfect, ids.length));
if (missingByFlow.length) {
  console.log('  有缺字段的流程:', missingByFlow.length, missingByFlow.slice(0, 5));
}
console.log('字段中文名覆盖:', pct(labeled, labeledTotal));
console.log('明细表(表数):', detailTables, '| 元数据预估行数:', detailExpected, '| 实际落库行数:', detailRows);
console.log('  有数据但未取到的明细表:', detailMissingIds.length ? detailMissingIds.slice(0, 8) : '无');
console.log('附件登记:', attTotal, '| 本地文件存在:', attExists, '| 未下载:', attTotal - attLocal);
console.log('有流转轨迹的流程:', pct(withNodes, ids.length));
if (deletedFlows) console.log(`  说明：其中 ${deletedFlows} 条是已被删除的历史流程（OA 侧 loadForm 返回空表单、详情页提示"该流程已经被删除"）`);
console.log('可访问流程的轨迹覆盖:', pct(withNodes, ids.length - deletedFlows));
db.close();