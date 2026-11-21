import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import {
  addFonts,
  deleteFontFile,
  inspectRemoteFont,
  loadFonts,
  removeFont,
  uploadFontFile,
  type FontRecord,
  type FontVariant,
  type RepositorySettings,
} from './fontRepository'
import './App.css'

const SETTINGS_KEY = 'font-library-settings'
const defaultVariant: FontVariant = { style: 'normal', weightMin: 400, weightMax: 400 }

function getFontIdFromHash() {
  const match = window.location.hash.match(/^#\/font\/([^/]+)$/)
  if (!match) return ''

  try {
    return decodeURIComponent(match[1])
  } catch {
    return ''
  }
}

function getDefaultRepository() {
  const owner = window.location.hostname.endsWith('.github.io')
    ? window.location.hostname.slice(0, -'.github.io'.length)
    : ''
  const repo = owner
    ? window.location.pathname.split('/').filter(Boolean)[0] || `${owner}.github.io`
    : ''

  return { owner, repo }
}

function readSettings(): RepositorySettings {
  const defaults = getDefaultRepository()

  try {
    const stored = localStorage.getItem(SETTINGS_KEY)
    if (stored) {
      return { branch: 'main', token: '', ...defaults, ...JSON.parse(stored) }
    }
  } catch {
    // Ignore invalid local settings and let the user configure the repository again.
  }

  return { ...defaults, branch: 'main', token: '' }
}

function App() {
  const [settings, setSettings] = useState(readSettings)
  const [fonts, setFonts] = useState<FontRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [selectedFontId, setSelectedFontId] = useState(getFontIdFromHash)
  const [showSettings, setShowSettings] = useState(() => {
    const saved = readSettings()
    return !saved.owner || !saved.repo
  })
  const selectedFont = fonts.find((font) => font.id === selectedFontId)

  useEffect(() => {
    const handleHashChange = () => setSelectedFontId(getFontIdFromHash())
    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [])

  useEffect(() => {
    let active = true

    if (!settings.owner || !settings.repo) {
      return
    }

    void loadFonts({
      owner: settings.owner,
      repo: settings.repo,
      branch: settings.branch,
    })
      .then((items) => {
        if (active) setFonts(items)
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : 'Не удалось загрузить список шрифтов.')
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [settings.owner, settings.repo, settings.branch])

  useEffect(() => {
    const cleanups: (() => void)[] = []
    const linkedStylesheets = new Set<string>()

    for (const font of fonts) {
      if (font.source.kind === 'remote') {
        if (linkedStylesheets.has(font.source.url)) continue
        linkedStylesheets.add(font.source.url)
        const link = document.createElement('link')
        link.rel = 'stylesheet'
        link.href = font.source.url
        document.head.appendChild(link)
        cleanups.push(() => link.remove())
      } else {
        const style = document.createElement('style')
        const branch = settings.branch.split('/').map(encodeURIComponent).join('/')
        const url = new URL(font.source.path, `https://raw.githubusercontent.com/${settings.owner}/${settings.repo}/${branch}/`)
        style.textContent = `@font-face{font-family:"${escapeCssString(font.family)}";src:url("${escapeCssString(url.href)}") format("${fontFormat(font.source.path)}");font-display:swap}`
        document.head.appendChild(style)
        cleanups.push(() => style.remove())
      }
    }

    return () => cleanups.forEach((cleanup) => cleanup())
  }, [fonts, settings.owner, settings.repo, settings.branch])

  function persistSettings(next: RepositorySettings) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next))
    setSettings(next)
    setLoading(true)
    setShowSettings(false)
    setNotice('Настройки сохранены в этом браузере.')
    setError('')
  }

  async function handleAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const kind = String(form.get('kind') ?? 'remote')

    setSaving(true)
    setError('')
    setNotice('')
    let uploadedPath: string | undefined

    try {
      let additions: FontRecord[]

      if (kind === 'file') {
        const name = String(form.get('name') ?? '').trim()
        const family = String(form.get('family') ?? '').trim()
        const file = form.get('file')
        if (!(file instanceof File) || file.size === 0) {
          throw new Error('Выберите файл шрифта.')
        }
        if (file.size > 10 * 1024 * 1024) {
          throw new Error('Размер файла не должен превышать 10 МБ.')
        }
        if (!/\.(woff2?|ttf|otf)$/i.test(file.name)) {
          throw new Error('Поддерживаются файлы WOFF, WOFF2, TTF и OTF.')
        }

        const id = crypto.randomUUID()
        uploadedPath = await uploadFontFile(settings, file, id)
        additions = [{
          id,
          name,
          family,
          source: { kind: 'file', path: uploadedPath },
          variants: [defaultVariant],
          createdAt: new Date().toISOString(),
        }]
      } else {
        const url = String(form.get('url') ?? '').trim()
        try {
          if (new URL(url).protocol !== 'https:') throw new Error()
        } catch {
          throw new Error('Укажите корректную ссылку на HTTPS-таблицу стилей.')
        }
        const families = await inspectRemoteFont(url)
        const createdAt = new Date().toISOString()
        additions = families.map(({ family, variants }) => ({
          id: crypto.randomUUID(),
          name: family,
          family,
          source: { kind: 'remote', url },
          variants,
          createdAt,
        }))
      }

      const next = await addFonts(settings, additions)
      uploadedPath = undefined
      setFonts(next)
      setShowAdd(false)
      if (selectedFontId) window.location.hash = '#/'
      setNotice(additions.length === 1
        ? `«${additions[0].name}» добавлен в библиотеку.`
        : `Добавлено семейств: ${additions.map((font) => font.name).join(', ')}.`)
    } catch (cause) {
      let message = cause instanceof Error ? cause.message : 'Не удалось добавить шрифт.'
      if (uploadedPath) {
        try {
          await deleteFontFile(settings, uploadedPath)
        } catch (cleanupCause) {
          message += ` Файл ${uploadedPath} остался в репозитории: ${cleanupCause instanceof Error ? cleanupCause.message : 'неизвестная ошибка'}.`
        }
      }
      setError(message)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(font: FontRecord) {
    if (!window.confirm(`Удалить «${font.name}» из библиотеки?`)) return

    setSaving(true)
    setError('')
    setNotice('')

    try {
      const next = await removeFont(settings, font.id, font.name)
      setFonts(next)
      if (selectedFontId === font.id) window.location.hash = '#/'

      if (font.source.kind === 'file') {
        try {
          await deleteFontFile(settings, font.source.path)
        } catch (cause) {
          setNotice(
            `Шрифт удалён из списка, но файл в репозитории удалить не удалось: ${cause instanceof Error ? cause.message : 'неизвестная ошибка'}`,
          )
          return
        }
      }

      setNotice(`«${font.name}» удалён.`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось удалить шрифт.')
    } finally {
      setSaving(false)
    }
  }

  const configured = Boolean(settings.owner && settings.repo)
  const canEdit = Boolean(settings.token)

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#/" aria-label="Коллекция — главная">
          <span className="brand-mark">Aa</span>
          <span>type<span className="brand-dot">.</span>library</span>
        </a>
        <div className="topbar-actions">
          <button className="button button-quiet" onClick={() => setShowSettings(true)}>
            <SettingsIcon />
            Настройки
            {canEdit && <span className="connected-dot" aria-label="Токен подключён" />}
          </button>
          <button
            className="button button-primary"
            onClick={() => {
              setError('')
              setShowAdd(true)
            }}
            disabled={!configured || !canEdit || saving}
            title={!configured ? 'Сначала настройте репозиторий' : !canEdit ? 'Добавьте токен в настройках' : undefined}
          >
            <span className="plus">+</span>
            Добавить шрифт
          </button>
        </div>
      </header>

      <main className="main-content">
        {selectedFontId ? (
          selectedFont ? (
            <FontDetail
              font={selectedFont}
              error={error}
              notice={notice}
              canEdit={canEdit}
              saving={saving}
              onDelete={() => void handleDelete(selectedFont)}
            />
          ) : loading ? (
            <div className="loading-state"><span className="spinner" />Загружаем шрифт…</div>
          ) : (
            <section className="font-not-found">
              <a className="back-link" href="#/">← Все шрифты</a>
              <h1>Шрифт не найден</h1>
              <p>Возможно, его удалили из библиотеки.</p>
            </section>
          )
        ) : (
          <>
        <section className="intro">
          <div className="eyebrow"><span className="eyebrow-line" /> ВАША ЛИЧНАЯ КОЛЛЕКЦИЯ</div>
          <h1>Шрифты, которые<br /><span>говорят за вас.</span></h1>
          <p>Личная библиотека гарнитур — сохранённая в GitHub и доступная отовсюду.</p>
        </section>

        <section className="library-section" aria-label="Библиотека шрифтов">
          <div className="section-heading">
            <div>
              <h2>Моя коллекция <span className="count">{fonts.length.toString().padStart(2, '0')}</span></h2>
              <p>Откройте карточку, чтобы увидеть все варианты</p>
            </div>
            {configured && (
              <div className="repo-label"><span className="repo-icon">⌘</span>{settings.owner}/{settings.repo}</div>
            )}
          </div>

          {(error || notice) && (
            <div className={`feedback ${error ? 'feedback-error' : 'feedback-success'}`} role="status">
              <span>{error || notice}</span>
              {error && configured && (
                <button className="text-button" onClick={() => setShowSettings(true)}>Проверить настройки</button>
              )}
            </div>
          )}

          {!configured && (
            <div className="setup-callout">
              <div className="callout-icon"><SettingsIcon /></div>
              <div>
                <strong>Подключите репозиторий</strong>
                <p>Укажите GitHub-репозиторий, где хранится список шрифтов.</p>
              </div>
              <button className="button button-secondary" onClick={() => setShowSettings(true)}>Настроить</button>
            </div>
          )}

          {configured && loading ? (
            <div className="loading-state"><span className="spinner" />Загружаем коллекцию…</div>
          ) : fonts.length > 0 ? (
            <div className="font-grid">
              {fonts.map((font, index) => {
                const primaryVariant = getFontVariants(font)[0]
                return (
                <article className="font-card" key={font.id}>
                  <div className="card-topline">
                    <span className="font-index">{String(index + 1).padStart(2, '0')}</span>
                    <button className="icon-button delete-button" onClick={() => void handleDelete(font)} disabled={!canEdit || saving} aria-label={`Удалить ${font.name}`} title={canEdit ? 'Удалить шрифт' : 'Добавьте токен в настройках'}>
                      <TrashIcon />
                    </button>
                  </div>
                  <a className="font-card-link" href={`#/font/${encodeURIComponent(font.id)}`} aria-label={`Открыть семейство ${font.name}`}>
                    <div
                      className="font-preview"
                      style={{
                        fontFamily: `"${font.family}", Georgia, serif`,
                        fontWeight: primaryVariant.weightMin,
                        fontStyle: primaryVariant.style,
                      }}
                    >
                      Ag
                    </div>
                    <div className="card-bottom">
                      <div>
                        <h3>{font.name}</h3>
                        <p>{font.family}</p>
                        <p className="variant-count">{formatVariantCount(getFontVariants(font).length)}</p>
                      </div>
                      <span className="source-tag">{font.source.kind === 'file' ? 'ФАЙЛ' : 'ССЫЛКА'}</span>
                    </div>
                    <div className="sample-line" style={{ fontFamily: `"${font.family}", Georgia, serif` }}>
                      Съешь ещё этих мягких французских булок
                    </div>
                  </a>
                </article>
                )
              })}
            </div>
          ) : configured && !error ? (
            <div className="empty-state">
              <div className="empty-glyph">Aa</div>
              <h3>{settings.owner && settings.repo ? 'Коллекция пока пуста' : 'Подключите репозиторий'}</h3>
              <p>{canEdit ? 'Добавьте первую гарнитуру — она появится здесь.' : 'Добавьте GitHub-токен, чтобы управлять коллекцией.'}</p>
              {canEdit && <button className="button button-secondary" onClick={() => setShowAdd(true)}>Добавить первый шрифт <span>↗</span></button>}
            </div>
          ) : null}
        </section>
          </>
        )}
      </main>

      <footer className="footer">
        <span>ВАША ТИПОГРАФИКА. ВАШИ ПРАВИЛА.</span>
        <span>Питается GitHub Pages <span className="footer-heart">✳</span></span>
      </footer>

      {showSettings && (
        <SettingsDialog settings={settings} onClose={() => setShowSettings(false)} onSave={persistSettings} />
      )}
      {showAdd && (
        <AddFontDialog onClose={() => setShowAdd(false)} onSubmit={handleAdd} saving={saving} />
      )}
    </div>
  )
}

function SettingsDialog({
  settings,
  onClose,
  onSave,
}: {
  settings: RepositorySettings
  onClose: () => void
  onSave: (settings: RepositorySettings) => void
}) {
  const [draft, setDraft] = useState(settings)

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onSave({
      owner: draft.owner.trim(),
      repo: draft.repo.trim(),
      branch: draft.branch.trim() || 'main',
      token: draft.token.trim(),
    })
  }

  return (
    <Dialog title="Настройки репозитория" onClose={onClose}>
      <form className="dialog-form" onSubmit={submit}>
        <p className="dialog-description">Укажите репозиторий, в котором хранится <code>public/fonts.json</code>.</p>
        <div className="field-row">
          <label className="field">
            <span>Владелец</span>
            <input required value={draft.owner} onChange={(event) => setDraft({ ...draft, owner: event.target.value })} placeholder="username" autoComplete="off" />
          </label>
          <label className="field">
            <span>Репозиторий</span>
            <input required value={draft.repo} onChange={(event) => setDraft({ ...draft, repo: event.target.value })} placeholder="my-fonts" autoComplete="off" />
          </label>
        </div>
        <label className="field">
          <span>Ветка</span>
          <input required value={draft.branch} onChange={(event) => setDraft({ ...draft, branch: event.target.value })} placeholder="main" autoComplete="off" />
        </label>
        <label className="field">
          <span>Fine-grained GitHub token <em>необязательно для просмотра</em></span>
          <input type="password" value={draft.token} onChange={(event) => setDraft({ ...draft, token: event.target.value })} placeholder="github_pat_…" autoComplete="new-password" />
        </label>
        <div className="security-note">
          <span className="lock-icon">⌑</span>
          <p>Токен остаётся в localStorage этого браузера и не попадает в GitHub Pages. Создайте fine-grained token только для этого репозитория с разрешением <b>Contents: Read and write</b>. Не вводите токен на чужих копиях сайта.</p>
        </div>
        <div className="dialog-actions">
          <button type="button" className="button button-quiet" onClick={onClose}>Отмена</button>
          <button type="submit" className="button button-primary">Сохранить настройки</button>
        </div>
      </form>
    </Dialog>
  )
}

function AddFontDialog({
  onClose,
  onSubmit,
  saving,
}: {
  onClose: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  saving: boolean
}) {
  const [kind, setKind] = useState<'remote' | 'file'>('remote')

  return (
    <Dialog title="Новый шрифт" onClose={onClose}>
      <form className="dialog-form" onSubmit={onSubmit}>
        <p className="dialog-description">Добавьте веб-шрифт по ссылке или загрузите файл в репозиторий.</p>
        <input type="hidden" name="kind" value={kind} />
        <div className="segmented-control" role="tablist" aria-label="Способ добавления">
          <button type="button" className={kind === 'remote' ? 'selected' : ''} onClick={() => setKind('remote')}>По ссылке</button>
          <button type="button" className={kind === 'file' ? 'selected' : ''} onClick={() => setKind('file')}>Загрузить файл</button>
        </div>
        {kind === 'remote' ? (
          <>
            <label className="field">
              <span>HTTPS-ссылка на CSS</span>
              <input name="url" type="url" required placeholder="https://fonts.googleapis.com/css2?family=…" autoFocus />
              <small>Семейства, начертания и веса будут определены автоматически из @font-face.</small>
            </label>
            <div className="parser-note">Если в ссылке несколько семейств, для каждого появится отдельная карточка.</div>
          </>
        ) : (
          <>
            <label className="field">
              <span>Название в коллекции</span>
              <input name="name" required placeholder="Например, Editorial New" autoFocus />
            </label>
            <label className="field">
              <span>Имя семейства CSS</span>
              <input name="family" required placeholder="Например, Editorial New" />
            </label>
            <label className="file-drop">
              <input name="file" type="file" required accept=".woff,.woff2,.ttf,.otf" />
              <span className="upload-icon">↑</span>
              <b>Выберите файл шрифта</b>
              <span>WOFF, WOFF2, TTF или OTF · до 10 МБ</span>
            </label>
          </>
        )}
        <div className="dialog-actions">
          <button type="button" className="button button-quiet" onClick={onClose} disabled={saving}>Отмена</button>
          <button type="submit" className="button button-primary" disabled={saving}>{saving ? 'Сохраняем…' : 'Добавить шрифт'}</button>
        </div>
      </form>
    </Dialog>
  )
}

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <div className="dialog-header">
          <h2 id="dialog-title">{title}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Закрыть">×</button>
        </div>
        {children}
      </section>
    </div>
  )
}

