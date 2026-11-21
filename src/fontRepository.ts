export type FontRecord = {
  id: string
  name: string
  family: string
  source: { kind: 'remote'; url: string } | { kind: 'file'; path: string }
  createdAt: string
}

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
  return `?ref=${encodeURIComponent(branch)}&_=${Date.now()}`
}

export async function loadFonts(settings: PublicRepositorySettings): Promise<FontRecord[]> {
  const branch = settings.branch.split('/').map(encodeURIComponent).join('/')
  const url = `https://raw.githubusercontent.com/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.repo)}/${branch}/public/fonts.json?t=${Date.now()}`
  const response = await fetch(url, { cache: 'no-store' })

  if (response.status === 404) return []
  if (!response.ok) {
    throw new Error(`Не удалось прочитать список шрифтов (${response.status}). Проверьте владельца, репозиторий и ветку.`)
  }

  return parseFonts(await response.json())
}

function parseFonts(manifest: unknown): FontRecord[] {
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

type GitHubFile = { sha: string; content?: string; encoding?: string }

async function getFile(settings: RepositorySettings, path: string): Promise<GitHubFile | undefined> {
  const response = await fetch(`${contentsUrl(settings, path)}${branchQuery(settings.branch)}`, {
    cache: 'no-store',
    headers: authHeaders(settings),
  })

  if (response.status === 404) return undefined
  if (!response.ok) {
    throw new Error(`GitHub не смог прочитать ${path}: ${await readApiError(response)}`)
  }

  return await response.json() as GitHubFile
}

async function getFileSha(settings: RepositorySettings, path: string): Promise<string | undefined> {
  return (await getFile(settings, path))?.sha
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

function decodeBase64(value: string) {
  const binary = atob(value.replace(/\s/g, ''))
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

function isShaConflict(status: number, message: string) {
  return status === 409 || (status === 422 && /sha|does not match/i.test(message))
}

async function updateFonts(
  settings: RepositorySettings,
  update: (fonts: FontRecord[]) => FontRecord[],
  message: string,
): Promise<FontRecord[]> {
  ensureWritable(settings)

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const file = await getFile(settings, 'public/fonts.json')
    let fonts: FontRecord[] = []

    if (file) {
      if (!file.content || file.encoding !== 'base64') {
        throw new Error('GitHub вернул public/fonts.json в неподдерживаемом формате.')
      }
      try {
        fonts = parseFonts(JSON.parse(decodeBase64(file.content)))
      } catch (cause) {
        throw new Error(
          `Не удалось прочитать public/fonts.json: ${cause instanceof Error ? cause.message : 'неверный JSON'}`,
        )
      }
    }

    const nextFonts = update(fonts)
    if (nextFonts.length === fonts.length && nextFonts.every((font, index) => font === fonts[index])) {
      return fonts
    }
    const content = encodeBase64(
      new TextEncoder().encode(`${JSON.stringify({ version: 1, fonts: nextFonts }, null, 2)}\n`),
    )
    const response = await fetch(contentsUrl(settings, 'public/fonts.json'), {
      method: 'PUT',
      cache: 'no-store',
      headers: { ...authHeaders(settings), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        content,
        branch: settings.branch,
        ...(file ? { sha: file.sha } : {}),
      }),
    })

    if (response.ok) return nextFonts

    const error = await readApiError(response)
    if (attempt < 2 && isShaConflict(response.status, error)) {
      continue
    }
    throw new Error(`GitHub не сохранил public/fonts.json: ${error}`)
  }

  throw new Error('Не удалось обновить список: файл изменяется одновременно. Повторите попытку.')
}

export async function addFont(settings: RepositorySettings, font: FontRecord) {
  return updateFonts(settings, (fonts) => [font, ...fonts.filter((item) => item.id !== font.id)], `Add font: ${font.name}`)
}

export async function removeFont(settings: RepositorySettings, id: string, name: string) {
  return updateFonts(settings, (fonts) => fonts.filter((font) => font.id !== id), `Remove font: ${name}`)
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
