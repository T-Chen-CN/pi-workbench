import React from 'react'
import { useI18nStore } from '../store/i18nStore'
import '../styles/Settings.css'

interface SettingsProps {
  onClose: () => void
}

export const Settings: React.FC<SettingsProps> = ({ onClose }) => {
  const { language, setLanguage, t } = useI18nStore()

  return (
    <>
      <div className="settings-backdrop" onClick={onClose} />
      <div className="settings-panel">
        <div className="settings-header">
          <h3>{t('settings')}</h3>
          <button className="close-button" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="settings-content">
          <div className="setting-item">
            <label>{t('language')}</label>
            <div className="language-selector">
              <button
                className={`language-option ${language === 'zh' ? 'active' : ''}`}
                onClick={() => setLanguage('zh')}
              >
                {t('chinese')}
              </button>
              <button
                className={`language-option ${language === 'en' ? 'active' : ''}`}
                onClick={() => setLanguage('en')}
              >
                {t('english')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