function FontDetail({
  font,
  error,
  notice,
  canEdit,
  saving,
  onDelete,
}: {
  font: FontRecord
  error: string
  notice: string
  canEdit: boolean
  saving: boolean
  onDelete: () => void
}) {
  const variants = getFontVariants(font)
  const firstVariant = variants[0]

  return (
    <section className="font-detail">
      <a className="back-link" href="#/">← Все шрифты</a>
      <div className="detail-title-row">
        <div>
          <div className="eyebrow"><span className="eyebrow-line" /> СЕМЕЙСТВО ШРИФТА</div>
          <h1>{font.name}</h1>
          <p>{formatVariantCount(variants.length)} · {font.family}</p>
        </div>
        <button
          className="button button-secondary detail-delete"
          onClick={onDelete}
          disabled={!canEdit || saving}
        >
          <TrashIcon />
          Удалить семейство
        </button>
      </div>

      {(error || notice) && (
        <div className={`feedback ${error ? 'feedback-error' : 'feedback-success'}`} role="status">
          {error || notice}
        </div>
      )}

      <div
        className="detail-specimen"
        style={{
          fontFamily: `"${font.family}", Georgia, serif`,
          fontWeight: firstVariant.weightMin,
          fontStyle: firstVariant.style,
        }}
      >
        <span className="detail-specimen-label">Aa</span>
        <span className="detail-specimen-text">Ag</span>
        <span className="detail-specimen-caption">Панграмма: Съешь ещё этих мягких французских булок</span>
      </div>

      <div className="variant-section-heading">
        <div>
          <h2>Начертания <span className="count">{String(variants.length).padStart(2, '0')}</span></h2>
          <p>Все варианты, объявленные в таблице @font-face</p>
        </div>
      </div>

      <div className="variant-grid">
        {variants.map((variant) => (
          <VariantPreview key={`${variant.style}-${variant.weightMin}-${variant.weightMax}`} font={font} variant={variant} />
        ))}
      </div>
    </section>
  )
}

