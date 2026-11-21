export type FontRecord = {
  id: string
  name: string
  family: string
  source: { kind: 'remote'; url: string } | { kind: 'file'; path: string }
  createdAt: string
}

type FontManifest = { version: 1; fonts: FontRecord[] }
type PublicRepositorySettings = Pick<RepositorySettings, 'owner' | 'repo' | 'branch'>

export type RepositorySettings = {
  owner: string
  repo: string
  branch: string
  token: string
}

const apiBase = 'https://api.github.com'

function contentsUrl(settings: RepositorySettings, path: string) {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/')
  return `${apiBase}/repos/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.repo)}/contents/${encodedPath}`
}

function authHeaders(settings: RepositorySettings) {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(settings.token ? { Authorization: `Bearer ${settings.token}` } : {}),
  }
}

async function readApiError(response: Response) {
  try {
    const body = await response.json() as { message?: string }
    return body.message || response.statusText
  } catch {
    return response.statusText
  }
}

function ensureWritable(settings: RepositorySettings) {
  if (!settings.token) {
    throw new Error('Для изменения библиотеки добавьте fine-grained GitHub token в настройках.')
  }
}

function branchQuery(branch: string) {
  return `?ref=${encodeURIComponent(branch)}`
}

export async function loadFonts(settings: PublicRepositorySettings): Promise<FontRecord[]> {
  const branch = settings.branch.split('/').map(encodeURIComponent).join('/')
  const url = `https://raw.githubusercontent.com/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.repo)}/${branch}/public/fonts.json`
  const response = await fetch(url, { cache: 'no-store' })

  if (response.status === 404) return []
  if (!response.ok) {
    throw new Error(`Не удалось прочитать список шрифтов (${response.status}). Проверьте владельца, репозиторий и ветку.`)
  }

  const manifest: unknown = await response.json()
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !('version' in manifest) ||
    manifest.version !== 1 ||
    !('fonts' in manifest) ||
    !Array.isArray(manifest.fonts) ||
    !manifest.fonts.every(isFontRecord)
  ) {
    throw new Error('Файл public/fonts.json имеет неверный формат.')
  }

  return manifest.fonts
}

function isFontRecord(value: unknown): value is FontRecord {
  if (typeof value !== 'object' || value === null) return false
  if (!('id' in value) || typeof value.id !== 'string' || !value.id) return false
  if (!('name' in value) || typeof value.name !== 'string' || !value.name) return false
  if (!('family' in value) || typeof value.family !== 'string' || !value.family) return false
  if (!('createdAt' in value) || typeof value.createdAt !== 'string') return false
  if (!('source' in value) || typeof value.source !== 'object' || value.source === null) return false
  if (!('kind' in value.source)) return false
  if (value.source.kind === 'remote') {
    if (!('url' in value.source) || typeof value.source.url !== 'string') return false
    try {
      return new URL(value.source.url).protocol === 'https:'
    } catch {
      return false
    }
  }
  if (value.source.kind === 'file') {
    return 'path' in value.source &&
      typeof value.source.path === 'string' &&
      value.source.path.startsWith('public/fonts/') &&
      !value.source.path.split('/').includes('..')
  }
  return false
}

async function getFileSha(settings: RepositorySettings, path: string): Promise<string | undefined> {
  const response = await fetch(`${contentsUrl(settings, path)}${branchQuery(settings.branch)}`, {
    headers: authHeaders(settings),
  })

  if (response.status === 404) return undefined
  if (!response.ok) {
    throw new Error(`GitHub не смог прочитать ${path}: ${await readApiError(response)}`)
  }

  const file = await response.json() as { sha: string }
  return file.sha
}

function encodeBase64(bytes: Uint8Array) {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

async function putFile(
  settings: RepositorySettings,
  path: string,
  content: string,
  message: string,
) {
  ensureWritable(settings)
  const sha = await getFileSha(settings, path)
  const response = await fetch(contentsUrl(settings, path), {
    method: 'PUT',
    headers: { ...authHeaders(settings), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content,
      branch: settings.branch,
      ...(sha ? { sha } : {}),
    }),
  })

  if (!response.ok) {
    throw new Error(`GitHub не сохранил ${path}: ${await readApiError(response)}`)
  }
}

export async function saveFonts(
  settings: RepositorySettings,
  fonts: FontRecord[],
  message: string,
) {
  const manifest: FontManifest = { version: 1, fonts }
  const bytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`)
  await putFile(settings, 'public/fonts.json', encodeBase64(bytes), message)
}

export async function uploadFontFile(
  settings: RepositorySettings,
  file: File,
  id: string,
) {
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '-')
  const path = `public/fonts/${id}-${safeName}`
  const bytes = new Uint8Array(await file.arrayBuffer())
  await putFile(settings, path, encodeBase64(bytes), `Upload font: ${file.name}`)
  return path
}

export async function deleteFontFile(settings: RepositorySettings, path: string) {
  ensureWritable(settings)
  const sha = await getFileSha(settings, path)
  if (!sha) return

  const response = await fetch(contentsUrl(settings, path), {
    method: 'DELETE',
    headers: { ...authHeaders(settings), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `Remove font file: ${path.split('/').pop()}`,
      sha,
      branch: settings.branch,
    }),
  })

  if (!response.ok) {
    throw new Error(`GitHub не удалил файл ${path}: ${await readApiError(response)}`)
  }
}
