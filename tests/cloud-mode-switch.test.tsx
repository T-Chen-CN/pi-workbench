// @vitest-environment jsdom
/**
 * 审批档位控件的加载时机。
 *
 * 真机踩到的坑：连接页在**还没配对**时就把卡片挂出来了，控件 mount 就发一次
 * `cloud:policy:get`，主进程回「这台设备还没有配对，先在「连接」页配对」；
 * 配对成功后组件并不重新挂载，于是那句红字一直挂着——用户看到「已配对：TChen-Legion」
 * 和「还没有配对」同时出现。
 *
 * 守两件事：没连接时不读；从「未连接」变成「已连接」时要补读一次。
 */

import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CloudModeSwitch } from '../src/components/CloudModeSwitch'
import { useCloudStore } from '../src/store/cloudStore'
import type { CloudApprovalPolicy } from '../src/types/cloud'

const loadPolicy = vi.fn()

const policy: CloudApprovalPolicy = {
  mode: 'manual',
  timeoutSeconds: 300,
  denyCount: 0,
  disabledToolsets: ['code_execution'],
  terminalBackend: 'local',
}

beforeEach(() => {
  loadPolicy.mockReset()
  useCloudStore.setState({
    policy,
    policyLoading: false,
    policyPending: null,
    policyError: null,
    loadPolicy: loadPolicy as unknown as () => Promise<void>,
  })
})

afterEach(() => {
  cleanup()
})

describe('CloudModeSwitch', () => {
  it('未连接时不发请求（否则会拿到一条永远消不掉的「还没配对」）', () => {
    render(<CloudModeSwitch disabled />)
    expect(loadPolicy).not.toHaveBeenCalled()
  })

  it('未连接时不显示读写错误', () => {
    useCloudStore.setState({ policyError: '这台设备还没有配对，先在「连接」页配对' })
    const { queryByText } = render(<CloudModeSwitch disabled />)
    expect(queryByText(/还没有配对/)).toBeNull()
  })

  it('配对成功后（disabled 变 false）补读一次', () => {
    const { rerender } = render(<CloudModeSwitch disabled />)
    expect(loadPolicy).not.toHaveBeenCalled()

    rerender(<CloudModeSwitch />)
    expect(loadPolicy).toHaveBeenCalledTimes(1)

    // 重渲染不该重复请求
    rerender(<CloudModeSwitch />)
    expect(loadPolicy).toHaveBeenCalledTimes(1)
  })

  it('已连接时展示服务端档位', () => {
    const { getByText } = render(<CloudModeSwitch disabled={false} />)
    expect(getByText('询问我').getAttribute('aria-pressed')).toBe('true')
  })
})