function VariantPreview({ font, variant }: { font: FontRecord; variant: FontVariant }) {
  const [weight, setWeight] = useState(variant.weightMin)
  const isVariable = variant.weightMin < variant.weightMax

  return (
    <article className="variant-card">
      <div className="variant-card-header">
        <div>
          <span className="variant-label">{variantLabel(variant)}</span>
          <h3>{fontStyleName(variant.style)}</h3>
        </div>
        <span className="weight-badge">
          {isVariable ? `${variant.weightMin}–${variant.weightMax}` : variant.weightMin}
        </span>
      </div>
      <div
        className="variant-sample"
        style={{
          fontFamily: `"${font.family}", Georgia, serif`,
          fontWeight: weight,
          fontStyle: variant.style,
        }}
      >
        <span className="variant-sample-large">Aa Bb</span>
        <span className="variant-sample-copy">The quick brown fox jumps over the lazy dog</span>
        <span className="variant-sample-copy">Съешь ещё этих мягких французских булок 0123456789</span>
      </div>
      {isVariable && (
        <label className="weight-control">
          <span>Light</span>
          <input
            type="range"
            min={variant.weightMin}
            max={variant.weightMax}
            step="1"
            value={weight}
            aria-label={`Вес ${font.family}`}
            onChange={(event) => setWeight(Number(event.target.value))}
          />
          <span>Bold</span>
          <output>{weight}</output>
        </label>
      )}
    </article>
  )
}

