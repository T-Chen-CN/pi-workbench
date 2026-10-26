# Third-Party Notices

本项目除自身代码外，还以源码或二进制形式分发下列第三方组件。各组件的许可条款仅约束其自身代码。

## 运行期内置组件

### pi-web-access

- 版本：0.45.0（`package.json` 中固定，不随 `^` 浮动）
- 许可证：MIT
- 来源：<https://github.com/nicobailon/pi-web-access>
- 用途：应用内置的联网搜索与网页读取能力（`web_search` / `fetch_content` / `get_search_content` / `source_check`），由 Electron 主进程在创建 Agent 会话时加载，随安装包分发。
- 维护约定：升级版本时同步修改 `package.json`、审阅上游变更，并更新本文件中的版本号。

## 说明

- 该组件运行在主进程中，拥有与主进程相同的文件与网络权限；它的版本、升级与安全审阅按自有代码的标准处理。
- 用户自行配置的搜索服务（Tavily、Exa、Brave、Firecrawl、Perplexity、Parallel、Jina、博查、智谱、DuckDuckGo）由各自的服务条款约束，本项目只保存用户提供的密钥。
