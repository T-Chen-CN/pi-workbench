/**
 * OAuth 登录交互面板。
 *
 * SDK 的登录流程可能在任何一步要输入（选登录方式 / 粘贴回调 URL / 填验证码），
 * 也可能只是推一个授权链接或设备码。所有交互都走 IPC 事件，这里负责渲染
 * 并回填，`select` 直接点选，文本类输入回车提交。
 */

import { useCallback, useEffect, useState } from 'react'
import type { ProviderAuthEvent, ProviderAuthPrompt } from '../../types/electron'
import { api } from '../../api'
import { useI18nStore } from '../../store/i18nStore'
import { Button, Input } from '../ui/ui'
import { ExternalLink } from 'lucide-react'

interface Candidate {
  providerId: string
  prompt?: ProviderAuthPrompt
  link?: { url: string; label?: string; instructions?: string }
  deviceCode?: { userCode: string; verificationUri: string }
  progress?: string
  info?: string
  done?: boolean
  error?: string
}

export function ProviderAuthPanel({ providerId }: { providerId: string }) {
  const t = useI18nStore((store) => store.t)
  const [state, setState] = useState<Candidate | null>(null)
  const [value, setValue] = useState('')

  useEffect(() => {
    // 切换供应商时重置面板，避免把上一个供应商的登录态/报错带过来
    setState(null)
    setValue('')
    const off = api.onProvidersAuthEvent((payload: ProviderAuthEvent) => {
      if (payload.providerId !== providerId) return
      setState((prev) => {
        const next: Candidate = { providerId, ...prev }
        switch (payload.kind) {
          case 'prompt':
            return { ...next, prompt: payload.prompt }
          case 'auth_url':
            return {
              ...next,
              link: { url: payload.url, instructions: payload.instructions }
            }
          case 'device_code':
            return {
              ...next,
              deviceCode: { userCode: payload.userCode, verificationUri: payload.verificationUri }
            }
          case 'info':
            return { ...next, info: payload.message }
          case 'progress':
            return { ...next, progress: payload.message }
          case 'result':
            return {
              ...next,
              prompt: undefined,
              done: payload.success,
              error: payload.success ? undefined : payload.error
            }
          default:
            return next
        }
      })
      // 只在新 prompt 或终态 result 时清输入框，防止后台 progress/info 事件抹掉用户正在输入的验证码/回调 URL
      if (payload.kind === 'prompt' || payload.kind === 'result') {
        setValue('')
      }
    })
    return () => off()
  }, [providerId])

  const answer = useCallback(
    async (answerValue: string) => {
      const requestId = state?.prompt?.requestId
      if (!requestId) return
      await api.providersAuthAnswer(requestId, answerValue)
      setState((prev) => (prev ? { ...prev, prompt: undefined } : prev))
      setValue('')
    },
    [state?.prompt?.requestId]
  )

  if (!state) return null

  const { prompt, link, deviceCode, progress, info, done, error } = state
  const finished = done || !!error

  const openUrl = (event: React.MouseEvent<HTMLAnchorElement>, url: string) => {
    event.preventDefault()
    void api.openExternalUrl(url)
  }

  return (
    <div className="flex flex-col gap-2 rounded border border-rule-control bg-sunken p-3">
      {progress && <span className="type-caption text-ink-muted">{progress}</span>}

      {info && <span className="type-caption text-ink-muted">{info}</span>}

      {link && (
        <div className="flex flex-col gap-1">
          {link.instructions && (
            <span className="type-caption text-ink-muted">{link.instructions}</span>
          )}
          <a
            className="type-caption inline-flex items-center gap-1 text-accent hover:underline"
            href={link.url}
            onClick={(event) => openUrl(event, link.url)}
          >
            <ExternalLink size={12} />
            {link.label ?? t('providerOpenAuthLink')}
          </a>
        </div>
      )}

      {deviceCode && (
        <div className="flex flex-col gap-1">
          <span className="type-caption text-ink-muted">{t('providerDeviceCodeHint')}</span>
          <div className="flex items-center gap-2">
            <code className="type-code text-ink">{deviceCode.userCode}</code>
            <a
              className="type-caption inline-flex items-center gap-1 text-accent hover:underline"
              href={deviceCode.verificationUri}
              onClick={(event) => openUrl(event, deviceCode.verificationUri)}
            >
              <ExternalLink size={12} />
              {deviceCode.verificationUri}
            </a>
          </div>
        </div>
      )}

      {prompt && (
        <div className="flex flex-col gap-2">
          <span className="type-caption text-ink">{prompt.prompt.message}</span>
          {prompt.prompt.type === 'select' ? (
            <div className="flex flex-wrap gap-2">
              {(prompt.prompt.options ?? []).map((option) => (
                <Button
                  key={option.id}
                  variant="secondary"
                  size="sm"
                  title={option.description}
                  onClick={() => void answer(option.id)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Input
                type={prompt.prompt.type === 'secret' ? 'password' : 'text'}
                value={value}
                placeholder={prompt.prompt.placeholder}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    !event.nativeEvent.isComposing &&
                    event.keyCode !== 229 &&
                    value.trim()
                  ) {
                    void answer(value.trim())
                  }
                }}
                className="type-code"
              />
              <Button
                variant="primary"
                size="sm"
                disabled={!value.trim()}
                onClick={() => void answer(value.trim())}
              >
                {t('providerSubmit')}
              </Button>
            </div>
          )}
        </div>
      )}

      {error && (
        <span className="type-caption text-danger">
          {t('providerLoginFailed', { error: error })}
        </span>
      )}

      {!finished && (
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void api.providersCancelLogin(providerId)
              setState(null)
            }}
          >
            {t('cancel')}
          </Button>
        </div>
      )}
    </div>
  )
}
