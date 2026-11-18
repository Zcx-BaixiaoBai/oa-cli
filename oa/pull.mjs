// 按条件取流程：流程号 / 流程分类 / 流程类型 / 标题关键词 / 日期区间 / requestid，
// 取回表单 + 明细表 + 流转轨迹 + 附件原件。
// 用法：
//   node oa/pull.mjs --mark EC-GYSXZ-20251022-00018
//   node oa/pull.mjs --category 物业类
//   node oa/pull.mjs --type 用印申请 --limit 3
//   node oa/pull.mjs --keyword 石材 --from 2026-01-01 --to 2026-06-30
//   node oa/pull.mjs --requestid 3530023,3313456
//   node oa/pull.mjs --category 物业类 --dry-run
//   node oa/pull.mjs --list-categories
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { OaClient } from './client.mjs';
import { listScope, syncRows, ensureSchema } from './sync.mjs';

const SAFETY_CAP = 200; // 无 --limit 时的保护阈值，避免误拉全量

const BASE_INFO_PARAMS = {
  method: 'all', offical: '', officalType: '-1', hideNoDataTab: 'false',
  viewScope: 'done', complete: '2', date2during: '0', menuIds: '1,13', menuPathIds: '1,13',
  actiontype: 'baseinfo'
};

function parseArgs(argv) {
  const out = {
    outDir: 'data',
    scopes: ['doing', 'view', 'done'],
    limit: 0,
    dryRun: false,
    withFiles: true,
    type: '',
    category: '',
    mark: '',
    keyword: '',
    from: '',
    to: '',
    requestid: '',
    listCategories: false
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--type') out.type = argv[++i];
    else if (a === '--category') out.category = argv[++i];
    else if (a === '--mark') out.mark = argv[++i];
    else if (a === '--keyword') out.keyword = argv[++i];
    else if (a === '--from') out.from = argv[++i];
    else if (a === '--to') out.to = argv[++i];
    else if (a === '--requestid') out.requestid = argv[++i];
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--scopes') out.scopes = argv[++i].split(',');
    else if (a === '--out') out.outDir = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--no-files') out.withFiles = false;
    else if (a === '--list-categories') out.listCategories = true;
    else if (a === '--concurrency') out.concurrency = Number(argv[++i]) || 4;
  }
  return out;
}

// 流程分类树：分类名 → 该分类下所有流程(workflowid / 流程名)
async function fetchCategoryTree(client) {
  const res = await client.post('/api/workflow/reqlist/doneBaseInfo', BASE_INFO_PARAMS);
  const tree = (res?.treedata || []).map((node) => ({
    name: node.name || '',
    key: node.key || '',
    workflows: (node.childs || []).map((c) => ({ id: String(c.key), name: c.name || '' }))
  }));
  return tree;
}

// 分类树里的 id 是"当前版本"的 workflowid，历史记录可能挂在旧 id 上，
// 所以同时按流程名匹配，避免漏掉老版本的同类流程。
function resolveCategory(tree, keyword) {
  const k = keyword.toLowerCase();
  const hit = tree.filter((c) => c.name.toLowerCase().includes(k));
  const ids = new Set();
  const names = new Set();
  for (const c of hit) {
    for (const w of c.workflows) {
      ids.add(w.id);
      names.add(w.name);
    }
  }
  return { hit, ids, names };
}

