/**
 * Web 客户端「云端模型配置」卡：输入不能被重渲染抹掉。
 *
 * 背景（真实事故）：整页 `render()` 在收到任何 WS 帧（流式输出）时都会重跑，
 * DOM 会被重建。原来输入值只存在 DOM 上、拉模型时还主动 `render()` 一次，
 * 结果「点了获取可用模型，刚填的 Key 就没了」。
 *
 * 约束因此有两条：**值必须存 state.configDraft**、**拉模型只做局部更新**。
 * 这里用源码断言把这两条钉住（Web 客户端零构建、不导出函数，行为测试拿不到入口）。
 */

// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import * as path from 'path'

const source = readFileSync(path.resolve(__dirname, '../apps/cloud/web/app.js'), 'utf-8')

describe('云端配置卡的输入保持', () => {
  it('输入都从 state.configDraft 回填（否则任何一帧到达就清空）', () => {
    expect(source).toContain('if (!state.configDraft) {')
    expect(source).toContain('value: draft.apiKey')
    expect(source).toContain('draft.apiKey = event.target.value')
    expect(source).toContain('draft.providerId = event.target.value')
  })

  it('不再有自建端点字段（供应商白名单取代 Base URL）', () => {
    expect(source).not.toContain('draft.apiUrl')
    expect(source).not.toContain('apiConfig')
    expect(source).toContain('固定供应商白名单')
  })

  it('刷新目录只做局部更新，不整页 render()', () => {
    const start = source.indexOf('const loadCatalog = async () => {')
    const end = source.indexOf('const saveButton = el(')
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const handler = source.slice(start, end)
    expect(handler).not.toContain('render()')
    expect(handler).toContain('paintModelField()')
  })

  it('保存成功后清掉 draft 与临时模型列表（Key 不留在页面状态里）', () => {
    const start = source.indexOf('const saveButton = el(')
    const handler = source.slice(start, start + 1600)
    expect(handler).toContain('state.configDraft = null')
  })
})
