/** 设置页的 GitHub 关联：标准 OAuth 授权码流程 + pi-workbench:// 回调 */

import React, { useEffect, useState } from 'react'
import { GitPullRequest, KeyRound } from 'lucide-react'
import { api } from '../api'
import { useI18nStore } from '../store/i18nStore'
import { toast } from '../store/toastStore'
import { Button, Field, Input } from './ui'
import type { GithubAuthUser } from '../types/electron'

type Phase = 'idle' | 'starting' | 'waiting' | 'error'

export const GithubSettings: React.FC = () => {
  const { t } = useI18nStore()
  const [linked, setLinked] = useState(false)
  const [appConfigured, setAppConfigured] = useState(false)
  const [user, setUser] = useState<GithubAuthUser | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [token, setToken] = useState('')
  const [savingToken, setSavingToken] = useState(false)

  useEffect(() => {
    void (async () => {
      const config = await api.githubAuthConfig()
      if (config.success) {
        setAppConfigured(Boolean(config.appConfigured))
        setLinked(Boolean(config.linked))
      }
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
        setError(null)
        toast.success(t('githubLinked'))
      } else {
        setPhase('error')
        setError(payload.error ?? t('githubLoginFailed'))
      }
    })
  }, [t])

  const start = async () => {
    setError(null)
    setPhase('starting')
    const result = await api.githubAuthStart()
    if (!result.success) {
      setPhase('error')
      setError(
        result.error === 'OAUTH_APP_NOT_CONFIGURED'
          ? t('githubAppNotConfigured')
          : result.error ?? t('githubLoginFailed')
      )
      return
    }
    setPhase('waiting')
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
          {!appConfigured && (
            <div className="type-caption text-warning">{t('githubAppNotConfigured')}</div>
          )}
          <div>
            <Button
              size="sm"
              icon={GitPullRequest}
              loading={phase === 'starting'}
              disabled={!appConfigured || phase === 'starting' || phase === 'waiting'}
              onClick={() => void start()}
            >
              {t('githubLink')}
            </Button>
          </div>

          {phase === 'waiting' && (
            <div className="border border-rule-hairline bg-raised p-3 type-caption text-ink-muted">
              {t('githubWaitingBrowser')}
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