function matches(row, args, category, typeNames) {
  if (args.requestid) return true;
  const wfid = String(row.workflowid || '');
  const wfname = String(row.workflow || '');
  if (category && !(category.ids.has(wfid) || category.names.has(wfname))) return false;
  if (typeNames && typeNames.size && !typeNames.has(wfname)) return false;
  if (args.mark) {
    const m = args.mark.toLowerCase();
    if (!String(row.requestmark || '').toLowerCase().includes(m)) return false;
  }
  if (args.keyword) {
    const k = args.keyword.toLowerCase();
    const hay = `${row.requestname || ''} ${row.requestmark || ''} ${row.workflow || ''}`.toLowerCase();
    if (!hay.includes(k)) return false;
  }
  if (args.from && String(row.createdate || '') < args.from) return false;
  if (args.to && String(row.createdate || '') > args.to) return false;
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv);

  const hasFilter = args.requestid || args.type || args.category || args.mark || args.keyword || args.from || args.to;
  if (!hasFilter && !args.listCategories) {
    console.error('至少要给一个筛选条件：--mark / --category / --type / --keyword / --from --to / --requestid');
    console.error('（不提供无条件的全量拉取，避免误操作）');
    process.exit(1);
  }

  const sessionFile = process.env.OA_SESSION || path.resolve(args.outDir, 'session.json');
  if (!fs.existsSync(sessionFile)) {
    console.error(`未找到会话文件 ${sessionFile}，请先执行 node oa/login.mjs`);
    process.exit(1);
  }
  const client = new OaClient(JSON.parse(fs.readFileSync(sessionFile, 'utf8')));

  let categoryIds = null;
  let categoryNames = null;
  let typeNames = null;
  let nameById = new Map();
  const needTree = args.category || args.type || args.listCategories;

  if (needTree) {
    const tree = await fetchCategoryTree(client);
    if (args.listCategories) {
      for (const c of tree) {
        console.log(`${c.name}（${c.workflows.length} 个流程）`);
        for (const w of c.workflows) console.log(`    ${w.id}\t${w.name}`);
      }
      process.exit(0);
    }
    for (const c of tree) for (const w of c.workflows) nameById.set(w.id, w.name);

    if (args.category) {
      const { hit, ids, names } = resolveCategory(tree, args.category);
      if (!hit.length) {
        console.error(`没找到流程分类：${args.category}`);
        console.error('可用分类：' + tree.map((c) => c.name).join(' / '));
        process.exit(1);
      }
      console.log(`流程分类 ${[...new Set(hit.map((c) => c.name))].join(' + ')}：${ids.size} 个流程类型`);
      categoryIds = ids;
      categoryNames = names;
    }

    if (args.type) {
      const t = args.type.toLowerCase();
      const hitNames = new Set();
      for (const name of nameById.values()) {
        if (name.toLowerCase().includes(t)) hitNames.add(name);
      }
      if (!hitNames.size) {
        console.error(`没找到流程类型：${args.type}（可用 --list-categories 查看）`);
        process.exit(1);
      }
      typeNames = hitNames;
    }
  }

  // 能下推到服务端的条件：流程编号、标题（这两项历史数据也准确）
  const serverFilters = {};
  if (args.mark) serverFilters.wfcode = args.mark;
  if (args.keyword) serverFilters.requestname = args.keyword;

  let rows;
  if (args.requestid) {
    rows = args.requestid.split(',').map((id) => ({ requestid: id.trim() }));
  } else {
    rows = [];
    for (const scope of args.scopes) {
      const { rows: batch } = await listScope(client, scope, 0, serverFilters);
      rows.push(...batch.filter((r) => matches(r, args, categoryIds ? { ids: categoryIds, names: categoryNames } : null, typeNames)));
      if (args.limit && rows.length >= args.limit) break;
    }
  }

  if (args.limit) rows = rows.slice(0, args.limit);

  // 列表里个别流程名只给了 id，用分类树补上（按需加载，避免多打一次接口）
  if (rows.some((r) => /^\d+$/.test(String(r.workflow || '')))) {
    if (!nameById.size) {
      const tree = await fetchCategoryTree(client);
      for (const c of tree) for (const w of c.workflows) nameById.set(w.id, w.name);
    }
    for (const r of rows) {
      if (/^\d+$/.test(String(r.workflow || '')) && nameById.has(String(r.workflow))) {
        r.workflow = nameById.get(String(r.workflow));
      }
    }
  }

  if (!rows.length) {
    console.log('没有匹配的流程');
    process.exit(0);
  }

  console.log(`匹配到 ${rows.length} 条：`);
  for (const r of rows.slice(0, 60)) {
    console.log(`  ${r.requestid}\t${r.createdate || ''}\t${r.requestmark || ''}\t${r.workflow || ''}\t${r.requestname || ''}`);
  }
  if (rows.length > 60) console.log(`  …另有 ${rows.length - 60} 条`);

  if (args.dryRun) {
    console.log('\n--dry-run：仅列出，未写入任何数据。去掉该参数即开始拉取。');
    process.exit(0);
  }

  if (rows.length > SAFETY_CAP && !args.limit) {
    console.error(`\n匹配数 ${rows.length} 超过 ${SAFETY_CAP} 条，请加 --limit N 或缩小条件。`);
    process.exit(1);
  }

  fs.mkdirSync(args.outDir, { recursive: true });
  const db = new DatabaseSync(path.resolve(args.outDir, 'oa.db'));
  ensureSchema(db);

  const result = await syncRows({
    client,
    rows: rows.map((r) => ({ ...r, scope: r.scope || '' })),
    outDir: args.outDir,
    skipFiles: !args.withFiles,
    db,
    concurrency: args.concurrency || 4
  });
  db.close();
  console.log('\n完成：', result);
}