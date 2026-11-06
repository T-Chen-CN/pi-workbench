# hermes-plugin/ —— 已迁出，这里是路牌

云端网关插件**不再存放在本仓库**。它有自己的仓库：

| 项 | 值 |
| --- | --- |
| 仓库 | <https://github.com/T-Chen-CN/pi-workbench-plugin>（公开，MIT） |
| 形状 | **仓库根目录就是插件本体**（`plugin.yaml` 在根，`hermes plugins install` 只认这种形状） |
| 版本 | 引导装默认分支最新版；tag `v0.1.0` = `8669f32…` 只用于「复现某次部署」时 `--ref`（CLI 只认 40 位 SHA） |
| 测试 | `python -m unittest discover -s tests -t .`（纯 stdlib，零依赖） |

安装（在 VPS 的 profile 里，`HERMES_HOME` 指向 profile 而不是 `~/.hermes`）：

```bash
hermes plugins install https://github.com/T-Chen-CN/pi-workbench-plugin.git \
  --ref 8669f32e98a6afb49ec81f9bac59394e3852f6d5 --no-enable
hermes plugins adopt pi-workbench          # 过渡期：目录还在时的收编路径
hermes plugins check-updates / update      # 之后走这个，不再 tar + scp
```

**不要再往这里加插件代码。** 插件侧（`core/` 纪律、`plugin.yaml`、发版）全在新仓库；
应用侧只保留三样东西：客户端代码、契约文档、自举 Prompt 里的 `{{PLUGIN_REPO}}`
（`src/utils/hermesPrompt.ts` 的一个常量；**不钉版本** —— 引导装默认分支最新版，跟版靠 `hermes plugins update`）。

迁移过程与回滚步骤：[PLUGIN_REPO_MIGRATION](../docs/guides/PLUGIN_REPO_MIGRATION.md)。
契约与验收：[CLOUD_AGENT_DEVICES](../docs/requirements/CLOUD_AGENT_DEVICES.md) ·
[ADR-008](../docs/decisions/ADR-008-cloud-single-entry-plugin.md)。
