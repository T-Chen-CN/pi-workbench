# 工作台插件示例

插件扩展的是 **Pi Workbench 本身**（命令 / 钩子），不接入 Pi Agent 的扩展机制。
插件运行在 Electron 主进程，没有沙箱，请只安装可信插件。

## 安装示例插件

把示例目录复制到某个工作区的插件目录，然后在命令面板（Ctrl+Shift+P）里点"重新加载插件"：

```bash
mkdir -p "<workspace>/.pi-workbench/plugins"
cp -r examples/plugins/git-tools "<workspace>/.pi-workbench/plugins/"
```

## 目录结构

```
<workspace>/.pi-workbench/plugins/
└── my-plugin/
    ├── plugin.json    # 清单：id / name / main / contributes.commands
    └── index.js       # CommonJS 入口，导出 activate(api)
```

`plugin.json`：

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "main": "index.js",
  "contributes": {
    "commands": [{ "id": "my.command", "title": "My: Command" }]
  }
}
```

`index.js`：

```js
module.exports = {
  activate(api) {
    api.registerCommand('my.command', async (args) => {
      return { success: true, output: `workspace: ${api.workspaceDir}` }
    })

    api.on('file:saved', (payload) => api.log('saved', payload.path))
  },
  deactivate() {},
}
```

## 可用 API

- `api.workspaceDir`：插件所在工作区的绝对路径
- `api.pluginDir`：插件目录
- `api.registerCommand(id, handler)`：注册命令，返回 `{ success, output?, message?, error? }`
- `api.on(event, handler)`：订阅钩子。当前事件：
  - `workspace:opened`（`{ workspaceDir }`）
  - `file:saved`（`{ path }`）
  - `chat:message`（`{ message }`）
- `api.log(...args)`：写入主进程日志

命令在命令面板中执行，参数来自面板的参数输入框（字符串）。
