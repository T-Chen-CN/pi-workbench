/** 设置页的 GitHub 关联：设备码登录（clientId 内置，跨设备零配置）+ PAT 备用 */

import React, { useEffect, useState } from 'react'
import { Copy, ExternalLink, GitPullRequest, KeyRound } from 'lucide-react'
import { api } from '../api'
import { useI18nStore } from '../store/i18nStore'
import { toast } from '../store/toastStore'
import { Button, Caption, Field, IconButton, Input, Label } from './ui'
import { StatusText } from './patterns'
import { copyText } from '../utils/clipboard'
import type { GithubAuthUser } from '../types/electron'

type Phase = 'idle' | 'starting' | 'waiting' | 'error'

interface DevicePrompt {
  userCode: string
  verificationUri: string
  expiresAt: number
}

function formatRemaining(seconds: number): string {
  const safe = Math.max(0, seconds)
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`
}

export const GithubSettings: React.FC = () => {
  const { t } = useI18nStore()
  const [linked, setLinked] = useState(false)
  const [user, setUser] = useState<GithubAuthUser | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [device, setDevice] = useState<DevicePrompt | null>(null)
  const [remaining, setRemaining] = useState(0)
  const [token, setToken] = useState('')
  const [savingToken, setSavingToken] = useState(false)

  useEffect(() => {
    void (async () => {
      const status = await api.githubAuthStatus()
      if (status.success && status.configured) {
        setLinked(true)
        setUser(status.user ?? null)
      }
    })().catch(() => undefined)
  }, [])

  useEffect(() => {
    if (typeof api.onGithubAuthComplete !== 'function') return
    return api.onGithubAuthComplete((payload) => {
      if (payload.success) {
        setLinked(true)
        setUser(payload.user ?? null)
        setPhase('idle')
        setDevice(null)
        setError(null)
        toast.success(t('githubLinked'))
      } else {
        setPhase('error')
        setError(payload.error ?? t('githubLoginFailed'))
      }
    })
  }, [t])

  useEffect(() => {
    if (typeof api.onGithubAuthDeviceEvent !== 'function') return
    return api.onGithubAuthDeviceEvent((payload) => {
      if (payload.status === 'expired') {
        setPhase('error')
        setError(t('githubCodeExpired'))
        setDevice(null)
      } else if (payload.status === 'denied') {
        setPhase('error')
        setError(t('githubCodeDenied'))
        setDevice(null)
      } else if (payload.status === 'error') {
        setPhase('error')
        setError(payload.error ?? t('githubLoginFailed'))
        setDevice(null)
      }
    })
  }, [t])

  useEffect(() => {
    if (!device) {
      setRemaining(0)
      return
    }
    const tick = () => {
      const seconds = Math.max(0, Math.ceil((device.expiresAt - Date.now()) / 1000))
      setRemaining(seconds)
      if (seconds === 0) {
        setPhase('error')
        setError(t('githubCodeExpired'))
        setDevice(null)
        void api.githubAuthDeviceCancel()
      }
    }
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [device, t])

  const start = async () => {
    setError(null)
    setPhase('starting')
    const result = await api.githubAuthDeviceStart()
    if (!result.success) {
      setPhase('error')
      const message =
        result.error === 'CLIENT_ID_NOT_CONFIGURED'
          ? t('githubLoginUnavailable')
          : typeof result.error === 'string' && /device[_ ]flow/i.test(result.error)
            ? t('githubDeviceFlowDisabled')
            : result.error ?? t('githubLoginFailed')
      setError(message)
      return
    }
    setDevice({
      userCode: result.userCode ?? '',
      verificationUri: result.verificationUri ?? 'https://github.com/login/device',
      expiresAt: Date.now() + (result.expiresIn ?? 900) * 1000,
    })
    setPhase('waiting')
  }

  const cancel = async () => {
    await api.githubAuthDeviceCancel()
    setDevice(null)
    setPhase('idle')
    setError(null)
  }

  const openBrowser = async () => {
    await api.githubAuthDeviceOpen()
  }

  const copyCode = async () => {
    if (!device?.userCode) return
    if (await copyText(device.userCode)) {
      toast.success(t('githubCodeCopied'))
    } else {
      toast.error(t('copyFailedPlain'))
    }
  }

  const logout = async () => {
    const result = await api.githubAuthLogout()
    if (!result.success) {
      toast.error(result.error ?? t('githubLoginFailed'))
      return
    }
    setLinked(false)
    setUser(null)
    setPhase('idle')
    setDevice(null)
    setError(null)
  }

  const saveToken = async () => {
    setSavingToken(true)
    try {
      const result = await api.gitSetGithubToken(token.trim())
      if (!result.success) {
        toast.error(result.error ?? t('githubLoginFailed'))
        return
      }
      const status = await api.githubAuthStatus()
      setLinked(Boolean(status.configured))
      setUser(status.user ?? null)
      setToken('')
      toast.success(t('githubTokenSaved'))
    } finally {
      setSavingToken(false)
    }
  }

  return (
    <div className="flex max-w-lg flex-col gap-4">
      <p className="m-0 type-reading text-ink-muted">{t('githubDesc')}</p>

      {linked ? (
        <Field label={t('githubAccount')}>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5 type-value text-ink">
              <GitPullRequest size={14} className="text-ink-muted" />
              {user?.login ? `@${user.login}` : t('githubLinked')}
            </span>
            <Button size="sm" variant="secondary" onClick={() => void logout()}>
              {t('githubUnlink')}
            </Button>
          </div>
        </Field>
      ) : (
        <>
          {phase === 'waiting' && device ? (
            <div className="border border-rule-hairline bg-raised p-3">
              <div className="flex flex-col gap-2.5">
                <div className="flex flex-col gap-1">
                  <Label className="text-ink-muted">{t('githubUserCode')}</Label>
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1 border border-rule-hairline bg-sunken px-2.5 py-1.5">
                      <span className="type-code select-all text-ink">{device.userCode}</span>
                    </div>
                    <IconButton
                      icon={Copy}
                      label={t('githubCopyCode')}
                      size="sm"
                      onClick={() => void copyCode()}
                    />
                  </div>
                </div>
                <Caption className="text-ink-muted">
                  {t('githubDeviceHint', { uri: device.verificationUri })}
                </Caption>
                <div className="flex items-center justify-between gap-2">
                  <StatusText tone="accent" dot>
                    {t('githubWaiting')}
                  </StatusText>
                  <Caption className="text-ink-muted">
                    {t('githubExpiresIn')} {formatRemaining(remaining)}
                  </Caption>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={ExternalLink}
                    onClick={() => void openBrowser()}
                  >
                    {t('githubOpenBrowser')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void cancel()}>
                    {t('cancel')}
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <div>
              <Button
                size="sm"
                icon={GitPullRequest}
                loading={phase === 'starting'}
                disabled={phase === 'starting'}
                onClick={() => void start()}
              >
                {t('githubLink')}
              </Button>
            </div>
          )}

          {error && <div className="type-caption text-danger">{error}</div>}

          <details className="border-t border-rule-divide pt-3">
            <summary className="flex cursor-pointer items-center gap-1.5 type-label text-ink-muted">
              <KeyRound size={12} />
              {t('githubTokenFallback')}
            </summary>
            <div className="mt-2 flex flex-col gap-2">
              <div className="type-caption text-ink-muted">{t('githubTokenHint')}</div>
              <Input
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="ghp_..."
                className="type-code"
              />
              <div>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={savingToken}
                  disabled={!token.trim() || savingToken}
                  onClick={() => void saveToken()}
                >
                  {t('githubTokenSave')}
                </Button>
              </div>
            </div>
          </details>
        </>
      )}
    </div>
  )
}
