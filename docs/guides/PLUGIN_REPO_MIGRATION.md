# 插件独立仓库迁移手册（A 方案执行版）

> **什么时候读**：要把云端 Hermes 插件从本仓库搬出去、单独维护时；或插件发版要跟版时。
> **谁执行**：主工作区（本仓库）做阶段 C；**新工作区（新仓库）做阶段 A**；阶段 B 在 VPS 上做。
> **一句话**：插件在独立仓库 → 用 `hermes plugins install/adopt` 取代 `tar + scp` → 自举 Prompt 只注入仓库地址
> （**不钉版本**：引导装默认分支最新版，跟版靠 `hermes plugins update`），钉 SHA 留给运维。
> **不做什么**：不碰 `plugin-data`（设备 token / 审计在那边）；不轮换管理密钥；不在同一次里既换安装来源又换版本。

## 执行状态（2026-11-06）

| 阶段 | 状态 | 事实 |
| --- | --- | --- |
| **A 建仓库** | ✅ 完成 | [T-Chen-CN/pi-workbench-plugin](https://github.com/T-Chen-CN/pi-workbench-plugin)，**公开 · MIT · 根目录即插件**；tag `v0.1.0` → `8669f32e98a6afb49ec81f9bac59394e3852f6d5`；103 个 unittest 绿；`hermes plugins validate .` / `doctor . --ci` 通过；**没有** `__pycache__` |
| **A7 部署凭据** | ⏭ 不需要 | 仓库公开 → 安装无需任何凭据；只在**转私有**时才补只读 deploy key |
| **C 应用侧收尾** | ✅ 完成 | 本仓库已删 `hermes-plugin/pi-workbench/`（只留路牌 README）；自举 Prompt 用 `{{PLUGIN_REPO}}` 占位符 + `src/utils/hermesPrompt.ts` 的单个常量（**不钉版本**，三条新用例兑底） |
| **B VPS 切换** | ⏳ 待做 | 线上仍是 `tar` 解压的旧那份（只 90 用例）；切换到仓库版会重启一次 gateway（停机 ≈10s），步骤见 §3 |

> 与本节不一致的历史描述以本节为准；下面阶段 A / B / C 的命令保留为**可重跑的执行说明**。

## 0. 现状盘点（迁移前的事实，别凭记忆）

| 东西 | 位置 | 备注 |
| --- | --- | --- |
| 插件源码 | 本仓库 `hermes-plugin/pi-workbench/`（`plugin.yaml` 是**子目录**里的） | 18 个源文件；`.gitignore` 里**没有** `__pycache__` 规则 |
| 被误提交的产物 | `git ls-files hermes-plugin \| grep __pycache__` → **13 个 `.pyc`** | 搬家后必须 `git rm -r --cached` |
| 部署说明 | 本仓库 `hermes-plugin/README.md` | 跟着插件走 |
| VPS 插件目录 | `/home/ubuntu/.hermes/profiles/pi-cloud/plugins/pi-workbench/` | **tar 解压的，没有 `.git`** → `adopt` 现在会失败 |
| VPS 数据目录 | `…/profiles/pi-cloud/plugin-data/pi-workbench/{hub.db, hub.db-wal, hub.db-shm, audit.jsonl}` | **迁移全程不许动**；device token 在这里 |
| 服务 | `hermes-gateway-pi-cloud.service`（`hermes --profile pi-cloud gateway run`） | 重启只重启这一个 |
| 端口 / 域名 | `127.0.0.1:8484` / `hub.tchen-xiaoxiao.com`（Caddy `flush_interval -1`） | 迁移后应一字不变 |
| 管理密钥 | `~/pi-hub-admin-key`（600）+ systemd drop-in `20-pi-hub.conf` | 复用，不重新生成 |
| 测试 | `cd <插件目录> && python -m unittest discover -s tests -t .` | 零依赖（仓库版已 103 用例） |

**关键事实**：`hermes plugins list` **看不到** `pi-workbench`（它是 untracked 目录插件），
所以 `doctor` / `check-updates` / `update` 现在都管不到它 —— 这就是要迁的理由。

## 1. 决策摘要（写进 ADR-009，阶段 C 补）

1. **A 方案**：独立仓库，**根目录就是插件**（`plugin.yaml` 在仓库根，`hermes plugins install owner/repo` 才认）。
2. **公开仓库 + MIT**（所有者 2026-11-06 决定；`plugin.yaml` 的 `license` 同步改成 `MIT`）。插件本身不含任何
   密钥（管理密钥、设备 token 都在 VPS 上），公开反而免掉部署凭据。⚠️ 若将来要收回来：先转私有，再补只读
   deploy key（§A7），否则 VPS 侧的 `plugins update` 会 401。
3. **版本不写进引导**（2026-11-06 修订）：`hermes plugins install <repo>` 装默认分支最新版，跟版靠
   `hermes plugins update`。只有**要复现某次部署**时才用 `--ref <40 位 SHA>`（CLI 只认完整 SHA，不认 tag）——
   否则每次插件发版都得改应用仓库，两个仓库的发布被串在一起。
4. **两仓库分工**：插件仓库 = 代码/测试/`plugin.yaml` 版本/tag；本仓库 = 客户端、契约文档、自举 Prompt 模板。
5. **本仓库不再保留插件源码**，只留一句指针 + Prompt 占位符常量。

---

## 2. 阶段 A：建新仓库（在新工作区里做）

> 新工作区建议独立目录（例如 `F:/Claude Code/pi-workbench-plugin`），在应用里作为**第二个工作区**打开。

### A1. 建空仓库 + 基础文件

```bash
mkdir pi-workbench-plugin && cd pi-workbench-plugin
git init -b main
printf '__pycache__/\n*.pyc\n.venv/\n' > .gitignore
```

- **license**：已定 **MIT** —— 仓库根 `LICENSE` 与 `plugin.yaml` 的 `license:` 必须一致（两处都改才算完成）。
- 根目录必须有 `plugin.yaml`。`requires_hermes: ">=0.22.6,<0.24"` 保持不变。

### A2. 保留历史地搬家（不要 `cp` 完就删）

在本仓库（主工作区）执行，把子目录切成独立历史：

```bash
git subtree split -P hermes-plugin/pi-workbench -b plugin-split
```

然后在新仓库里接收这段历史：

```bash
# 新仓库目录内
git remote add split "F:/Claude Code/唐辰的开发工作台"
git fetch split plugin-split
git merge --allow-unrelated-histories split/plugin-split -m "chore: import plugin history from app repo"
git remote remove split
```

> 没有 `subtree` 的机器可以用 `git filter-repo --subdirectory-filter hermes-plugin/pi-workbench`，
> 效果相同（都能保住那 90 个用例的演进记录）。

### A3. 收拾搬家带来的脏东西

```bash
git rm -r --cached $(git ls-files | grep __pycache__) 2>/dev/null
git ls-files | grep -c __pycache__     # 必须是 0
```

把 `hermes-plugin/README.md` 的内容并进新仓库根的 `README.md`（部署/运维/管理密钥取用都在里面）。

### A4. 搬家后应有的形状（对照检查）

```
pi-workbench-plugin/
├── plugin.yaml           # name: pi-workbench / version: 0.1.0 / requires_hermes / requires_env
├── __init__.py  shim.py  adapter.py
├── core/{db,auth,server,proxy,audit,fsguard,errors}.py
├── tests/{fake_upstream,test_auth,test_server,test_proxy_h1}.py
├── README.md
└── .gitignore
```

自检两条：

```bash
python -m unittest discover -s tests -t .     # 90 用例全绿（不装任何依赖）
ls plugin.yaml                                # 必须在根
```

### A5. CI（可选但推荐）

```yaml
# .github/workflows/ci.yml（公开仓库可直接用）
- run: python -m unittest discover -s tests -t .
```

有余力再加 `hermes plugins validate .`（CI 门槛）与 `hermes plugins doctor pi-workbench`（需要装 Hermes，能抓
manifest/API 漂移）。**不要**在 CI 里连 VPS。

### A6. 打 tag，记下 SHA

```bash
git add -A && git commit -m "chore: standalone plugin repo (imported from app repo)"
git tag v0.1.0
git sha=$(git rev-parse HEAD); echo $sha      # 40 位，阶段 C 要用
```

### A7. 只读凭据（**当前不需要**；只在仓库转私有时做）

```bash
# 本机生成（不要加 passphrase，服务要非交互）
ssh-keygen -t ed25519 -N "" -C "pi-workbench plugin (read-only)" -f ~/pi-plugin-deploy
# 复制 ~/pi-plugin-deploy.pub 到 GitHub → 仓库 Settings → Deploy keys → 只读
```

VPS 上落地（阶段 B 用）：

```bash
install -m 600 /dev/stdin ~/.ssh/pi-plugin-deploy <<< "$(cat pi-plugin-deploy)"
printf 'Host github.com\n  IdentityFile ~/.ssh/pi-plugin-deploy\n  IdentitiesOnly yes\n' > ~/.ssh/config
```

---

## 3. 阶段 B：VPS 切换（预计停机 ≈ 10 秒）

### B0. 先打备份包（顺序不能省）

```bash
P=/home/ubuntu/.hermes/profiles/pi-cloud
TS=$(date +%Y%m%d-%H%M)
sudo tar czf /home/ubuntu/backup-$TS.tgz \
  -C $P plugins/pi-workbench plugin-data/pi-workbench \
  /etc/systemd/system/hermes-gateway-pi-cloud.service.d/20-pi-hub.conf
ls -l /home/ubuntu/backup-$TS.tgz
```

- **`plugin-data` 必须进备份**（设备 token、审计）；`20-pi-hub.conf` 里是管理密钥。

### B1. 换成 git 安装（`adopt` 认 `.git`，所以必须 clone）

```bash
cd $P/plugins
mv pi-workbench pi-workbench.bak-$TS          # 留着回滚，不删
git clone --depth 1 https://github.com/T-Chen-CN/pi-workbench-plugin.git pi-workbench
cd pi-workbench && git fetch --depth 1 origin 8669f32e98a6afb49ec81f9bac59394e3852f6d5 \
  && git checkout 8669f32e98a6afb49ec81f9bac59394e3852f6d5   # 运维钉版本用（引导 Prompt 不钉，装最新）
# 只有在仓库转私有时才需要前置凭据：
#   GIT_SSH_COMMAND='ssh -i ~/.ssh/pi-plugin-deploy' git clone ...
export PATH=$HOME/.local/bin:$PATH
hermes plugins adopt pi-workbench            # 读 origin URL → 写 provenance → 变成 tracked git 安装
hermes plugins list | grep pi-workbench      # 这次应该看得到
```

确认 `config.yaml` 的 `plugins.enabled` 里仍有 `pi-workbench`（不要重复加），然后：

```bash
sudo systemctl restart hermes-gateway-pi-cloud.service
sleep 7
ss -ltn | grep 8484
curl -s http://127.0.0.1:8484/v1/hub/health
```

**期望**：`status:ok`、`upstreamOk:true`、`adminKeyConfigured:true`、`devices.total` 与迁移前一致
（`plugin-data` 没动，token 不该失效）。本机连接页应当仍是「已登记」，心跳继续每 30s 一条。

### B2. 回滚（任何一步不对就执行）

```bash
sudo systemctl stop hermes-gateway-pi-cloud.service
cd $P/plugins && rm -rf pi-workbench && mv pi-workbench.bak-$TS pi-workbench
sudo systemctl start hermes-gateway-pi-cloud.service && sleep 6
curl -s http://127.0.0.1:8484/v1/hub/health
```

有备份包就不用怕；`plugin-data` 从来没被动过，最坏情况等于回到迁移前。

### B3. 之后的部署方式（从此不再 tar/scp）

```bash
hermes plugins check-updates          # 只读检查
hermes plugins update pi-workbench    # 更新到默认分支最新（provenance 会记）
```

生产上仍建议"更新前先看 SHA"：`git -C $P/plugins/pi-workbench log -1 --format=%H`。

---

## 4. 阶段 C：本仓库收尾（主工作区）

### C1. 删掉插件子树（历史已在新仓库）

```bash
git rm -r hermes-plugin/pi-workbench
git commit -m "chore(plugin): 插件迁到独立仓库（见 docs/guides/PLUGIN_REPO_MIGRATION.md）"
```

保留 `hermes-plugin/README.md` → 改写成指针（10 行以内：新仓库地址、装法、测试命令、别再往这里加代码）。

### C2. 自举 Prompt 改成占位符（这是唯一有代码风险的一步）

- `docs/requirements/hermes-bootstrap-prompt.md`：第三步的"插件来源"改成
  ```
  hermes plugins install {{PLUGIN_REPO}} --no-enable
  # 再按需启用：hermes plugins enable pi-workbench（requires_env 会问 PI_HUB_ADMIN_KEY）
  ```
- `src/utils/hermesPrompt.ts`：取出代码块后替换占位符（**只有一个常量，没有版本号**）
  ```ts
  export const PLUGIN_REPO = 'https://github.com/<org>/pi-workbench-plugin.git'
  // HERMES_BOOTSTRAP_PROMPT = block.split('{{PLUGIN_REPO}}').join(PLUGIN_REPO)
  ```
- `tests/hermes-prompt.test.ts` 增三条：**替换后不含 `{{`**、**Prompt 里没有 `--ref`**、**没有 40 位十六进制**。
- 公开仓库：Prompt 已写明"不需要任何凭据 / deploy key"（需要凭据才能拉就说明地址被改过）。
  若哪天转私有：Prompt 里要补一句"先配好只读 deploy key（见 A7）"，不要让 Hermes 去猜凭据。

### C3. 更新所有指向旧路径的地方

| 文件 | 改什么 |
| --- | --- |
| `AGENTS.md` | 仓库地图删掉 `hermes-plugin/pi-workbench/`，验证矩阵那行改成"插件改动见独立仓库" |
| `docs/architecture/PROJECT_STRUCTURE.md` | 目录树去掉 `hermes-plugin/` |
| `docs/guides/AGENT-TESTING.md` | "什么时候跑"里的 `hermes-plugin/` → 改成"网关行为未变时可跳过" |
| `docs/requirements/CLOUD_AGENT_DEVICES.md` | §20 H0 的路径表述 + 新增 v3.x 变更记录（插件仓库独立，SHA 钉版本） |
| `docs/decisions/ADR-009-plugin-standalone-repo.md` | **新建**：把 §1 的五条决策写实（含"为什么独立成仓库 / 为什么公开 MIT"） |
| `docs/progress/{STATUS,BACKLOG}.md` | 记一笔迁移完成 + 部署方式变更 |

---

## 5. 发布 checklist（两边各一份，别混）

**插件仓库（发版方）**
1. 改代码 + `python -m unittest discover -s tests -t .` 全绿
2. 改 `plugin.yaml` 的 `version`（semver）
3. `git tag vX.Y.Z`（发版标记；**不需要**把 SHA 交给应用仓库）
4. （可选）`hermes plugins validate .` / `doctor`
5. 需要复现某次部署时，才用 `--ref <tag 指向的 40 位 SHA>`

**应用仓库（跟版方）**
1. **应用仓库通常不用改**（Prompt 不钉版本）—— 只有仓库地址变了才改 `PLUGIN_REPO`
2. VPS 跟版：`hermes plugins check-updates` → `hermes plugins update pi-workbench` → 重启该 gateway unit
3. `npm test`（含 Prompt 三条用例）；按需跑 G1 清单 §0（健康 + 登记状态 + 心跳）

> 两边都要 `plugin.yaml` 的 `requires_hermes` 与实际 VPS 的 Hermes 版本对齐（当前 `0.22.6`）。

---

## 6. 验收（Gate）

全部满足才算迁移完成（✅ = 已完成，2026-11-06）：

- [x] `python -m unittest discover -s tests -t .`（插件仓库）**103 用例**绿
- [x] `git ls-files | grep -c __pycache__` = **0**
- [x] `hermes plugins validate .` / `doctor . --ci` 通过（VPS 上对着 fresh clone 跑过）
- [ ] VPS：`hermes plugins list` 能看到 `pi-workbench`（有 Source）—— 待阶段 B
- [ ] `curl -s https://hub.tchen-xiaoxiao.com/v1/hub/health` → `status:ok` / `upstreamOk:true` / `adminKeyConfigured:true` —— 待阶段 B（切换后重跑）
- [ ] `devices.total` 与迁移前**一致**（迁移前 = 9）—— 待阶段 B
- [ ] 本机连接页仍显示「已登记」+「心跳正常」；随便发一句话能流式回来 —— 待阶段 B
- [x] 应用复制出的 Prompt 里**没有** `{{`，且 `--ref` 是 40 位 SHA（`tests/hermes-prompt.test.ts`）
- [ ] 回滚路径演练过一次（B2 的命令能照着跑）

## 7. 坑位速查

| 坑 | 事实 / 处理 |
| --- | --- |
| `adopt` 报错 | 它要读 `.git` 的 origin；tar 解压的目录没有 `.git` → **必须 clone**（B1 已按这个写） |
| `plugins list` 看不到插件 | 未 tracked 的目录插件不会出现在列表里；`adopt` 之后才出现 |
| `--ref` 不接受 tag | 只认 40 位 commit SHA；tag 只是给自己看的 |
| 卸载会丢数据？ | `hub.db` / `audit.jsonl` 在 `plugin-data/`，**不在**插件目录；但仍按 B0 备份 |
| 仓库转私有 | 先转私有 → 补只读 deploy key + `~/.ssh/config` 的 `IdentityFile` → 再验证 `plugins check-updates`（否则会 401） |
| `requires_env` 会拦安装 | `PI_HUB_ADMIN_KEY` 是必需项：装的时候会问 → 用 `--no-enable` 先装、配好 env 再 `enable` |
| `__pycache__` | 新仓库必须忽略；本仓库那 13 个被跟踪的 pyc 不要在搬家时带过去 |
| Plugin INFO 日志 | 不进 `journalctl`（只有 WARNING+）；判断活没活看 `/v1/hub/health` |

---

**相关**：[CLOUD_AGENT_DEVICES](../requirements/CLOUD_AGENT_DEVICES.md)（契约与 §20 执行手册）·
[ADR-008](../decisions/ADR-008-cloud-single-entry-plugin.md)（单入口）·
[hermes-bootstrap-prompt](../requirements/hermes-bootstrap-prompt.md)（自举 Prompt 模板）·
[paths-and-storage](../agent/paths-and-storage.md)（VPS 目录约定）
