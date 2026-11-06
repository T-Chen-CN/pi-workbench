# hermes-plugin/ —— 已迁出，这里是路牌

云端网关插件**不再存放在本仓库**。新插件是独立仓库：

| 项 | 值 |
| --- | --- |
| 仓库 | `pi-workbench-gateway`（新仓库，开发中） |
| 形状 | **仓库根目录就是插件本体**（`plugin.yaml` 在根） |
| 插件 id | `pi-workbench-gateway` |
| 测试 | `python -m unittest discover -s tests -t .`（纯 stdlib，零依赖） |

开发方案、目录结构、协议、验收与部署步骤：

[CLOUD_AGENT_GATEWAY_PLUGIN](../docs/requirements/CLOUD_AGENT_GATEWAY_PLUGIN.md)

**不要再往这里加插件代码。** 应用侧只保留三样东西：

- 客户端代码
- 契约文档
- 自举 Prompt 里的 `{{PLUGIN_REPO}}`（`src/utils/hermesPrompt.ts` 的一个常量）

新仓库发布后，把应用侧常量与自举 Prompt 一起切到新仓库地址；引导不钉版本，跟版靠 `hermes plugins update`。

契约与验收：

- [CLOUD_AGENT_PAIRING](../docs/requirements/CLOUD_AGENT_PAIRING.md)
- [CLOUD_AGENT_GATEWAY_PLUGIN](../docs/requirements/CLOUD_AGENT_GATEWAY_PLUGIN.md)
- [ADR-008](../docs/decisions/ADR-008-cloud-single-entry-plugin.md)
