# oa-cli

泛微 e-cology 9（E9）OA 流程数据抓取命令行工具：登录后按条件拉取流程列表、表单字段、明细表、流转轨迹与附件原件，落到本地 SQLite + 文件目录，便于做数据分析或喂给其他工具。

只做读取，不提交、不审批、不修改任何流程。

## 能做什么

- **按条件取**：流程号、流程分类、流程类型、标题关键词、创建日期区间、指定 requestid
- **取全一套**：主表字段（带中文名）、明细表行数据、流转轨迹（节点/处理人/耗时）、附件原件
- **落库**：SQLite 四张表 + 原始 JSON + 按流程分目录存放的附件
- **体检**：把落库数据和表单元数据（字段数、明细行数）逐条比对，报告覆盖率

## 环境要求

- Node.js ≥ 22.5（用到内置 `node:sqlite`）
- Playwright + Chromium（登录表单前端有站点自研的 RSA 加密，用真浏览器跑一遍最省事）

```bash
npm install
npx playwright install chromium
```

## 配置

全部通过环境变量，不写配置文件，不落密码：

```bash
export OA_BASE="https://oa.example.com"   # 必填，站点根地址（https）
export OA_USER="your-account"             # 登录名
export OA_PASS="your-password"            # 密码
export CHROME_PATH="/path/to/chrome"      # 可选，Playwright 自带 chromium 时不用填
```

`OA_BASE` 只接受 https 站点根地址，带路径、带账号密码或非 https 都会直接报错。

## 用法

```bash
# 登录，把会话 Cookie 写到 data/session.json
node oa/login.mjs

# 按流程号取（服务端过滤，秒级）
node oa/pull.mjs --mark EC-XXX-20260101-00001

# 按流程分类取
node oa/pull.mjs --list-categories            # 先看有哪些分类
node oa/pull.mjs --category 行政类流程 --limit 5

# 按流程类型取（模糊匹配流程名）
node oa/pull.mjs --type 用印申请

# 标题关键词 + 日期区间
node oa/pull.mjs --keyword 合同 --from 2026-01-01 --to 2026-06-30 --limit 10

# 指定 requestid
node oa/pull.mjs --requestid 1234567,1234568

# 只看命中哪些，不落库
node oa/pull.mjs --type 请款 --dry-run

# 按范围取（待办 / 待阅 / 已办）
node oa/sync.mjs --scope doing
node oa/sync.mjs --scope view --limit 50
node oa/sync.mjs --scope done

# 每种流程类型各取一条
node oa/sample.mjs --concurrency 8

# 完整性体检
node oa/check.mjs

# 补数据
node oa/sync.mjs --all-in-db --skip-files   # 库里流程全部重跑
node oa/sync.mjs --missing-files            # 只补下载失败的附件
```

## 输出结构

```
data/
  session.json              会话 Cookie（含 JSESSIONID，别外传）
  oa.db                     SQLite：workflow / attachment / approval_node / detail_row / field_label
  raw/<requestid>.json      loadForm 原始返回
  raw/<requestid>.detail.json   明细表原始返回
  attachments/<requestid>/  附件原件
```

## 接口链路

以 e-cology 9 的 `/api/workflow` 系列接口为主，均需登录后的 Cookie：

| 用途 | 接口 |
| --- | --- |
| 列表会话 | `POST /api/workflow/reqlist/splitPageKey` |
| 总数 / 分页数据 | `POST /api/ec/dev/table/counts`、`POST /api/ec/dev/table/datas` |
| 表单字段 | `POST /api/workflow/reqform/loadForm` |
| 明细表行数据 | `POST /api/workflow/reqform/detailData` |
| 流转轨迹 | `POST /api/workflow/reqform/wfstatusnew` |
| 附件下载 | `GET /weaver/weaver.file.FileDownload?...`（用表单返回的 loadlink 原样请求） |

## 踩过的坑

1. **登录不能纯 HTTP 复现**：登录表单用站点自研 RSA 加密（`GetRsaInfo` 取公钥 + code，拼接后加密），手工拼请求容易被判成密码错误。用 Playwright 跑真浏览器登录最稳。
2. **明细表不在 loadForm 里**：`loadForm` 只返回明细表结构（`tableInfo.detail_N.recordnum`），行数据要单独请求 `detailData`。
3. **`reqParams.apiResultCacheKey` 必须原样透传**：要用 `loadForm` 返回的 `params.apiResultCacheKey`，改成 `Date.now()` 或空值一律 500；`reqParams` 也不能多塞字段。
4. **分类树里的 id 是当前版本的 workflowid**：历史流程常挂在旧 id 上，按分类过滤必须同时按流程名匹配，否则会漏。
5. **列表接口支持服务端筛选**：`wfcode`（流程编号）、`requestname`（标题）可以直接下推，比拉全量再过滤快两个数量级；`createdateselect` 是枚举值，传日期无效，所以日期过滤放在本地。
6. **流转轨迹拿不到意见正文**：`getRequestLogList` 需要页面先调 `updateReqInfo` 建立上下文，纯接口调用返回空。本工具记录的是节点、处理人、到达/处理时间。

## 已知限制

- 会话 Cookie 有有效期，过期后重跑 `node oa/login.mjs`；脚本会提示“会话已失效”。
- 已删除的历史流程（详情页提示“该流程已经被删除”）返回空表单，属于源系统状态，不是抓取失败。
- 附件与原样表单会占不少磁盘，几百条流程大约几百 MB 到数 GB。

## 合规提示

本工具用于访问**你自己有权限访问**的 OA 系统。使用前请确认符合所在单位的系统使用与数据管理规定；抓取到的数据可能含个人信息与商业机密，请自行做好存储与访问控制，不要公开传播。

## License

MIT