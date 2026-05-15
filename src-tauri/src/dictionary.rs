use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, ToSql};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use thiserror::Error;

const DEFAULT_SEED_JSON: &str = include_str!("../resources/dictionary_seed.json");
const DEFAULT_QUERY_LIMIT: usize = 8;
const DASHBOARD_LIMIT: usize = 10;

#[derive(Debug, Error)]
pub enum DictionaryError {
    #[error("词典资源初始化失败: {0}")]
    Io(#[from] std::io::Error),
    #[error("词典数据库错误: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("词典种子数据错误: {0}")]
    Json(#[from] serde_json::Error),
    #[error("请求参数无效: {0}")]
    InvalidInput(String),
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum QueryDirection {
    Auto,
    ZhToEn,
    EnToZh,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ResolvedDirection {
    ZhToEn,
    EnToZh,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SourceLanguage {
    Zh,
    En,
}

impl SourceLanguage {
    fn as_str(self) -> &'static str {
        match self {
            Self::Zh => "zh",
            Self::En => "en",
        }
    }
}

impl ResolvedDirection {
    fn source_language(self) -> SourceLanguage {
        match self {
            Self::ZhToEn => SourceLanguage::Zh,
            Self::EnToZh => SourceLanguage::En,
        }
    }

    fn target_language(self) -> SourceLanguage {
        match self {
            Self::ZhToEn => SourceLanguage::En,
            Self::EnToZh => SourceLanguage::Zh,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SeedDictionary {
    version: String,
    source_label: String,
    language_pairs: Vec<String>,
    features: Vec<String>,
    #[serde(default)]
    generated_at: Option<String>,
    #[serde(default)]
    package_count: Option<usize>,
    entries: Vec<SeedEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SeedEntry {
    term: String,
    source_language: SourceLanguage,
    target_language: SourceLanguage,
    pronunciation: Option<String>,
    phonetic: Option<String>,
    tags: Vec<String>,
    #[serde(default)]
    is_phrase: bool,
    #[serde(default = "default_weight")]
    weight: i64,
    #[serde(default)]
    aliases: Vec<String>,
    senses: Vec<SeedSense>,
}

#[derive(Debug, Deserialize)]
struct SeedSense {
    definition: String,
    #[serde(rename = "partOfSpeech")]
    part_of_speech: Option<String>,
    #[serde(default)]
    examples: Vec<String>,
}

fn default_weight() -> i64 {
    80
}

fn seed_identity(seed: &SeedDictionary) -> String {
    format!(
        "{}::{}::{}::{}",
        seed.version,
        seed.generated_at.as_deref().unwrap_or("none"),
        seed.package_count.unwrap_or(1),
        seed.entries.len()
    )
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryMetadata {
    pub version: String,
    pub entry_count: usize,
    pub phrase_count: usize,
    pub language_pairs: Vec<String>,
    pub features: Vec<String>,
    pub source_label: String,
    pub generated_at: Option<String>,
    pub package_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FavoriteEntry {
    pub id: i64,
    pub query: String,
    pub direction: ResolvedDirection,
    pub translation: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: i64,
    pub query: String,
    pub normalized_query: String,
    pub direction: ResolvedDirection,
    pub result_count: usize,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionarySettings {
    pub default_direction: QueryDirection,
    pub auto_copy_primary: bool,
    pub compact_result_view: bool,
    pub max_history_items: usize,
}

impl Default for DictionarySettings {
    fn default() -> Self {
        Self {
            default_direction: QueryDirection::Auto,
            auto_copy_primary: false,
            compact_result_view: false,
            max_history_items: 40,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryVariantSummary {
    pub id: i64,
    pub definition: String,
    pub part_of_speech: Option<String>,
    pub examples: Vec<String>,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryEntrySummary {
    pub id: i64,
    pub term: String,
    pub normalized_term: String,
    pub source_language: SourceLanguage,
    pub target_language: SourceLanguage,
    pub pronunciation: Option<String>,
    pub phonetic: Option<String>,
    pub tags: Vec<String>,
    pub aliases: Vec<String>,
    pub is_phrase: bool,
    pub score: f64,
    pub primary_translation: String,
    pub variants: Vec<DictionaryVariantSummary>,
    pub matched_by: String,
    pub match_reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationResult {
    pub query: String,
    pub normalized_query: String,
    pub direction: ResolvedDirection,
    pub detected_source_language: SourceLanguage,
    pub phrase_hits: Vec<DictionaryEntrySummary>,
    pub exact_hits: Vec<DictionaryEntrySummary>,
    pub fuzzy_hits: Vec<DictionaryEntrySummary>,
    pub suggestions: Vec<String>,
    pub total_hits: usize,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationQueryRequest {
    pub query: String,
    pub direction: QueryDirection,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FavoritePayload {
    pub query: String,
    pub direction: ResolvedDirection,
    pub translation: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryDashboard {
    pub metadata: DictionaryMetadata,
    pub settings: DictionarySettings,
    pub favorites: Vec<FavoriteEntry>,
    pub history: Vec<HistoryEntry>,
}

#[derive(Debug, Clone)]
pub struct DictionaryService {
    db_path: PathBuf,
}

impl DictionaryService {
    pub fn initialize(app: &AppHandle) -> Result<Self, DictionaryError> {
        let app_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| DictionaryError::InvalidInput(error.to_string()))?;
        fs::create_dir_all(&app_dir)?;
        let db_path = app_dir.join("offline_dictionary.sqlite3");
        initialize_database(&db_path)?;
        Ok(Self { db_path })
    }

    fn open_connection(&self) -> Result<Connection, DictionaryError> {
        let connection = Connection::open(&self.db_path)?;
        connection.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
        Ok(connection)
    }

    pub fn metadata(&self) -> Result<DictionaryMetadata, DictionaryError> {
        let connection = self.open_connection()?;
        load_metadata(&connection)
    }

    pub fn dashboard(&self) -> Result<DictionaryDashboard, DictionaryError> {
        let connection = self.open_connection()?;
        Ok(DictionaryDashboard {
            metadata: load_metadata(&connection)?,
            settings: load_settings(&connection)?,
            favorites: load_favorites(&connection, DASHBOARD_LIMIT)?,
            history: load_history(&connection, DASHBOARD_LIMIT)?,
        })
    }

    pub fn query_translation(
        &self,
        request: TranslationQueryRequest,
    ) -> Result<TranslationResult, DictionaryError> {
        let mut connection = self.open_connection()?;
        let raw_query = request.query.trim().to_string();
        if raw_query.is_empty() {
            return Err(DictionaryError::InvalidInput(
                "请输入要查询的单词或短语".into(),
            ));
        }

        let normalized_query = normalize_query(&raw_query);
        let detected_source_language = detect_source_language(&raw_query);
        let direction = resolve_direction(request.direction, detected_source_language);
        let limit = request.limit.unwrap_or(DEFAULT_QUERY_LIMIT).clamp(1, 20);
        let settings = load_settings(&connection)?;
        let mut seen = HashSet::new();
        let mut notes = Vec::new();

        if normalized_query != raw_query {
            notes.push(format!(
                "已按 {} 方向归一化查询文本",
                direction_label(direction)
            ));
        }

        let phrase_hits = search_entries(
            &connection,
            &normalized_query,
            direction,
            SearchSpec {
                kind: SearchKind::Exact,
                phrase_only: Some(true),
                limit,
                matched_by: "phraseExact",
                match_reason: "短语精确命中",
                score_bias: 26.0,
            },
            &mut seen,
        )?;

        let mut exact_hits = search_entries(
            &connection,
            &normalized_query,
            direction,
            SearchSpec {
                kind: SearchKind::Exact,
                phrase_only: Some(false),
                limit,
                matched_by: "exact",
                match_reason: "词条精确命中",
                score_bias: 22.0,
            },
            &mut seen,
        )?;

        if exact_hits.is_empty() && detected_source_language == SourceLanguage::En {
            for lemma in english_lemma_candidates(&normalized_query) {
                if lemma == normalized_query {
                    continue;
                }
                let lemma_hits = search_entries(
                    &connection,
                    &lemma,
                    direction,
                    SearchSpec {
                        kind: SearchKind::Exact,
                        phrase_only: Some(false),
                        limit,
                        matched_by: "lemma",
                        match_reason: "词形还原后命中",
                        score_bias: 18.0,
                    },
                    &mut seen,
                )?;
                if !lemma_hits.is_empty() {
                    notes.push(format!("未命中原词形，已回退到 {}", lemma));
                    exact_hits.extend(lemma_hits);
                    break;
                }
            }
        }

        let mut fuzzy_hits = search_entries(
            &connection,
            &normalized_query,
            direction,
            SearchSpec {
                kind: SearchKind::Prefix,
                phrase_only: None,
                limit,
                matched_by: "prefix",
                match_reason: "前缀补全候选",
                score_bias: 12.0,
            },
            &mut seen,
        )?;

        if fuzzy_hits.len() < limit {
            let remaining = limit - fuzzy_hits.len();
            fuzzy_hits.extend(search_entries(
                &connection,
                &normalized_query,
                direction,
                SearchSpec {
                    kind: SearchKind::Contains,
                    phrase_only: None,
                    limit: remaining,
                    matched_by: "contains",
                    match_reason: "模糊包含候选",
                    score_bias: 6.0,
                },
                &mut seen,
            )?);
        }

        let total_hits = phrase_hits.len() + exact_hits.len() + fuzzy_hits.len();
        let suggestions =
            collect_suggestions(&normalized_query, [&phrase_hits, &exact_hits, &fuzzy_hits]);
        if !suggestions.is_empty() {
            notes.push(format!("可继续尝试 {} 个相关表达", suggestions.len()));
        }

        let result = TranslationResult {
            query: raw_query.clone(),
            normalized_query: normalized_query.clone(),
            direction,
            detected_source_language,
            phrase_hits,
            exact_hits,
            fuzzy_hits,
            suggestions,
            total_hits,
            notes,
        };

        let settings_limit = settings.max_history_items.clamp(10, 200);
        record_history(
            &mut connection,
            &raw_query,
            &normalized_query,
            direction,
            result.phrase_hits.len() + result.exact_hits.len() + result.fuzzy_hits.len(),
            settings_limit,
        )?;

        Ok(result)
    }

    pub fn add_favorite(&self, payload: FavoritePayload) -> Result<FavoriteEntry, DictionaryError> {
        if payload.query.trim().is_empty() || payload.translation.trim().is_empty() {
            return Err(DictionaryError::InvalidInput("收藏内容不能为空".into()));
        }

        let connection = self.open_connection()?;
        let now = Utc::now().to_rfc3339();
        connection.execute(
            "INSERT INTO favorites (query, direction, translation, created_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(query, direction, translation)
             DO UPDATE SET created_at = excluded.created_at",
            params![
                payload.query.trim(),
                direction_storage_value(payload.direction),
                payload.translation.trim(),
                now,
            ],
        )?;

        let favorite = connection.query_row(
            "SELECT id, query, direction, translation, created_at
                 FROM favorites
                 WHERE query = ?1 AND direction = ?2 AND translation = ?3",
            params![
                payload.query.trim(),
                direction_storage_value(payload.direction),
                payload.translation.trim(),
            ],
            map_favorite,
        )?;
        Ok(favorite)
    }

    pub fn remove_favorite(&self, id: i64) -> Result<bool, DictionaryError> {
        let connection = self.open_connection()?;
        let removed = connection.execute("DELETE FROM favorites WHERE id = ?1", params![id])?;
        Ok(removed > 0)
    }

    pub fn history(&self, limit: Option<usize>) -> Result<Vec<HistoryEntry>, DictionaryError> {
        let connection = self.open_connection()?;
        load_history(&connection, limit.unwrap_or(DASHBOARD_LIMIT).clamp(1, 100))
    }

    pub fn update_settings(
        &self,
        settings: DictionarySettings,
    ) -> Result<DictionarySettings, DictionaryError> {
        let connection = self.open_connection()?;
        let normalized = DictionarySettings {
            default_direction: settings.default_direction,
            auto_copy_primary: settings.auto_copy_primary,
            compact_result_view: settings.compact_result_view,
            max_history_items: settings.max_history_items.clamp(10, 200),
        };
        upsert_setting(
            &connection,
            "defaultDirection",
            match normalized.default_direction {
                QueryDirection::Auto => "auto",
                QueryDirection::ZhToEn => "zhToEn",
                QueryDirection::EnToZh => "enToZh",
            },
        )?;
        upsert_setting(
            &connection,
            "autoCopyPrimary",
            if normalized.auto_copy_primary {
                "true"
            } else {
                "false"
            },
        )?;
        upsert_setting(
            &connection,
            "compactResultView",
            if normalized.compact_result_view {
                "true"
            } else {
                "false"
            },
        )?;
        upsert_setting(
            &connection,
            "maxHistoryItems",
            &normalized.max_history_items.to_string(),
        )?;
        Ok(normalized)
    }
}

#[derive(Debug, Clone, Copy)]
enum SearchKind {
    Exact,
    Prefix,
    Contains,
}

#[derive(Debug, Clone, Copy)]
struct SearchSpec<'a> {
    kind: SearchKind,
    phrase_only: Option<bool>,
    limit: usize,
    matched_by: &'a str,
    match_reason: &'a str,
    score_bias: f64,
}

#[derive(Debug)]
struct SearchRow {
    id: i64,
    term: String,
    normalized_term: String,
    source_language: SourceLanguage,
    target_language: SourceLanguage,
    pronunciation: Option<String>,
    phonetic: Option<String>,
    tags: Vec<String>,
    is_phrase: bool,
    weight: i64,
    alias_hit: bool,
}

fn initialize_database(db_path: &Path) -> Result<(), DictionaryError> {
    let mut connection = Connection::open(db_path)?;
    connection.execute_batch(
        "PRAGMA foreign_keys = ON;
         CREATE TABLE IF NOT EXISTS metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            term TEXT NOT NULL,
            normalized_term TEXT NOT NULL,
            source_language TEXT NOT NULL,
            target_language TEXT NOT NULL,
            pronunciation TEXT,
            phonetic TEXT,
            tags TEXT NOT NULL,
            is_phrase INTEGER NOT NULL DEFAULT 0,
            weight INTEGER NOT NULL DEFAULT 0
         );
         CREATE INDEX IF NOT EXISTS idx_entries_lookup ON entries(normalized_term, source_language, target_language, is_phrase);
         CREATE INDEX IF NOT EXISTS idx_entries_weight ON entries(source_language, target_language, weight DESC);
         CREATE TABLE IF NOT EXISTS entry_aliases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
            alias TEXT NOT NULL,
            normalized_alias TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_alias_lookup ON entry_aliases(normalized_alias, entry_id);
         CREATE TABLE IF NOT EXISTS entry_senses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
            definition TEXT NOT NULL,
            part_of_speech TEXT,
            examples TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS favorites (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            query TEXT NOT NULL,
            direction TEXT NOT NULL,
            translation TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(query, direction, translation)
         );
         CREATE TABLE IF NOT EXISTS history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            query TEXT NOT NULL,
            normalized_query TEXT NOT NULL,
            direction TEXT NOT NULL,
            result_count INTEGER NOT NULL,
            created_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
         );",
    )?;

    ensure_default_settings(&connection)?;

    let seed: SeedDictionary = serde_json::from_str(DEFAULT_SEED_JSON)?;
    let current_seed_identity = connection
        .query_row(
            "SELECT value FROM metadata WHERE key = 'seedIdentity'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let next_seed_identity = seed_identity(&seed);

    if current_seed_identity.as_deref() == Some(next_seed_identity.as_str()) {
        return Ok(());
    }

    let transaction = connection.transaction()?;
    transaction.execute("DELETE FROM entry_senses", [])?;
    transaction.execute("DELETE FROM entry_aliases", [])?;
    transaction.execute("DELETE FROM entries", [])?;
    transaction.execute(
        "DELETE FROM metadata WHERE key IN ('version', 'sourceLabel', 'languagePairs', 'features', 'generatedAt', 'packageCount', 'seedIdentity')",
        [],
    )?;

    for entry in seed.entries {
        transaction.execute(
            "INSERT INTO entries (
                term,
                normalized_term,
                source_language,
                target_language,
                pronunciation,
                phonetic,
                tags,
                is_phrase,
                weight
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                entry.term,
                normalize_query(&entry.term),
                entry.source_language.as_str(),
                entry.target_language.as_str(),
                entry.pronunciation,
                entry.phonetic,
                serde_json::to_string(&entry.tags)?,
                if entry.is_phrase { 1 } else { 0 },
                entry.weight,
            ],
        )?;
        let entry_id = transaction.last_insert_rowid();

        for alias in entry.aliases {
            transaction.execute(
                "INSERT INTO entry_aliases (entry_id, alias, normalized_alias) VALUES (?1, ?2, ?3)",
                params![entry_id, alias, normalize_query(&alias)],
            )?;
        }

        for (index, sense) in entry.senses.into_iter().enumerate() {
            transaction.execute(
                "INSERT INTO entry_senses (entry_id, definition, part_of_speech, examples, sort_order)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    entry_id,
                    sense.definition,
                    sense.part_of_speech,
                    serde_json::to_string(&sense.examples)?,
                    index as i64,
                ],
            )?;
        }
    }

    transaction.execute(
        "INSERT INTO metadata (key, value) VALUES ('version', ?1)",
        params![seed.version],
    )?;
    transaction.execute(
        "INSERT INTO metadata (key, value) VALUES ('sourceLabel', ?1)",
        params![seed.source_label],
    )?;
    transaction.execute(
        "INSERT INTO metadata (key, value) VALUES ('languagePairs', ?1)",
        params![serde_json::to_string(&seed.language_pairs)?],
    )?;
    transaction.execute(
        "INSERT INTO metadata (key, value) VALUES ('features', ?1)",
        params![serde_json::to_string(&seed.features)?],
    )?;
    transaction.execute(
        "INSERT INTO metadata (key, value) VALUES ('generatedAt', ?1)",
        params![seed.generated_at],
    )?;
    transaction.execute(
        "INSERT INTO metadata (key, value) VALUES ('packageCount', ?1)",
        params![seed.package_count.unwrap_or(1).to_string()],
    )?;
    transaction.execute(
        "INSERT INTO metadata (key, value) VALUES ('seedIdentity', ?1)",
        params![next_seed_identity],
    )?;
    transaction.commit()?;
    Ok(())
}

fn ensure_default_settings(connection: &Connection) -> Result<(), DictionaryError> {
    let defaults = DictionarySettings::default();
    upsert_setting(connection, "defaultDirection", "auto")?;
    upsert_setting(
        connection,
        "autoCopyPrimary",
        if defaults.auto_copy_primary {
            "true"
        } else {
            "false"
        },
    )?;
    upsert_setting(
        connection,
        "compactResultView",
        if defaults.compact_result_view {
            "true"
        } else {
            "false"
        },
    )?;
    upsert_setting(
        connection,
        "maxHistoryItems",
        &defaults.max_history_items.to_string(),
    )?;
    Ok(())
}

fn upsert_setting(connection: &Connection, key: &str, value: &str) -> Result<(), DictionaryError> {
    connection.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn load_metadata(connection: &Connection) -> Result<DictionaryMetadata, DictionaryError> {
    let mut statement = connection.prepare("SELECT key, value FROM metadata")?;
    let mut rows = statement.query([])?;
    let mut metadata = HashMap::new();
    while let Some(row) = rows.next()? {
        metadata.insert(row.get::<_, String>(0)?, row.get::<_, String>(1)?);
    }

    let entry_count: i64 =
        connection.query_row("SELECT COUNT(*) FROM entries", [], |row| row.get(0))?;
    let phrase_count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM entries WHERE is_phrase = 1",
        [],
        |row| row.get(0),
    )?;

    Ok(DictionaryMetadata {
        version: metadata
            .remove("version")
            .unwrap_or_else(|| "unknown".into()),
        entry_count: entry_count as usize,
        phrase_count: phrase_count as usize,
        language_pairs: metadata
            .get("languagePairs")
            .and_then(|value| serde_json::from_str(value).ok())
            .unwrap_or_else(|| vec!["zh-en".into(), "en-zh".into()]),
        features: metadata
            .get("features")
            .and_then(|value| serde_json::from_str(value).ok())
            .unwrap_or_default(),
        source_label: metadata
            .get("sourceLabel")
            .cloned()
            .unwrap_or_else(|| "Tool Box Offline Lexicon".into()),
        generated_at: metadata
            .get("generatedAt")
            .cloned()
            .filter(|value| !value.is_empty()),
        package_count: metadata
            .get("packageCount")
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(1),
    })
}

fn load_settings(connection: &Connection) -> Result<DictionarySettings, DictionaryError> {
    let mut statement = connection.prepare("SELECT key, value FROM settings")?;
    let mut rows = statement.query([])?;
    let mut settings = HashMap::new();
    while let Some(row) = rows.next()? {
        settings.insert(row.get::<_, String>(0)?, row.get::<_, String>(1)?);
    }

    Ok(DictionarySettings {
        default_direction: match settings.get("defaultDirection").map(String::as_str) {
            Some("zhToEn") => QueryDirection::ZhToEn,
            Some("enToZh") => QueryDirection::EnToZh,
            _ => QueryDirection::Auto,
        },
        auto_copy_primary: settings
            .get("autoCopyPrimary")
            .is_some_and(|value| value == "true"),
        compact_result_view: settings
            .get("compactResultView")
            .is_some_and(|value| value == "true"),
        max_history_items: settings
            .get("maxHistoryItems")
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(40)
            .clamp(10, 200),
    })
}

fn load_favorites(
    connection: &Connection,
    limit: usize,
) -> Result<Vec<FavoriteEntry>, DictionaryError> {
    let mut statement = connection.prepare(
        "SELECT id, query, direction, translation, created_at
         FROM favorites
         ORDER BY datetime(created_at) DESC, id DESC
         LIMIT ?1",
    )?;
    let mapped = statement.query_map(params![limit as i64], map_favorite)?;
    mapped
        .collect::<Result<Vec<_>, _>>()
        .map_err(DictionaryError::from)
}

fn load_history(
    connection: &Connection,
    limit: usize,
) -> Result<Vec<HistoryEntry>, DictionaryError> {
    let mut statement = connection.prepare(
        "SELECT id, query, normalized_query, direction, result_count, created_at
         FROM history
         ORDER BY datetime(created_at) DESC, id DESC
         LIMIT ?1",
    )?;
    let mapped = statement.query_map(params![limit as i64], |row| {
        Ok(HistoryEntry {
            id: row.get(0)?,
            query: row.get(1)?,
            normalized_query: row.get(2)?,
            direction: parse_direction(&row.get::<_, String>(3)?),
            result_count: row.get::<_, i64>(4)? as usize,
            created_at: row.get(5)?,
        })
    })?;
    mapped
        .collect::<Result<Vec<_>, _>>()
        .map_err(DictionaryError::from)
}

fn map_favorite(row: &rusqlite::Row<'_>) -> Result<FavoriteEntry, rusqlite::Error> {
    Ok(FavoriteEntry {
        id: row.get(0)?,
        query: row.get(1)?,
        direction: parse_direction(&row.get::<_, String>(2)?),
        translation: row.get(3)?,
        created_at: row.get(4)?,
    })
}

fn record_history(
    connection: &mut Connection,
    query: &str,
    normalized_query: &str,
    direction: ResolvedDirection,
    result_count: usize,
    limit: usize,
) -> Result<(), DictionaryError> {
    let transaction = connection.transaction()?;
    transaction.execute(
        "INSERT INTO history (query, normalized_query, direction, result_count, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            query,
            normalized_query,
            direction_storage_value(direction),
            result_count as i64,
            Utc::now().to_rfc3339(),
        ],
    )?;
    transaction.execute(
        "DELETE FROM history
         WHERE id NOT IN (
            SELECT id FROM history ORDER BY datetime(created_at) DESC, id DESC LIMIT ?1
         )",
        params![limit as i64],
    )?;
    transaction.commit()?;
    Ok(())
}

fn search_entries(
    connection: &Connection,
    query: &str,
    direction: ResolvedDirection,
    spec: SearchSpec<'_>,
    seen: &mut HashSet<i64>,
) -> Result<Vec<DictionaryEntrySummary>, DictionaryError> {
    if spec.limit == 0 {
        return Ok(Vec::new());
    }

    let source_language = direction.source_language().as_str();
    let target_language = direction.target_language().as_str();
    let term_operator = match spec.kind {
        SearchKind::Exact => "= ?1",
        SearchKind::Prefix => "LIKE (?1 || '%')",
        SearchKind::Contains => "LIKE ('%' || ?1 || '%')",
    };
    let alias_operator = term_operator;
    let phrase_sql = match spec.phrase_only {
        Some(true) => "AND e.is_phrase = 1",
        Some(false) => "AND e.is_phrase = 0",
        None => "",
    };
    let sql = format!(
        "SELECT
            e.id,
            e.term,
            e.normalized_term,
            e.source_language,
            e.target_language,
            e.pronunciation,
            e.phonetic,
            e.tags,
            e.is_phrase,
            e.weight,
            MAX(CASE WHEN a.normalized_alias {alias_operator} THEN 1 ELSE 0 END) AS alias_hit
         FROM entries e
         LEFT JOIN entry_aliases a ON a.entry_id = e.id
         WHERE e.source_language = ?2
           AND e.target_language = ?3
           AND (
                e.normalized_term {term_operator}
                OR a.normalized_alias {alias_operator}
           )
           {phrase_sql}
         GROUP BY e.id
         ORDER BY e.weight DESC, LENGTH(e.term) ASC, e.id ASC
         LIMIT ?4"
    );

    let mut statement = connection.prepare(&sql)?;
    let mapped = statement.query_map(
        [
            &query as &dyn ToSql,
            &source_language,
            &target_language,
            &(spec.limit as i64),
        ],
        |row| {
            Ok(SearchRow {
                id: row.get(0)?,
                term: row.get(1)?,
                normalized_term: row.get(2)?,
                source_language: parse_language(&row.get::<_, String>(3)?),
                target_language: parse_language(&row.get::<_, String>(4)?),
                pronunciation: row.get(5)?,
                phonetic: row.get(6)?,
                tags: serde_json::from_str(&row.get::<_, String>(7)?).unwrap_or_default(),
                is_phrase: row.get::<_, i64>(8)? == 1,
                weight: row.get(9)?,
                alias_hit: row.get::<_, i64>(10)? == 1,
            })
        },
    )?;

    let rows = mapped.collect::<Result<Vec<_>, _>>()?;
    let mut results = Vec::new();

    for row in rows {
        if seen.contains(&row.id) {
            continue;
        }
        seen.insert(row.id);
        results.push(build_entry_summary(connection, row, query, spec)?);
    }

    results.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.term.len().cmp(&right.term.len()))
            .then_with(|| left.term.cmp(&right.term))
    });

    Ok(results)
}

fn build_entry_summary(
    connection: &Connection,
    row: SearchRow,
    query: &str,
    spec: SearchSpec<'_>,
) -> Result<DictionaryEntrySummary, DictionaryError> {
    let variants = load_variants(connection, row.id, row.weight as f64 / 100.0)?;
    let aliases = load_aliases(connection, row.id)?;
    let primary_translation = variants
        .first()
        .map(|item| item.definition.clone())
        .unwrap_or_default();
    let mut score = row.weight as f64 + spec.score_bias;
    if row.normalized_term == query {
        score += 18.0;
    }
    if row.alias_hit {
        score += 6.0;
    }
    if row.is_phrase {
        score += 10.0;
    }
    let length_gap = (row.normalized_term.len() as i64 - query.len() as i64).unsigned_abs() as f64;
    score -= length_gap.min(10.0) * 0.4;

    let match_reason = if row.alias_hit && matches!(spec.kind, SearchKind::Exact) {
        "别名精确命中".to_string()
    } else if row.alias_hit {
        "别名补充候选".to_string()
    } else {
        spec.match_reason.to_string()
    };

    Ok(DictionaryEntrySummary {
        id: row.id,
        term: row.term,
        normalized_term: row.normalized_term,
        source_language: row.source_language,
        target_language: row.target_language,
        pronunciation: row.pronunciation,
        phonetic: row.phonetic,
        tags: row.tags,
        aliases,
        is_phrase: row.is_phrase,
        score,
        primary_translation,
        variants,
        matched_by: if row.alias_hit && spec.matched_by == "exact" {
            "alias".into()
        } else {
            spec.matched_by.into()
        },
        match_reason,
    })
}

fn load_aliases(connection: &Connection, entry_id: i64) -> Result<Vec<String>, DictionaryError> {
    let mut statement = connection.prepare(
        "SELECT alias FROM entry_aliases WHERE entry_id = ?1 ORDER BY LENGTH(alias) ASC, alias ASC",
    )?;
    let mapped = statement.query_map(params![entry_id], |row| row.get::<_, String>(0))?;
    mapped
        .collect::<Result<Vec<_>, _>>()
        .map_err(DictionaryError::from)
}

fn load_variants(
    connection: &Connection,
    entry_id: i64,
    base_score: f64,
) -> Result<Vec<DictionaryVariantSummary>, DictionaryError> {
    let mut statement = connection.prepare(
        "SELECT id, definition, part_of_speech, examples, sort_order
         FROM entry_senses
         WHERE entry_id = ?1
         ORDER BY sort_order ASC, id ASC",
    )?;
    let mapped = statement.query_map(params![entry_id], |row| {
        let order: i64 = row.get(4)?;
        Ok(DictionaryVariantSummary {
            id: row.get(0)?,
            definition: row.get(1)?,
            part_of_speech: row.get(2)?,
            examples: serde_json::from_str(&row.get::<_, String>(3)?).unwrap_or_default(),
            score: (base_score - order as f64 * 0.02).max(0.1),
        })
    })?;
    mapped
        .collect::<Result<Vec<_>, _>>()
        .map_err(DictionaryError::from)
}

fn normalize_query(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut previous_space = false;
    for character in input.trim().chars() {
        let normalized = if character.is_ascii_uppercase() {
            character.to_ascii_lowercase()
        } else {
            character
        };
        if normalized.is_whitespace() {
            if !previous_space {
                result.push(' ');
            }
            previous_space = true;
            continue;
        }

        previous_space = false;
        result.push(normalized);
    }
    result.trim().to_string()
}

fn collect_suggestions<'a>(
    query: &str,
    groups: impl IntoIterator<Item = &'a Vec<DictionaryEntrySummary>>,
) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut suggestions = Vec::new();
    for group in groups {
        for item in group {
            for candidate in std::iter::once(&item.term).chain(item.aliases.iter()) {
                let normalized = normalize_query(candidate);
                if normalized == query || normalized.is_empty() || !seen.insert(normalized.clone())
                {
                    continue;
                }
                suggestions.push(candidate.clone());
                if suggestions.len() >= 6 {
                    return suggestions;
                }
            }
        }
    }
    suggestions
}

fn detect_source_language(input: &str) -> SourceLanguage {
    if input.chars().any(is_cjk_character) {
        SourceLanguage::Zh
    } else {
        SourceLanguage::En
    }
}

fn is_cjk_character(character: char) -> bool {
    matches!(character as u32,
        0x3400..=0x4DBF |
        0x4E00..=0x9FFF |
        0xF900..=0xFAFF |
        0x20000..=0x2A6DF |
        0x2A700..=0x2B73F |
        0x2B740..=0x2B81F |
        0x2B820..=0x2CEAF)
}

fn resolve_direction(direction: QueryDirection, detected: SourceLanguage) -> ResolvedDirection {
    match direction {
        QueryDirection::Auto => match detected {
            SourceLanguage::Zh => ResolvedDirection::ZhToEn,
            SourceLanguage::En => ResolvedDirection::EnToZh,
        },
        QueryDirection::ZhToEn => ResolvedDirection::ZhToEn,
        QueryDirection::EnToZh => ResolvedDirection::EnToZh,
    }
}

fn direction_label(direction: ResolvedDirection) -> &'static str {
    match direction {
        ResolvedDirection::ZhToEn => "中译英",
        ResolvedDirection::EnToZh => "英译中",
    }
}

fn direction_storage_value(direction: ResolvedDirection) -> &'static str {
    match direction {
        ResolvedDirection::ZhToEn => "zhToEn",
        ResolvedDirection::EnToZh => "enToZh",
    }
}

fn parse_direction(value: &str) -> ResolvedDirection {
    match value {
        "zhToEn" => ResolvedDirection::ZhToEn,
        _ => ResolvedDirection::EnToZh,
    }
}

fn parse_language(value: &str) -> SourceLanguage {
    match value {
        "zh" => SourceLanguage::Zh,
        _ => SourceLanguage::En,
    }
}

fn english_lemma_candidates(term: &str) -> Vec<String> {
    let mut candidates = Vec::new();
    let push_candidate = |items: &mut Vec<String>, candidate: String| {
        if candidate.len() > 1 && !items.contains(&candidate) {
            items.push(candidate);
        }
    };

    if term.ends_with("ies") && term.len() > 3 {
        push_candidate(&mut candidates, format!("{}y", &term[..term.len() - 3]));
    }
    if term.ends_with("ing") && term.len() > 4 {
        let base = term[..term.len() - 3].to_string();
        push_candidate(&mut candidates, base.clone());
        push_candidate(&mut candidates, format!("{}e", base));
    }
    if term.ends_with("ed") && term.len() > 3 {
        let base = term[..term.len() - 2].to_string();
        push_candidate(&mut candidates, base.clone());
        push_candidate(&mut candidates, format!("{}e", base));
    }
    if term.ends_with("es") && term.len() > 3 {
        push_candidate(&mut candidates, term[..term.len() - 2].to_string());
    }
    if term.ends_with('s') && term.len() > 2 {
        push_candidate(&mut candidates, term[..term.len() - 1].to_string());
    }

    candidates
}

#[tauri::command]
pub fn dictionary_dashboard(
    state: State<'_, DictionaryService>,
) -> Result<DictionaryDashboard, String> {
    state.dashboard().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn dictionary_metadata(
    state: State<'_, DictionaryService>,
) -> Result<DictionaryMetadata, String> {
    state.metadata().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn query_translation(
    request: TranslationQueryRequest,
    state: State<'_, DictionaryService>,
) -> Result<TranslationResult, String> {
    state
        .query_translation(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn dictionary_add_favorite(
    payload: FavoritePayload,
    state: State<'_, DictionaryService>,
) -> Result<FavoriteEntry, String> {
    state
        .add_favorite(payload)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn dictionary_remove_favorite(
    id: i64,
    state: State<'_, DictionaryService>,
) -> Result<bool, String> {
    state.remove_favorite(id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn dictionary_history(
    limit: Option<usize>,
    state: State<'_, DictionaryService>,
) -> Result<Vec<HistoryEntry>, String> {
    state.history(limit).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn dictionary_update_settings(
    settings: DictionarySettings,
    state: State<'_, DictionaryService>,
) -> Result<DictionarySettings, String> {
    state
        .update_settings(settings)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db_path(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("tool-box-{label}-{nanos}.sqlite3"))
    }

    #[test]
    fn normalize_query_collapses_spaces_and_lowercases_ascii() {
        assert_eq!(normalize_query("  Tool   BOX  "), "tool box");
        assert_eq!(normalize_query(" 图像   处理 "), "图像 处理");
    }

    #[test]
    fn detect_source_language_prefers_cjk_when_present() {
        assert_eq!(detect_source_language("hello"), SourceLanguage::En);
        assert_eq!(detect_source_language("你好 world"), SourceLanguage::Zh);
    }

    #[test]
    fn seed_database_supports_bidirectional_queries() {
        let path = temp_db_path("query");
        initialize_database(&path).unwrap();
        let service = DictionaryService {
            db_path: path.clone(),
        };

        let english = service
            .query_translation(TranslationQueryRequest {
                query: "toolbox".into(),
                direction: QueryDirection::Auto,
                limit: Some(5),
            })
            .unwrap();
        assert_eq!(english.direction, ResolvedDirection::EnToZh);
        assert_eq!(english.phrase_hits[0].primary_translation, "工具箱");

        let chinese = service
            .query_translation(TranslationQueryRequest {
                query: "图像处理".into(),
                direction: QueryDirection::Auto,
                limit: Some(5),
            })
            .unwrap();
        assert_eq!(chinese.direction, ResolvedDirection::ZhToEn);
        assert_eq!(
            chinese.phrase_hits[0].primary_translation,
            "image processing"
        );

        let _ = fs::remove_file(path);
    }

    #[test]
    fn favorites_and_settings_are_persisted() {
        let path = temp_db_path("state");
        initialize_database(&path).unwrap();
        let service = DictionaryService {
            db_path: path.clone(),
        };

        let favorite = service
            .add_favorite(FavoritePayload {
                query: "toolbox".into(),
                direction: ResolvedDirection::EnToZh,
                translation: "工具箱".into(),
            })
            .unwrap();
        assert!(favorite.id > 0);

        let settings = service
            .update_settings(DictionarySettings {
                default_direction: QueryDirection::ZhToEn,
                auto_copy_primary: true,
                compact_result_view: true,
                max_history_items: 25,
            })
            .unwrap();
        assert_eq!(settings.default_direction, QueryDirection::ZhToEn);
        assert!(settings.auto_copy_primary);

        let dashboard = service.dashboard().unwrap();
        assert_eq!(dashboard.favorites.len(), 1);
        assert_eq!(dashboard.settings.max_history_items, 25);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn metadata_reports_build_identity_fields() {
        let path = temp_db_path("metadata");
        initialize_database(&path).unwrap();
        let service = DictionaryService {
            db_path: path.clone(),
        };

        let metadata = service.metadata().unwrap();
        assert!(metadata.package_count >= 1);
        assert!(metadata.generated_at.is_some());

        let connection = service.open_connection().unwrap();
        let seed_identity: String = connection
            .query_row(
                "SELECT value FROM metadata WHERE key = 'seedIdentity'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!seed_identity.is_empty());

        let _ = fs::remove_file(path);
    }
}
