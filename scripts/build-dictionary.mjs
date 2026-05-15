import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const repoRoot = process.cwd()
const manifestPath = path.join(repoRoot, 'dictionary-src', 'manifest.json')
const outputPath = path.join(repoRoot, 'src-tauri', 'resources', 'dictionary_seed.json')

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeText(value) {
    if (typeof value !== 'string') return ''
    return value.trim().replace(/\s+/g, ' ')
}

function normalizeExamples(value) {
    if (!Array.isArray(value)) return []
    return [...new Set(value.map(normalizeText).filter(Boolean))]
}

function normalizeSense(sense) {
    const definition = normalizeText(sense?.definition)
    if (!definition) {
        throw new Error('Sense definition is required')
    }

    const partOfSpeech = normalizeText(sense?.partOfSpeech || sense?.part_of_speech) || undefined
    return {
        definition,
        ...(partOfSpeech ? { partOfSpeech } : {}),
        examples: normalizeExamples(sense?.examples),
    }
}

function normalizeEntry(rawEntry, sourceLabel) {
    if (!isObject(rawEntry)) {
        throw new Error(`Invalid dictionary entry in ${sourceLabel}`)
    }

    const term = normalizeText(rawEntry.term)
    const sourceLanguage = normalizeText(rawEntry.sourceLanguage)
    const targetLanguage = normalizeText(rawEntry.targetLanguage)
    if (!term || !sourceLanguage || !targetLanguage) {
        throw new Error(`Entry is missing term/sourceLanguage/targetLanguage in ${sourceLabel}`)
    }

    const senses = Array.isArray(rawEntry.senses)
        ? rawEntry.senses.map(normalizeSense)
        : []

    if (!senses.length) {
        throw new Error(`Entry ${term} has no valid senses in ${sourceLabel}`)
    }

    const aliases = Array.isArray(rawEntry.aliases)
        ? [...new Set(rawEntry.aliases.map(normalizeText).filter(Boolean))]
        : []

    const tags = Array.isArray(rawEntry.tags)
        ? [...new Set(rawEntry.tags.map(normalizeText).filter(Boolean))]
        : []

    const normalized = {
        term,
        sourceLanguage,
        targetLanguage,
        ...(normalizeText(rawEntry.pronunciation) ? { pronunciation: normalizeText(rawEntry.pronunciation) } : {}),
        ...(normalizeText(rawEntry.phonetic) ? { phonetic: normalizeText(rawEntry.phonetic) } : {}),
        ...(tags.length ? { tags } : { tags: [] }),
        ...(rawEntry.isPhrase ? { isPhrase: true } : {}),
        ...(Number.isFinite(rawEntry.weight) ? { weight: Number(rawEntry.weight) } : {}),
        ...(aliases.length ? { aliases } : {}),
        senses,
    }

    return normalized
}

function mergeEntry(existing, incoming) {
    const mergedAliases = [...new Set([...(existing.aliases ?? []), ...(incoming.aliases ?? [])])]
    const mergedTags = [...new Set([...(existing.tags ?? []), ...(incoming.tags ?? [])])]
    const seenSenses = new Set()
    const mergedSenses = []
    for (const sense of [...existing.senses, ...incoming.senses]) {
        const key = `${sense.definition}::${sense.partOfSpeech ?? ''}`
        if (seenSenses.has(key)) continue
        seenSenses.add(key)
        mergedSenses.push(sense)
    }

    return {
        ...existing,
        pronunciation: existing.pronunciation ?? incoming.pronunciation,
        phonetic: existing.phonetic ?? incoming.phonetic,
        weight: Math.max(existing.weight ?? 0, incoming.weight ?? 0),
        isPhrase: existing.isPhrase || incoming.isPhrase,
        aliases: mergedAliases.length ? mergedAliases : undefined,
        tags: mergedTags,
        senses: mergedSenses,
    }
}

async function loadJson(filePath) {
    const content = await readFile(filePath, 'utf8')
    return JSON.parse(content)
}

function resolveInputEntries(payload, filePath) {
    if (Array.isArray(payload)) return payload
    if (isObject(payload) && Array.isArray(payload.entries)) return payload.entries
    throw new Error(`Input file ${filePath} must be an array or an object with entries`)
}

async function main() {
    const manifest = await loadJson(manifestPath)
    if (!isObject(manifest)) {
        throw new Error('dictionary-src/manifest.json must be an object')
    }

    const sources = Array.isArray(manifest.sources) ? manifest.sources : []
    if (!sources.length) {
        throw new Error('dictionary-src/manifest.json must define at least one source')
    }

    const mergedEntries = new Map()
    for (const source of sources) {
        const relativePath = normalizeText(source)
        if (!relativePath) continue
        const absolutePath = path.resolve(repoRoot, relativePath)
        const payload = await loadJson(absolutePath)
        const entries = resolveInputEntries(payload, relativePath)
        for (const rawEntry of entries) {
            const entry = normalizeEntry(rawEntry, relativePath)
            const key = `${entry.term}::${entry.sourceLanguage}::${entry.targetLanguage}::${entry.isPhrase ? 'phrase' : 'word'}`
            const existing = mergedEntries.get(key)
            mergedEntries.set(key, existing ? mergeEntry(existing, entry) : entry)
        }
    }

    const entries = [...mergedEntries.values()]
        .sort((left, right) => {
            const phraseWeight = Number(Boolean(right.isPhrase)) - Number(Boolean(left.isPhrase))
            if (phraseWeight !== 0) return phraseWeight
            const sourceCompare = left.sourceLanguage.localeCompare(right.sourceLanguage)
            if (sourceCompare !== 0) return sourceCompare
            return left.term.localeCompare(right.term, 'zh-Hans-CN')
        })

    const output = {
        version: normalizeText(manifest.version) || new Date().toISOString().slice(0, 10),
        sourceLabel: normalizeText(manifest.sourceLabel) || 'Tool Box Offline Lexicon',
        languagePairs: Array.isArray(manifest.languagePairs) ? manifest.languagePairs.map(normalizeText).filter(Boolean) : ['zh-en', 'en-zh'],
        features: Array.isArray(manifest.features) ? manifest.features.map(normalizeText).filter(Boolean) : [],
        generatedAt: new Date().toISOString(),
        packageCount: sources.length,
        entries,
    }

    await mkdir(path.dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8')

    const phraseCount = entries.filter((entry) => entry.isPhrase).length
    console.log(`Dictionary built: ${entries.length} entries, ${phraseCount} phrases -> ${path.relative(repoRoot, outputPath)}`)
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
})
