import { Check, Monitor, Moon, Sun } from 'lucide-react'
import { setThemePreference, useAppearance, type ThemePreference } from './theme'

const options = [
  { value: 'light', label: '暖白', description: '柔和的纸色与陶橙', icon: Sun },
  { value: 'dark', label: '夜色', description: 'Tokyo Night Storm', icon: Moon },
  { value: 'system', label: '跟随系统', description: '随系统外观自动切换', icon: Monitor },
] as const

export function AppearancePicker() {
  const { preference } = useAppearance()
  return (
    <section className="appearance-section" aria-labelledby="appearance-heading">
      <div className="settings-section-heading">
        <h3 id="appearance-heading">外观</h3><span>选一种舒服的光线</span>
      </div>
      <div className="theme-options" role="group" aria-label="界面主题">
        {options.map(({ value, label, description, icon: Icon }) => (
          <button key={value} type="button" className="theme-option"
            data-theme-choice={value} aria-pressed={preference === value}
            onClick={() => setThemePreference(value as ThemePreference)}>
            <span className={`theme-preview preview-${value}`} aria-hidden="true">
              <span className="preview-rail" /><span className="preview-content"><i /><i /><i /></span>
              <Icon size={16} />
            </span>
            <span className="theme-option-label"><Icon size={14} />{label}{preference === value && <Check size={13} />}</span>
            <small>{description}</small>
          </button>
        ))}
      </div>
    </section>
  )
}
