/** 顶层视图：首页 / 工作区 / 云端会话 / 云端控制台 / 云端连接 */

export type AppView =
  | 'home'
  | 'workspace'
  | 'cloud-session'
  | 'cloud-console'
  | 'cloud-jobs'
  | 'cloud-connection'

/** 云端外壳的三个页签 */
export type CloudView = Extract<
  AppView,
  'cloud-session' | 'cloud-console' | 'cloud-jobs' | 'cloud-connection'
>

export function isCloudView(view: AppView): view is CloudView {
  return (
    view === 'cloud-session' ||
    view === 'cloud-console' ||
    view === 'cloud-jobs' ||
    view === 'cloud-connection'
  )
}
