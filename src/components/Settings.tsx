import React from 'react'
import { useI18nStore } from '../store/i18nStore'

interface SettingsProps {
  onClose: () => void
}

export const Settings: React.FC<SettingsProps> = ({ onClose }) => {
  const { language, setLanguage, t } = useI18nStore()

  return (
    <>
      <div className="fixed inset-0 bg-black/50 cursor-pointer z-40" onClick={onClose} />
      <div className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-white dark:bg-[#252526] border border-gray-300 dark:border-gray-700 rounded-lg shadow-xl max-w-sm w-96 z-50">
        {/* Header */}
        <div className="flex justify-between items-center px-6 py-4 border-b border-gray-300 dark:border-gray-700">
          <h3 className="text-lg font-semibold m-0 text-gray-900 dark:text-gray-100">{t('settings')}</h3>
          <button
            onClick={onClose}
            className="bg-none border-none cursor-pointer text-xl text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 p-0"
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-900 dark:text-gray-100 mb-2">
              {t('language')}
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => setLanguage('zh')}
                className={`flex-1 py-2 px-3 rounded font-medium transition-colors text-sm ${
                  language === 'zh'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-gray-100 hover:bg-gray-300 dark:hover:bg-gray-600'
                }`}
              >
                {t('chinese')}
              </button>
              <button
                onClick={() => setLanguage('en')}
                className={`flex-1 py-2 px-3 rounded font-medium transition-colors text-sm ${
                  language === 'en'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-gray-100 hover:bg-gray-300 dark:hover:bg-gray-600'
                }`}
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
