/** 顶层视图：首页 / 工作区 / 云端会话 / 云端配置 */

export type AppView = 'home' | 'workspace' | 'cloud-session' | 'cloud-config'

/** 云端外壳的两个页签 */
export type CloudView = Extract<AppView, 'cloud-session' | 'cloud-config'>

export function isCloudView(view: AppView): view is CloudView {
  return view === 'cloud-session' || view === 'cloud-config'
}
