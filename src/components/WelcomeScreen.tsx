import React, { useRef, useState } from 'react'
import { ArrowRight } from 'lucide-react'
import { useI18nStore } from '../store/i18nStore'

interface WelcomeScreenProps {
  recentWorkspaces: string[]
  onOpenProject: () => void
  onOpenWorkspace: (path: string) => void
  onAsk: (prompt: string) => void
}

export const WelcomeScreen: React.FC<WelcomeScreenProps> = ({
  recentWorkspaces,
  onOpenProject,
  onOpenWorkspace,
  onAsk,
}) => {
  const { t } = useI18nStore()
  const [prompt, setPrompt] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const ask = (value: string) => {
    const trimmed = value.trim()
    if (!trimmed) {
      inputRef.current?.focus()
      return
    }
    onAsk(trimmed)
  }

  return (
    <main className="paper-noise relative flex flex-1 overflow-y-auto">
      <div className="relative mx-auto flex w-full max-w-[1180px] flex-1 flex-col px-12 py-9">
        <div className="grid flex-1 grid-cols-[1.12fr_0.88fr] gap-16">
          <section className="flex min-w-0 flex-col">
            <p className="m-0 font-mono text-[10px] uppercase tracking-[0.16em] text-accent">
              {t('welcomeEyebrow')}
            </p>
            <h1 className="mb-3.5 mt-4 font-display text-[56px] leading-[1.04] tracking-[-0.02em] text-ink">
              {t('welcomeHeadlineA')}
              <br />
              {t('welcomeHeadlineB')}
              <em className="italic text-accent">{t('welcomeHeadlineHighlight')}</em>
              {t('welcomeHeadlineC')}
            </h1>
            <p className="m-0 max-w-[460px] font-reading text-[14px] leading-[1.8] text-ink-muted">
              {t('welcomeLede')}
            </p>

            <form
              className="mt-8 flex items-center gap-3 border-b border-ink pb-3"
              onSubmit={(event) => {
                event.preventDefault()
                ask(prompt)
              }}
            >
              <input
                ref={inputRef}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder={t('welcomeAskPlaceholder')}
                className="min-w-0 flex-1 bg-transparent font-display text-lg text-ink placeholder:text-ink-subtle focus:outline-none"
              />
              <span className="flex-shrink-0 border border-line px-1.5 py-0.5 font-mono text-[9px] text-ink-subtle">
                ⌘ ↵
              </span>
              <button
                type="submit"
                aria-label={t('welcomeAskAction')}
                className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg transition-colors hover:bg-accent-hover"
              >
                <ArrowRight size={14} />
              </button>
            </form>

            <div className="mt-3 flex flex-wrap gap-5 font-mono text-[10.5px] text-ink-muted">
              {[t('welcomeSuggestionExplain'), t('welcomeSuggestionBuild'), t('welcomeSuggestionTests')].map(
                (suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => ask(suggestion)}
                    className="border-b border-line pb-0.5 text-left transition-colors hover:border-ink hover:text-ink"
                  >
                    {suggestion}
                  </button>
                )
              )}
            </div>

            <div className="mt-auto pt-8">
              <div className="flex items-baseline justify-between border-b border-line pb-2">
                <span className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-ink-subtle">
                  {t('welcomeRecent')}
                </span>
                <button
                  type="button"
                  onClick={onOpenProject}
                  className="font-mono text-[10px] text-ink-muted transition-colors hover:text-ink"
                >
                  {t('welcomeViewAll')}
                </button>
              </div>
              {recentWorkspaces.length === 0 ? (
                <button
                  type="button"
                  onClick={onOpenProject}
                  className="w-full py-4 text-left font-mono text-[10.5px] text-ink-subtle transition-colors hover:text-ink"
                >
                  {t('welcomeNoRecent')}
                </button>
              ) : (
                recentWorkspaces.slice(0, 3).map((path, index) => {
                  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path
                  return (
                    <button
                      key={path}
                      type="button"
                      onClick={() => onOpenWorkspace(path)}
                      className="group grid w-full grid-cols-[34px_1fr_auto] items-baseline gap-4 border-b border-line py-2.5 text-left"
                    >
                      <span className="font-mono text-[10px] text-ink-subtle">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-display text-xl text-ink transition-colors group-hover:text-accent">
                          {name}
                        </span>
                        <span className="mt-0.5 block truncate font-mono text-[10px] text-ink-subtle">
                          {path}
                        </span>
                      </span>
                      <span className="font-mono text-[9.5px] text-ink-subtle">
                        {index === 0 ? t('welcomeRecentLatest') : ''}
                      </span>
                    </button>
                  )
                })
              )}
            </div>
          </section>

          <section className="flex min-w-0 flex-col pt-1.5">
            <div className="flex flex-1 flex-col border border-line bg-raised p-5 shadow-print">
              <div className="flex items-center justify-between border-b border-line pb-2">
                <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-ink-muted">
                  {t('welcomeAgentLabel')}
                </span>
                <span className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.1em] text-accent">
                  <span className="h-1 w-1 rounded-full bg-accent" />
                  {t('welcomeAgentLive')}
                </span>
              </div>

              <p className="mb-4 mt-4 font-reading text-[13px] leading-[1.8] text-ink">
                {t('welcomeAgentIntro')}
              </p>

              <div className="border-t border-line pt-3">
                <div className="mb-1.5 font-mono text-[8.5px] uppercase tracking-[0.16em] text-ink-subtle">
                  {t('welcomeCapabilities')}
                </div>
                {[
                  ['read_file', t('welcomeCapabilityRead')],
                  ['edit_file', t('welcomeCapabilityEdit')],
                  ['run_tests', t('welcomeCapabilityTest')],
                ].map(([tool, description]) => (
                  <div key={tool} className="flex items-baseline gap-3 py-1 font-mono text-[9.8px]">
                    <span className="w-16 flex-shrink-0 text-accent">{tool}</span>
                    <span className="text-ink-muted">{description}</span>
                  </div>
                ))}
              </div>

              <div className="mt-4 border-t border-line pt-3">
                <div className="mb-1.5 font-mono text-[8.5px] uppercase tracking-[0.16em] text-ink-subtle">
                  {t('welcomeFlow')}
                </div>
                {[t('welcomeFlowRead'), t('welcomeFlowEdit'), t('welcomeFlowReview')].map(
                  (step, index) => (
                    <div key={step} className="flex items-baseline gap-3 py-1 font-mono text-[9.8px]">
                      <span className="w-4 flex-shrink-0 text-ink-subtle">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <span className="text-ink-muted">{step}</span>
                    </div>
                  )
                )}
              </div>

              <div className="mt-auto flex items-center justify-between border-t border-line pt-2 font-mono text-[9px] text-ink-subtle">
                <span>{t('welcomeAgentFooter')}</span>
                <span>{t('welcomeAgentModel')}</span>
              </div>
            </div>

            <div className="mt-5 self-end border-[1.5px] border-accent px-4 py-2 text-center font-mono text-[10px] tracking-[0.18em] text-accent [transform:rotate(-3deg)]">
              {t('welcomeStampTitle')}
              <span className="mt-0.5 block text-[8px] tracking-[0.24em]">
                {t('welcomeStampSubtitle')}
              </span>
            </div>
          </section>
        </div>

        <footer className="mt-6 flex items-center justify-between border-t border-line pt-2 font-mono text-[9px] uppercase tracking-[0.08em] text-ink-subtle">
          <span>{t('welcomeFooter')}</span>
          <span>{t('welcomeFooterRight')}</span>
        </footer>
      </div>
    </main>
  )
}
