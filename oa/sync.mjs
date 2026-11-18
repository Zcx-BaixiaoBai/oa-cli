// 从 OA 拉取流程列表、表单字段与附件，落库到 SQLite 并保存附件原文件。
// 用法：node oa/sync.mjs --scope done --limit 20
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { OaClient } from './client.mjs';

const SCOPES = {
  doing: { viewScope: 'doing', complete: '0', viewcondition: '5', label: '待办' },
  view: { viewScope: 'doing', complete: '0', viewcondition: '6', label: '待阅' },
  done: { viewScope: 'done', complete: '2', viewcondition: '11', label: '已办' }
};

const LIST_BASE = {
  method: 'all',
  offical: '',
  officalType: '-1',
  hideNoDataTab: 'false',
  date2during: '0',
  defaultTabVal: '-1',
  loadDefTab: 'true',
  menuIds: '1,13',
  menuPathIds: '1,13'
};

function parseArgs(argv) {
  const out = { scope: 'done', limit: 0, outDir: 'data', skipFiles: false, concurrency: 6, requestid: '', allInDb: false, missingFiles: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scope') out.scope = argv[++i];
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--out') out.outDir = argv[++i];
    else if (a === '--skip-files') out.skipFiles = true;
    else if (a === '--concurrency') out.concurrency = Number(argv[++i]) || 6;
    else if (a === '--requestid') out.requestid = argv[++i];
    else if (a === '--all-in-db') out.allInDb = true;
    else if (a === '--missing-files') out.missingFiles = true;
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openList(client, scopeCfg, filters = {}) {
  const params = {
    ...LIST_BASE,
    viewScope: scopeCfg.viewScope,
    complete: scopeCfg.complete,
    viewcondition: scopeCfg.viewcondition,
    actiontype: 'splitpage'
  };
  // 只透传 OA 列表页认可的筛选键，避免脏参数影响结果
  for (const k of ['wfcode', 'requestname', 'workflowid', 'createrid', 'requestlevel']) {
    if (filters[k]) params[k] = filters[k];
  }
  const res = await client.post('/api/workflow/reqlist/splitPageKey', params);
  if (!res.sessionkey) throw new Error('splitPageKey 未返回 sessionkey');
  return res.sessionkey;
}

async function listCount(client, dataKey) {
  const res = await client.post('/api/ec/dev/table/counts', { dataKey });
  return Number(res.count || 0);
}

async function listPage(client, dataKey, current) {
  const res = await client.post('/api/ec/dev/table/datas', {
    dataKey,
    current: String(current),
    sortParams: '[]'
  });
  return res.datas || [];
}

export async function listScope(client, scope, limit = 0, filters = {}) {
  const cfg = SCOPES[scope];
  if (!cfg) throw new Error(`未知 scope: ${scope}`);
  // 服务端支持的筛选：wfcode(流程编号) / requestname(标题) / workflowid(流程类型)
  const dataKey = await openList(client, cfg, filters);
  const total = await listCount(client, dataKey);
  const pageSize = 50;
  const pages = Math.ceil(total / pageSize);
  const rows = [];
  for (let p = 1; p <= pages; p++) {
    const batch = await listPage(client, dataKey, p);
    if (!batch.length) break;
    for (const r of batch) {
      rows.push({
        requestid: r.requestid,
        requestname: r.requestname,
        requestmark: r.requestmark,
        workflowid: r.workflowid,
        workflow: r.workflowidspan,
        status: r.status,
        creater: r.creater,
        createdate: r.createdate,
        operatedate: r.operatedateNew,
        currentnode: r.currentnodeidspan,
        scope: cfg.label
      });
      if (limit && rows.length >= limit) return { rows, total };
    }
    await sleep(200);
  }
  return { rows, total };
}

export function extractAttachments(form) {
  const main = form?.maindata || {};
  const items = [];
  for (const [field, val] of Object.entries(main)) {
    const filedatas = val?.specialobj?.filedatas;
    if (Array.isArray(filedatas)) {
      for (const f of filedatas) {
        items.push({
          field,
          filename: f.filename,
          filesize: f.filesize,
          ext: f.fileExtendName,
          fileid: f.fileid,
          loadlink: f.loadlink,
          uploaddate: f.uploaddate,
          uploader: f.username
        });
      }
    }
  }
  // 审批意见里的附件
  for (const log of form?.loglist || []) {
    for (const f of log.speechAttachmetnDatas || []) {
      items.push({
        field: `log_${log.logid}`,
        filename: f.filename,
        filesize: f.filesize,
        ext: f.fileExtendName,
        fileid: f.fileid,
        loadlink: f.loadlink,
        uploaddate: log.log_operatedate,
        uploader: log.displayname
      });
    }
  }
  return items;
}

function safeName(name) {
  return String(name || 'unnamed').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 180);
}

export function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow (
      requestid   TEXT PRIMARY KEY,
      requestname TEXT,
      requestmark TEXT,
      workflowid  TEXT,
      workflow    TEXT,
      scope       TEXT,
      status      TEXT,
      creater     TEXT,
      createdate  TEXT,
      operatedate TEXT,
      currentnode TEXT,
      raw_json    TEXT,
      synced_at   TEXT
    );
    CREATE TABLE IF NOT EXISTS attachment (
      requestid  TEXT,
      field      TEXT,
      filename   TEXT,
      ext        TEXT,
      filesize   TEXT,
      fileid     TEXT,
      uploaddate TEXT,
      uploader   TEXT,
      local_path TEXT,
      sha256     TEXT,
      fetched_at TEXT,
      PRIMARY KEY (requestid, field, filename)
    );
    CREATE TABLE IF NOT EXISTS request_log (
      requestid TEXT,
      logid     TEXT,
      nodename  TEXT,
      operator  TEXT,
      operatedate TEXT,
      operatetime TEXT,
      remark_html TEXT,
      PRIMARY KEY (requestid, logid)
    );
    CREATE TABLE IF NOT EXISTS approval_node (
      requestid  TEXT,
      nodeid     TEXT,
      nodename   TEXT,
      operator   TEXT,
      receivedate TEXT,
      operatedate TEXT,
      intervel   TEXT,
      statuscode TEXT,
      PRIMARY KEY (requestid, nodeid, operator, operatedate)
    );
    CREATE TABLE IF NOT EXISTS detail_row (
      requestid  TEXT,
      detailmark TEXT,
      row_key    TEXT,
      keyid      TEXT,
      data_json  TEXT,
      PRIMARY KEY (requestid, detailmark, row_key)
    );
    CREATE TABLE IF NOT EXISTS field_label (
      formid      TEXT,
      fieldid     TEXT,
      detailmark  TEXT,
      fieldlabel  TEXT,
      fieldname   TEXT,
      fielddbtype TEXT,
      PRIMARY KEY (formid, fieldid, detailmark)
    );
  `);
}

export async function sync({ client, scope, limit, outDir, skipFiles, db, concurrency = 6 }) {
  const { rows, total } = await listScope(client, scope, limit);
  console.log(`[${scope}] 共 ${total} 条，本次处理 ${rows.length} 条`);
  const r = await syncRows({ client, rows, outDir, skipFiles, db, concurrency });
  return { total, processed: r.processed, files: r.files };
}

// 明细表接口需要的参数白名单（多传字段会导致服务端 500）
const DETAIL_KEYS = ['requestid', 'workflowid', 'nodeid', 'formid', 'isbill',
  'f_weaver_belongto_userid', 'f_weaver_belongto_usertype', 'authStr', 'authSignatureStr',
  'signatureSecretKey', 'signatureAttributesStr', 'nodetype', 'isviewonly', 'isaffirmance',
  'isshared', 'iswfshare', 'ismode', 'modeid', 'creater', 'needconfirm', 'creatertype',
  'requestType', 'isSelfAuth', 'isprint', 'wfmonitor', 'isurger', 'intervenorright',
  'selectNextFlow', 'agentType', 'agentorByAgentId', 'layouttype'];
const DETAIL_NUM = new Set(['requestid', 'workflowid', 'nodeid', 'formid', 'ismode', 'modeid',
  'creater', 'creatertype', 'requestType', 'isSelfAuth', 'intervenorright', 'agentType',
  'agentorByAgentId', 'layouttype']);
const DETAIL_BOOL = new Set(['wfmonitor', 'isurger']);

function buildDetailReqParams(params, requestid) {
  const out = {};
  for (const k of DETAIL_KEYS) {
    const raw = k === 'requestid' ? requestid : params[k];
    if (DETAIL_NUM.has(k)) out[k] = raw === undefined || raw === '' ? 0 : Number(raw);
    else if (DETAIL_BOOL.has(k)) out[k] = String(raw).toLowerCase() === 'true';
    else out[k] = raw === undefined || raw === null ? '' : String(raw);
  }
  // 该键必须与 loadForm 返回的时间戳一致，否则服务端 500
  out.apiResultCacheKey = params.apiResultCacheKey !== undefined && params.apiResultCacheKey !== ''
    ? Number(params.apiResultCacheKey)
    : Date.now();
  return out;
}

// 取明细表行数据；某张表不可读时退回逐表请求
async function fetchDetailRows(client, requestid, form) {
  const marks = Object.keys(form?.tableInfo || {}).filter((k) => k.startsWith('detail_'));
  if (!marks.length) return null;
  const p = form.params || {};
  const reqParams = buildDetailReqParams(p, requestid);
  const payload = (list) => ({
    requestid,
    timestamp: String(Date.now()),
    detailmark: list.join(','),
    wfTestStr: '',
    f_weaver_belongto_userid: p.f_weaver_belongto_userid,
    f_weaver_belongto_usertype: p.f_weaver_belongto_usertype,
    reqParams: JSON.stringify(reqParams)
  });
  try {
    return await client.post('/api/workflow/reqform/detailData', payload(marks));
  } catch (e) {
    console.warn(`  明细表批量请求失败 ${requestid}: ${e.message.slice(0, 80)}`);
    const out = {};
    for (const m of marks) {
      try {
        const one = await client.post('/api/workflow/reqform/detailData', payload([m]));
        if (one && typeof one === 'object') Object.assign(out, one);
      } catch (e2) {
        console.warn(`  明细表 ${m} 不可读: ${e2.message.slice(0, 60)}`);
      }
    }
    return out;
  }
}

// 对给定的流程行执行：取表单 → 流转轨迹 → 附件下载 → 入库
export async function syncRows({ client, rows, outDir, skipFiles, db, concurrency = 6 }) {

  const attachRoot = path.resolve(outDir, 'attachments');
  const rawRoot = path.resolve(outDir, 'raw');
  fs.mkdirSync(attachRoot, { recursive: true });
  fs.mkdirSync(rawRoot, { recursive: true });

  const upsertWf = db.prepare(`
    INSERT INTO workflow (requestid, requestname, requestmark, workflowid, workflow, scope, status,
      creater, createdate, operatedate, currentnode, raw_json, synced_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(requestid) DO UPDATE SET
      requestname=excluded.requestname, requestmark=excluded.requestmark,
      status=excluded.status, operatedate=excluded.operatedate,
      currentnode=excluded.currentnode, raw_json=excluded.raw_json, synced_at=excluded.synced_at
  `);
  const insAtt = db.prepare(`
    INSERT INTO attachment (requestid, field, filename, ext, filesize, fileid, uploaddate, uploader,
      local_path, sha256, fetched_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(requestid, field, filename) DO UPDATE SET
      local_path=COALESCE(excluded.local_path, attachment.local_path),
      sha256=COALESCE(excluded.sha256, attachment.sha256),
      fetched_at=excluded.fetched_at
  `);
  const insLog = db.prepare(`
    INSERT INTO request_log (requestid, logid, nodename, operator, operatedate, operatetime, remark_html)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(requestid, logid) DO UPDATE SET
      remark_html=excluded.remark_html, operatedate=excluded.operatedate
  `);
  const insNode = db.prepare(`
    INSERT INTO approval_node (requestid, nodeid, nodename, operator, receivedate, operatedate, intervel, statuscode)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(requestid, nodeid, operator, operatedate) DO UPDATE SET
      nodename=excluded.nodename, intervel=excluded.intervel, statuscode=excluded.statuscode
  `);
  const insDetail = db.prepare(`
    INSERT INTO detail_row (requestid, detailmark, row_key, keyid, data_json)
    VALUES (?,?,?,?,?)
    ON CONFLICT(requestid, detailmark, row_key) DO UPDATE SET
      keyid=excluded.keyid, data_json=excluded.data_json
  `);
  const insLabel = db.prepare(`
    INSERT INTO field_label (formid, fieldid, detailmark, fieldlabel, fieldname, fielddbtype)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(formid, fieldid, detailmark) DO UPDATE SET
      fieldlabel=excluded.fieldlabel, fieldname=excluded.fieldname, fielddbtype=excluded.fielddbtype
  `);

  let fileCount = 0;
  let done = 0;
  const queue = [...rows];

  const processRow = async (row) => {
    const form = await client.post('/api/workflow/reqform/loadForm', {
      requestid: row.requestid,
      timestamp: String(Date.now())
    });

    fs.writeFileSync(path.join(rawRoot, `${row.requestid}.json`), JSON.stringify(form, null, 2));
    const s = (v) => (v === undefined || v === null ? '' : String(v));
    upsertWf.run(
      s(row.requestid), s(row.requestname), s(row.requestmark), s(row.workflowid), s(row.workflow),
      s(row.scope), s(row.status), s(row.creater), s(row.createdate), s(row.operatedate),
      s(row.currentnode), JSON.stringify(form), new Date().toISOString()
    );

    for (const log of form?.loglist || []) {
      insLog.run(
        row.requestid, String(log.logid || ''), log.log_nodename || '', log.displayname || '',
        log.log_operatedate || '', log.log_operatetime || '', log.log_remarkHtml || ''
      );
    }

    // 字段中文名（主表 + 各明细表）
    const formid = s(form?.params?.formid);
    const mainFi = form?.tableInfo?.main?.fieldinfomap || {};
    for (const [fid, meta] of Object.entries(mainFi)) {
      insLabel.run(formid, String(meta.fieldid ?? fid), '', meta.fieldlabel || '', meta.fieldname || '', meta.fielddbtype || '');
    }
    for (const [mark, table] of Object.entries(form?.tableInfo || {})) {
      if (!mark.startsWith('detail_') || !table?.fieldinfomap) continue;
      for (const [fid, meta] of Object.entries(table.fieldinfomap)) {
        insLabel.run(formid, String(meta.fieldid ?? fid), mark, meta.fieldlabel || '', meta.fieldname || '', meta.fielddbtype || '');
      }
    }

    // 明细表行数据（loadForm 只返回结构，行数据在 detailData 接口）
    const detailRes = await fetchDetailRows(client, row.requestid, form);
    if (detailRes && Object.keys(detailRes).length) {
      fs.writeFileSync(path.join(rawRoot, `${row.requestid}.detail.json`), JSON.stringify(detailRes, null, 2));
      for (const [mark, table] of Object.entries(detailRes)) {
        for (const [rowKey, data] of Object.entries(table?.rowDatas || {})) {
          insDetail.run(row.requestid, mark, rowKey, s(data.keyid), JSON.stringify(data));
        }
      }
    }

    // 流转轨迹（各节点处理人、到达/处理时间）
    try {
      const p = form?.params || {};
      const st = await client.post('/api/workflow/reqform/wfstatusnew', {
        requestid: row.requestid,
        isFromWfForm: '1',
        requestType: p.requestType || '0',
        workflowid: p.workflowid || row.workflowid,
        nodeid: p.nodeid || ''
      });
      for (const node of Object.values(st?.datas || {})) {
        for (const item of node.list || []) {
          insNode.run(
            row.requestid, String(node.nodeid || ''), node.nodename || '', item.operator || '',
            item.receivedate || '', item.operatedate || '', item.intervel || '', item.statuscode || ''
          );
        }
      }
    } catch (e) {
      console.warn(`  流转轨迹获取失败 ${row.requestid}: ${e.message}`);
    }

    const attachments = extractAttachments(form);
    if (attachments.length) {
      const dir = path.join(attachRoot, row.requestid);
      fs.mkdirSync(dir, { recursive: true });
      for (const a of attachments) {
        let localPath = null;
        let sha256 = null;
        if (!skipFiles && a.loadlink) {
          for (let attempt = 1; attempt <= 3 && !localPath; attempt++) {
            try {
              const bin = await client.getBinary(a.loadlink);
              localPath = path.join(dir, safeName(a.filename));
              fs.writeFileSync(localPath, bin.buffer);
              const { createHash } = await import('node:crypto');
              sha256 = createHash('sha256').update(bin.buffer).digest('hex');
              fileCount++;
              await sleep(50);
            } catch (e) {
              if (attempt === 3) console.warn(`  附件下载失败 ${row.requestid} ${a.filename}: ${e.message}`);
              else await sleep(800 * attempt);
            }
          }
        }
        insAtt.run(
          row.requestid, a.field, a.filename, a.ext, a.filesize, a.fileid, a.uploaddate, a.uploader,
          localPath, sha256, new Date().toISOString()
        );
      }
    }
    done++;
    if (done % 10 === 0 || done === rows.length) {
      console.log(`  进度 ${done}/${rows.length}，附件 ${fileCount} 个`);
    }
  };

  // 固定并发度的工作池，避免串行等待拖慢整体速度
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (queue.length) {
      const row = queue.shift();
      try {
        await processRow(row);
      } catch (e) {
        console.warn(`  处理失败 ${row.requestid}: ${e.message}`);
      }
    }
  });
  await Promise.all(workers);

  return { processed: rows.length, files: fileCount };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv);
  const sessionFile = process.env.OA_SESSION || path.resolve('data/session.json');
  if (!fs.existsSync(sessionFile)) {
    console.error(`未找到会话文件 ${sessionFile}，请先执行 node oa/login.mjs`);
    process.exit(1);
  }
  const state = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  const client = new OaClient(state);

  fs.mkdirSync(args.outDir, { recursive: true });
  const db = new DatabaseSync(path.resolve(args.outDir, 'oa.db'));
  ensureSchema(db);

  let pickedRows = null;
  if (args.requestid) {
    pickedRows = args.requestid.split(',').map((id) => ({ requestid: id.trim() }));
  } else if (args.allInDb) {
    pickedRows = db.prepare(`select requestid, requestname, requestmark, workflowid, workflow, scope,
      status, creater, createdate, operatedate, currentnode from workflow`).all();
  } else if (args.missingFiles) {
    pickedRows = db.prepare(`select distinct w.requestid, w.requestname, w.requestmark, w.workflowid,
      w.workflow, w.scope, w.status, w.creater, w.createdate, w.operatedate, w.currentnode
      from workflow w join attachment a on a.requestid = w.requestid where a.local_path is null`).all();
  }

  const result = pickedRows
    ? await syncRows({
        client,
        rows: pickedRows,
        outDir: args.outDir,
        skipFiles: args.skipFiles,
        db,
        concurrency: args.concurrency
      })
    : await sync({ client, ...args, db });
  db.close();
  console.log('完成：', result);
}