function getFontVariants(font: FontRecord) {
  return font.variants?.length ? font.variants : [defaultVariant]
}

function formatVariantCount(count: number) {
  const tens = count % 100
  const ones = count % 10
  const word = tens >= 11 && tens <= 14
    ? 'вариантов'
    : ones === 1
      ? 'вариант'
      : ones >= 2 && ones <= 4
        ? 'варианта'
        : 'вариантов'
  return `${count} ${word}`
}

function variantLabel(variant: FontVariant) {
  const weightNames: Record<number, string> = {
    100: 'Thin',
    200: 'ExtraLight',
    300: 'Light',
    400: 'Regular',
    500: 'Medium',
    600: 'SemiBold',
    700: 'Bold',
    800: 'ExtraBold',
    900: 'Black',
  }
  const weight = variant.weightMin === variant.weightMax
    ? `${weightNames[variant.weightMin] ?? 'Weight'} · ${variant.weightMin}`
    : `Variable · ${variant.weightMin}–${variant.weightMax}`
  const style = variant.style === 'normal'
    ? ''
    : variant.style.startsWith('oblique')
      ? 'Наклонный'
      : 'Курсив'
  return [style, weight].filter(Boolean).join(' · ')
}

function fontStyleName(style: string) {
  if (style === 'normal') return 'Прямое начертание'
  if (style === 'italic') return 'Курсивное начертание'
  if (style.startsWith('oblique')) return 'Наклонное начертание'
  return style
}

