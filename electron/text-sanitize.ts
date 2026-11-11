/**
 * 终端控制序列清理。
 *
 * 工具结果里会带 SGR 颜色码（Windows PowerShell 的报错输出最典型，形如
 * `\u001b[31;1mdotnet: \u001b[0m`）。这些字节对人眼是零宽，却实实在在占字数额度：
 * 实测派活轨迹里 **31% 的 powershell 结果**带色，一段 160 字的截断结果平均有
 * 47 个字节是颜色码 —— 上报云端的轨迹、审计预览都被它挤掉了真正的内容。
 *
 * 与 `pi-bridge/src/text-utils.ts` 的 `stripAnsi` 同语义：那边负责渲染层的工具卡
 * 预览，这边负责主进程写盘 / 上云的两条链（轨迹 + 审计）。两边都改才算修全 ——
 * 主进程与 bridge 是独立构建，不能互相 import 源码。
 */

/**
 * CSI（`ESC [ … m` 等）与 OSC（`ESC ] … BEL/ST`）：终端上会吃掉的控制序列。
 *
 * 控制字符用 `String.fromCharCode` 拼出来，而不是写进正则字面量 —— 否则
 * `no-control-regex` 会正当报错（它防的正是把 ESC / BEL 误写进正则）。
 */
const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const ANSI_PATTERN = new RegExp(
  `${ESC}(?:\\[[0-9;?]*[ -/]*[@-~]|\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\))`,
  'g'
)

export function stripAnsi(text: string): string {
  // 绝大多数结果没有 ESC：省掉正则扫描
  if (!text || text.indexOf('\u001B') < 0) return text
  return text.replace(ANSI_PATTERN, '')
}
