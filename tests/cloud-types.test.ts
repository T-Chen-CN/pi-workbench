import { describe, expectTypeOf, it } from 'vitest'
import type * as Main from '../electron/cloud/types'
import type * as Renderer from '../src/types/cloud'

/**
 * 主进程 tsconfig 的 rootDir 是 electron/，不能直接引用 src/ 下的类型文件，
 * 所以 electron/cloud/types.ts 是一份副本。这里用类型断言守住两份不漂移。
 */
describe('cloud types (main ↔ renderer)', () => {
  it('keeps the shared shapes structurally identical', () => {
    expectTypeOf<Main.CloudTracePart>().toEqualTypeOf<Renderer.CloudTracePart>()
    expectTypeOf<Main.CloudFrame>().toEqualTypeOf<Renderer.CloudFrame>()
    expectTypeOf<Main.CloudSession>().toEqualTypeOf<Renderer.CloudSession>()
    expectTypeOf<Main.CloudRunStatus>().toEqualTypeOf<Renderer.CloudRunStatus>()
    expectTypeOf<Main.CloudToolStatus>().toEqualTypeOf<Renderer.CloudToolStatus>()
    expectTypeOf<Main.CloudCapabilities>().toEqualTypeOf<Renderer.CloudCapabilities>()
    expectTypeOf<Main.CloudConnectionState>().toEqualTypeOf<Renderer.CloudConnectionState>()
  })
})