function fontFormat(path: string) {
  const extension = path.split('.').pop()?.toLowerCase()
  return extension === 'woff2' ? 'woff2' : extension === 'woff' ? 'woff' : extension === 'otf' ? 'opentype' : 'truetype'
}

function escapeCssString(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\n\r]/g, '')
}

function SettingsIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 7.3a2.7 2.7 0 1 0 0 5.4 2.7 2.7 0 0 0 0-5.4Z" /><path d="m16.5 11.2 1.1.9-1.6 2.8-1.4-.5a6.8 6.8 0 0 1-1.4.8l-.3 1.5H7.2l-.3-1.5a6.8 6.8 0 0 1-1.4-.8l-1.4.5-1.6-2.8 1.1-.9a6 6 0 0 1 0-1.6l-1.1-.9 1.6-2.8 1.4.5a6.8 6.8 0 0 1 1.4-.8l.3-1.5h5.7l.3 1.5a6.8 6.8 0 0 1 1.4.8l1.4-.5 1.6 2.8-1.1.9a6 6 0 0 1 0 1.6Z" /></svg>
}

function TrashIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 6.2h11M8 6.2V4.5h4v1.7m2.2 0-.6 9.3H6.4l-.6-9.3m3.1 2.2v4.8m2.2-4.8v4.8" /></svg>
}

export default App
