use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use thiserror::Error;

#[cfg(feature = "napi")]
use napi_derive::napi;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "napi", napi(object))]
pub struct SymbolEntry {
    pub name: String,
    pub kind: String,
    pub file_path: String,
    pub line_number: u32,
    pub container_name: Option<String>,
    pub package_name: String,
    pub visibility: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "napi", napi(object))]
pub struct ImportEntry {
    pub file_path: String,
    pub package_path: String,
    pub imported_name: Option<String>,
    pub source_symbol_name: Option<String>,
    pub is_wildcard: bool,
    pub line_number: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "napi", napi(object))]
pub struct DiagnosticEntry {
    pub file_path: String,
    pub line_number: u32,
    pub column: u32,
    pub severity: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryUsage {
    pub heap_bytes: u64,
    pub native_rss_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "napi", napi(object))]
pub struct ParseFileResult {
    pub file_path: String,
    pub symbols: Vec<SymbolEntry>,
    pub imports: Vec<ImportEntry>,
    pub diagnostics: Vec<DiagnosticEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileInput {
    pub file_path: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct IndexSnapshot {
    pub by_symbol: HashMap<String, Vec<SymbolEntry>>,
    pub diagnostics_by_file: HashMap<String, Vec<DiagnosticEntry>>,
    pub imports_by_file: HashMap<String, Vec<ImportEntry>>,
    pub package_by_file: HashMap<String, String>,
}

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("input file path cannot be empty")]
    EmptyFilePath,
    #[error("query cannot be empty")]
    EmptyQuery,
}

fn tokenize_symbols(file_path: &str, content: &str) -> Vec<SymbolEntry> {
    let mut symbols = Vec::new();
    let mut current_container: Option<String> = None;
    let mut current_package = String::new();

    for (line_index, line) in content.lines().enumerate() {
        let line_number = (line_index + 1) as u32;
        let trimmed = line.trim_start();
        let declaration = strip_qualifiers(trimmed);

        let kinds = [
            ("package", "package"),
            ("object", "object"),
            ("class", "class"),
            ("trait", "trait"),
            ("enum", "enum"),
            ("def", "def"),
            ("val", "val"),
            ("var", "var"),
            ("type", "type"),
            ("given", "given"),
        ];

        for (token, kind) in kinds {
            if let Some(rest) = strip_keyword_prefix(declaration, token) {
                let candidate = rest
                    .trim_start()
                    .split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_' && ch != '.')
                    .next()
                    .unwrap_or_default()
                    .to_string();

                if candidate.is_empty() {
                    continue;
                }

                let symbol = SymbolEntry {
                    name: candidate.clone(),
                    kind: kind.to_string(),
                    file_path: file_path.to_string(),
                    line_number,
                    container_name: current_container.clone(),
                    package_name: if kind == "package" {
                        candidate.clone()
                    } else {
                        current_package.clone()
                    },
                    visibility: infer_visibility(trimmed),
                };
                symbols.push(symbol);

                if kind == "package" && current_package.is_empty() {
                    current_package = candidate.clone();
                }

                if kind == "object" || kind == "class" || kind == "trait" || kind == "enum" {
                    current_container = Some(candidate);
                }
            }
        }
    }

    symbols
}

fn strip_keyword_prefix<'a>(text: &'a str, keyword: &str) -> Option<&'a str> {
    let rest = text.strip_prefix(keyword)?;
    if rest.is_empty() || rest.starts_with(char::is_whitespace) {
        return Some(rest);
    }

    None
}

fn strip_qualifiers(mut text: &str) -> &str {
    loop {
        let trimmed = text.trim_start();

        if let Some(rest) = trimmed.strip_prefix("private[this]") {
            text = rest;
            continue;
        }

        if let Some(rest) = trimmed.strip_prefix("protected[this]") {
            text = rest;
            continue;
        }

        if trimmed.starts_with("private[") || trimmed.starts_with("protected[") {
            if let Some(end) = trimmed.find(']') {
                text = &trimmed[(end + 1)..];
                continue;
            }
        }

        let mut consumed = false;
        for qualifier in [
            "private",
            "protected",
            "final",
            "sealed",
            "abstract",
            "override",
            "implicit",
            "lazy",
        ] {
            if let Some(rest) = trimmed.strip_prefix(qualifier) {
                if rest.starts_with(char::is_whitespace) {
                    text = rest;
                    consumed = true;
                    break;
                }
            }
        }

        if !consumed {
            return trimmed;
        }
    }
}

fn infer_visibility(trimmed_line: &str) -> String {
    let normalized = trimmed_line.trim_start();

    if normalized.starts_with("private") {
        return "private".to_string();
    }

    if normalized.starts_with("protected") {
        return "protected".to_string();
    }

    if normalized.starts_with("def ")
        || normalized.starts_with("val ")
        || normalized.starts_with("var ")
        || normalized.starts_with("type ")
        || normalized.starts_with("class ")
        || normalized.starts_with("trait ")
        || normalized.starts_with("object ")
        || normalized.starts_with("enum ")
        || normalized.starts_with("given ")
        || normalized.starts_with("package ")
    {
        return "public".to_string();
    }

    "unknown".to_string()
}

fn parse_import_statement(file_path: &str, statement: &str, line_number: u32) -> Vec<ImportEntry> {
    let mut records = Vec::new();
    let normalized = statement.trim().trim_start_matches("import").trim();
    if normalized.is_empty() {
        return records;
    }

    if let (Some(brace_start), Some(brace_end)) = (normalized.find('{'), normalized.rfind('}')) {
        if brace_end > brace_start {
            let prefix = normalized[..brace_start].trim().trim_end_matches('.');
            let selector_body = &normalized[(brace_start + 1)..brace_end];
            for selector in selector_body
                .split(',')
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
            {
                if selector == "_" || selector == "*" {
                    records.push(ImportEntry {
                        file_path: file_path.to_string(),
                        package_path: prefix.to_string(),
                        imported_name: None,
                        source_symbol_name: None,
                        is_wildcard: true,
                        line_number,
                    });
                    continue;
                }

                if let Some((source, alias)) = selector.split_once("=>") {
                    records.push(ImportEntry {
                        file_path: file_path.to_string(),
                        package_path: prefix.to_string(),
                        imported_name: Some(alias.trim().to_string()),
                        source_symbol_name: Some(source.trim().to_string()),
                        is_wildcard: false,
                        line_number,
                    });
                    continue;
                }

                records.push(ImportEntry {
                    file_path: file_path.to_string(),
                    package_path: prefix.to_string(),
                    imported_name: Some(selector.to_string()),
                    source_symbol_name: Some(selector.to_string()),
                    is_wildcard: false,
                    line_number,
                });
            }

            return records;
        }
    }

    if let Some((source_path, alias)) = normalized.split_once(" as ") {
        if let Some(last_dot) = source_path.rfind('.') {
            records.push(ImportEntry {
                file_path: file_path.to_string(),
                package_path: source_path[..last_dot].to_string(),
                imported_name: Some(alias.trim().to_string()),
                source_symbol_name: Some(source_path[(last_dot + 1)..].to_string()),
                is_wildcard: false,
                line_number,
            });
            return records;
        }
    }

    if normalized.ends_with("._") || normalized.ends_with(".*") {
        records.push(ImportEntry {
            file_path: file_path.to_string(),
            package_path: normalized
                .trim_end_matches("._")
                .trim_end_matches(".*")
                .to_string(),
            imported_name: None,
            source_symbol_name: None,
            is_wildcard: true,
            line_number,
        });
        return records;
    }

    if let Some(last_dot) = normalized.rfind('.') {
        let imported_name = normalized[(last_dot + 1)..].trim();
        records.push(ImportEntry {
            file_path: file_path.to_string(),
            package_path: normalized[..last_dot].to_string(),
            imported_name: Some(imported_name.to_string()),
            source_symbol_name: Some(imported_name.to_string()),
            is_wildcard: false,
            line_number,
        });
    }

    records
}

fn tokenize_imports(file_path: &str, content: &str) -> Vec<ImportEntry> {
    let lines: Vec<&str> = content.lines().collect();
    let mut records = Vec::new();
    let mut index = 0usize;

    while index < lines.len() {
        let line = lines[index].trim();
        if !line.starts_with("import ") {
            index += 1;
            continue;
        }

        let mut statement = line.to_string();
        let mut cursor = index;
        let mut open_braces = statement.matches('{').count();
        let mut close_braces = statement.matches('}').count();

        while cursor + 1 < lines.len()
            && (open_braces > close_braces || statement.trim_end().ends_with(','))
        {
            cursor += 1;
            let next_line = lines[cursor].trim();
            statement.push(' ');
            statement.push_str(next_line);
            open_braces += next_line.matches('{').count();
            close_braces += next_line.matches('}').count();
        }

        records.extend(parse_import_statement(file_path, &statement, (index + 1) as u32));
        index = cursor + 1;
    }

    records
}

fn detect_syntax_diagnostics(file_path: &str, content: &str) -> Vec<DiagnosticEntry> {
    let mut diagnostics = Vec::new();

    let mut brace_balance: i32 = 0;
    let mut paren_balance: i32 = 0;
    let mut bracket_balance: i32 = 0;

    let mut in_string = false;

    for (line_index, line) in content.lines().enumerate() {
        let line_number = (line_index + 1) as u32;
        for (column_index, ch) in line.chars().enumerate() {
            match ch {
                '{' => brace_balance += 1,
                '}' => brace_balance -= 1,
                '(' => paren_balance += 1,
                ')' => paren_balance -= 1,
                '[' => bracket_balance += 1,
                ']' => bracket_balance -= 1,
                '"' => in_string = !in_string,
                _ => {}
            }

            if brace_balance < 0 || paren_balance < 0 || bracket_balance < 0 {
                diagnostics.push(DiagnosticEntry {
                    file_path: file_path.to_string(),
                    line_number,
                    column: (column_index + 1) as u32,
                    severity: "error".to_string(),
                    message: "Unmatched closing delimiter".to_string(),
                });
                brace_balance = brace_balance.max(0);
                paren_balance = paren_balance.max(0);
                bracket_balance = bracket_balance.max(0);
            }
        }
    }

    if brace_balance > 0 || paren_balance > 0 || bracket_balance > 0 {
        diagnostics.push(DiagnosticEntry {
            file_path: file_path.to_string(),
            line_number: content.lines().count() as u32,
            column: 1,
            severity: "error".to_string(),
            message: "Unmatched opening delimiter".to_string(),
        });
    }

    if in_string {
        diagnostics.push(DiagnosticEntry {
            file_path: file_path.to_string(),
            line_number: content.lines().count() as u32,
            column: 1,
            severity: "error".to_string(),
            message: "Unterminated string literal".to_string(),
        });
    }

    diagnostics
}

fn fuzzy_score(query: &str, candidate: &str) -> Option<i32> {
    let query = query.to_lowercase();
    let candidate = candidate.to_lowercase();

    if query.is_empty() {
        return Some(0);
    }

    let mut cursor = 0usize;
    let mut score = 0i32;
    let chars: Vec<char> = candidate.chars().collect();

    for (index, query_char) in query.chars().enumerate() {
        let mut found = None;
        for (position, candidate_char) in chars.iter().enumerate().skip(cursor) {
            if *candidate_char == query_char {
                found = Some(position);
                break;
            }
        }

        let position = found?;
        score += 20;
        if position == index {
            score += 50;
        }
        if index > 0 && position == cursor {
            score += 10;
        }
        cursor = position + 1;
    }

    Some(score - (candidate.len() as i32 - query.len() as i32).max(0))
}

pub fn parse_file(file_path: &str, content: &str) -> Result<ParseFileResult, EngineError> {
    if file_path.trim().is_empty() {
        return Err(EngineError::EmptyFilePath);
    }

    let symbols = tokenize_symbols(file_path, content);
    let imports = tokenize_imports(file_path, content);
    let diagnostics = detect_syntax_diagnostics(file_path, content);

    Ok(ParseFileResult {
        file_path: file_path.to_string(),
        symbols,
        imports,
        diagnostics,
    })
}

pub fn index_files(files: &[FileInput]) -> Result<IndexSnapshot, EngineError> {
    let parsed: Result<Vec<ParseFileResult>, EngineError> = files
        .par_iter()
        .map(|file| parse_file(&file.file_path, &file.content))
        .collect();

    let parsed = parsed?;

    let mut by_symbol: HashMap<String, Vec<SymbolEntry>> = HashMap::new();
    let mut diagnostics_by_file: HashMap<String, Vec<DiagnosticEntry>> = HashMap::new();
    let mut imports_by_file: HashMap<String, Vec<ImportEntry>> = HashMap::new();
    let mut package_by_file: HashMap<String, String> = HashMap::new();

    for file_result in parsed {
        for import in file_result.imports {
            imports_by_file
                .entry(import.file_path.clone())
                .or_default()
                .push(import);
        }

        if let Some(package_symbol) = file_result
            .symbols
            .iter()
            .find(|entry| entry.kind == "package")
        {
            package_by_file.insert(file_result.file_path.clone(), package_symbol.package_name.clone());
        }

        for symbol in file_result.symbols {
            by_symbol
                .entry(symbol.name.clone())
                .or_default()
                .push(symbol);
        }

        for diagnostic in file_result.diagnostics {
            diagnostics_by_file
                .entry(diagnostic.file_path.clone())
                .or_default()
                .push(diagnostic);
        }
    }

    Ok(IndexSnapshot {
        by_symbol,
        diagnostics_by_file,
        imports_by_file,
        package_by_file,
    })
}

pub fn query_symbols_in_package(
    index: &IndexSnapshot,
    query: &str,
    package_path: &str,
    limit: usize,
) -> Result<Vec<SymbolEntry>, EngineError> {
    if query.trim().is_empty() || package_path.trim().is_empty() {
        return Ok(Vec::new());
    }

    let mut matched: Vec<SymbolEntry> = index
        .by_symbol
        .get(query)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|entry| entry.package_name == package_path)
        .collect();

    matched.sort_by(compare_symbol_entries);
    Ok(matched.into_iter().take(limit.max(1)).collect())
}

pub fn query_package_exists(index: &IndexSnapshot, package_path: &str) -> bool {
    if package_path.trim().is_empty() {
        return false;
    }

    index.by_symbol.values().any(|entries| {
        entries
            .iter()
            .any(|entry| entry.package_name == package_path)
    })
}

pub fn query_symbols(
    index: &IndexSnapshot,
    query: &str,
    limit: usize,
) -> Result<Vec<SymbolEntry>, EngineError> {
    if query.trim().is_empty() {
        return Err(EngineError::EmptyQuery);
    }

    let capped_limit = limit.max(1);

    if let Some(exact_entries) = index.by_symbol.get(query) {
        let mut sorted = exact_entries.clone();
        sorted.sort_by(compare_symbol_entries);
        return Ok(sorted.into_iter().take(capped_limit).collect());
    }

    let mut ranked_buckets: Vec<(i32, String, Vec<SymbolEntry>)> = index
        .by_symbol
        .iter()
        .filter_map(|(name, entries)| {
            fuzzy_score(query, name).map(|score| {
                let mut sorted_entries = entries.clone();
                sorted_entries.sort_by(compare_symbol_entries);
                (score, name.clone(), sorted_entries)
            })
        })
        .collect();

    ranked_buckets.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then_with(|| left.1.cmp(&right.1))
    });

    Ok(ranked_buckets
        .into_iter()
        .flat_map(|(_, _, entries)| entries)
        .take(capped_limit)
        .collect())
}

fn compare_symbol_entries(left: &SymbolEntry, right: &SymbolEntry) -> std::cmp::Ordering {
    left
        .file_path
        .cmp(&right.file_path)
        .then_with(|| left.line_number.cmp(&right.line_number))
        .then_with(|| symbol_kind_rank(&left.kind).cmp(&symbol_kind_rank(&right.kind)))
        .then_with(|| left.name.cmp(&right.name))
}

fn symbol_kind_rank(kind: &str) -> u8 {
    match kind {
        "package" => 0,
        "class" => 1,
        "trait" => 2,
        "object" => 3,
        "type" => 4,
        "def" => 5,
        "val" | "var" | "given" => 6,
        _ => 255,
    }
}

pub fn get_diagnostics(
    index: &IndexSnapshot,
    file_path: &str,
) -> Result<Vec<DiagnosticEntry>, EngineError> {
    if file_path.trim().is_empty() {
        return Err(EngineError::EmptyFilePath);
    }

    Ok(index
        .diagnostics_by_file
        .get(file_path)
        .cloned()
        .unwrap_or_default())
}

pub fn get_memory_usage(index: &IndexSnapshot) -> Result<MemoryUsage, EngineError> {
    let symbol_count: usize = index.by_symbol.values().map(std::vec::Vec::len).sum();
    let diagnostic_count: usize = index
        .diagnostics_by_file
        .values()
        .map(std::vec::Vec::len)
        .sum();

    let native_rss_bytes = ((symbol_count * 64) + (diagnostic_count * 96)) as u64;
    let heap_bytes = 0u64;

    Ok(MemoryUsage {
        heap_bytes,
        native_rss_bytes,
        total_bytes: heap_bytes + native_rss_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_file_extracts_symbols_imports_package_and_visibility() {
        let content = r#"
package demo.app
import demo.models.User
import demo.services.{AuthService => Auth}
import demo.repo._

private class InternalService
protected def secureToken = "x"
val publicValue = 42
"#;

        let parsed = parse_file("/tmp/demo.scala", content).expect("parse_file should succeed");

        assert_eq!(parsed.file_path, "/tmp/demo.scala");
        assert!(parsed.imports.iter().any(|entry| {
            entry.package_path == "demo.models"
                && entry.imported_name.as_deref() == Some("User")
                && !entry.is_wildcard
        }));
        assert!(parsed.imports.iter().any(|entry| {
            entry.package_path == "demo.services"
                && entry.imported_name.as_deref() == Some("Auth")
                && entry.source_symbol_name.as_deref() == Some("AuthService")
        }));
        assert!(parsed
            .imports
            .iter()
            .any(|entry| entry.package_path == "demo.repo" && entry.is_wildcard));

        let class_symbol = parsed
            .symbols
            .iter()
            .find(|entry| entry.name == "InternalService")
            .expect("class symbol should exist");
        assert_eq!(class_symbol.package_name, "demo.app");
        assert_eq!(class_symbol.visibility, "private");

        let protected_def = parsed
            .symbols
            .iter()
            .find(|entry| entry.name == "secureToken")
            .expect("protected def should exist");
        assert_eq!(protected_def.visibility, "protected");

        let public_val = parsed
            .symbols
            .iter()
            .find(|entry| entry.name == "publicValue")
            .expect("public val should exist");
        assert_eq!(public_val.visibility, "public");
    }

    #[test]
    fn package_queries_use_symbol_metadata_and_are_deterministic() {
        let files = vec![
            FileInput {
                file_path: "/tmp/a.scala".to_string(),
                content: "package demo.one\nclass User\n".to_string(),
            },
            FileInput {
                file_path: "/tmp/b.scala".to_string(),
                content: "package demo.one\nobject User\n".to_string(),
            },
            FileInput {
                file_path: "/tmp/c.scala".to_string(),
                content: "package demo.two\nclass User\n".to_string(),
            },
        ];

        let index = index_files(&files).expect("index_files should succeed");
        assert!(query_package_exists(&index, "demo.one"));
        assert!(!query_package_exists(&index, "demo.missing"));

        let matches = query_symbols_in_package(&index, "User", "demo.one", 10)
            .expect("query_symbols_in_package should succeed");
        assert_eq!(matches.len(), 2);
        assert!(matches.iter().all(|entry| entry.package_name == "demo.one"));

        let exact = query_symbols(&index, "User", 10).expect("query_symbols should succeed");
        assert!(exact.len() >= 3);
        let file_paths: Vec<&str> = exact.iter().map(|entry| entry.file_path.as_str()).collect();
        let mut sorted = file_paths.clone();
        sorted.sort();
        assert_eq!(file_paths, sorted);
    }
}

#[cfg(feature = "napi")]
mod napi_bridge {
    use super::{
        get_diagnostics, get_memory_usage, index_files, parse_file, query_package_exists,
        query_symbols, query_symbols_in_package, DiagnosticEntry, FileInput, IndexSnapshot,
        MemoryUsage, ParseFileResult, SymbolEntry,
    };
    use napi::bindgen_prelude::{Error, Result};
    use napi_derive::napi;
    use std::sync::{Arc, Mutex};

    #[napi(object)]
    pub struct JsFileInput {
        pub file_path: String,
        pub content: String,
    }

    #[napi(object)]
    pub struct JsMemoryUsage {
        pub heap_bytes: i64,
        pub native_rss_bytes: i64,
        pub total_bytes: i64,
    }

    #[napi]
    pub struct NativeEngine {
        inner: Arc<Mutex<IndexSnapshot>>,
    }

    #[napi]
    impl NativeEngine {
        #[napi(constructor)]
        pub fn new() -> Self {
            Self {
                inner: Arc::new(Mutex::new(IndexSnapshot::default())),
            }
        }

        #[napi]
        pub fn parse_file(&self, file_path: String, content: String) -> Result<ParseFileResult> {
            parse_file(&file_path, &content).map_err(|error| Error::from_reason(error.to_string()))
        }

        #[napi]
        pub fn index_files(&self, files: Vec<JsFileInput>) -> Result<u32> {
            let mapped: Vec<FileInput> = files
                .into_iter()
                .map(|file| FileInput {
                    file_path: file.file_path,
                    content: file.content,
                })
                .collect();

            let snapshot =
                index_files(&mapped).map_err(|error| Error::from_reason(error.to_string()))?;
            let symbol_total = snapshot
                .by_symbol
                .values()
                .map(std::vec::Vec::len)
                .sum::<usize>() as u32;
            let mut guard = self
                .inner
                .lock()
                .map_err(|_| Error::from_reason("engine lock poisoned".to_string()))?;
            *guard = snapshot;
            Ok(symbol_total)
        }

        #[napi]
        pub fn query_symbols(&self, query: String, limit: u32) -> Result<Vec<SymbolEntry>> {
            let guard = self
                .inner
                .lock()
                .map_err(|_| Error::from_reason("engine lock poisoned".to_string()))?;
            query_symbols(&guard, &query, limit as usize)
                .map_err(|error| Error::from_reason(error.to_string()))
        }

        #[napi]
        pub fn query_symbols_in_package(
            &self,
            query: String,
            package_path: String,
            limit: u32,
        ) -> Result<Vec<SymbolEntry>> {
            let guard = self
                .inner
                .lock()
                .map_err(|_| Error::from_reason("engine lock poisoned".to_string()))?;
            query_symbols_in_package(&guard, &query, &package_path, limit as usize)
                .map_err(|error| Error::from_reason(error.to_string()))
        }

        #[napi]
        pub fn query_package_exists(&self, package_path: String) -> Result<bool> {
            let guard = self
                .inner
                .lock()
                .map_err(|_| Error::from_reason("engine lock poisoned".to_string()))?;
            Ok(query_package_exists(&guard, &package_path))
        }

        #[napi]
        pub fn get_diagnostics(&self, file_path: String) -> Result<Vec<DiagnosticEntry>> {
            let guard = self
                .inner
                .lock()
                .map_err(|_| Error::from_reason("engine lock poisoned".to_string()))?;
            get_diagnostics(&guard, &file_path)
                .map_err(|error| Error::from_reason(error.to_string()))
        }

        #[napi]
        pub fn evict_file(&self, file_path: String) -> Result<()> {
            let mut guard = self
                .inner
                .lock()
                .map_err(|_| Error::from_reason("engine lock poisoned".to_string()))?;

            guard
                .by_symbol
                .values_mut()
                .for_each(|entries| entries.retain(|entry| entry.file_path != file_path));
            guard.diagnostics_by_file.remove(&file_path);
            guard.imports_by_file.remove(&file_path);
            guard.package_by_file.remove(&file_path);
            Ok(())
        }

        #[napi]
        pub fn rebuild_index(&self, files: Vec<JsFileInput>) -> Result<u32> {
            self.index_files(files)
        }

        #[napi]
        pub fn get_memory_usage(&self) -> Result<JsMemoryUsage> {
            let guard = self
                .inner
                .lock()
                .map_err(|_| Error::from_reason("engine lock poisoned".to_string()))?;

            let usage: MemoryUsage =
                get_memory_usage(&guard).map_err(|error| Error::from_reason(error.to_string()))?;
            Ok(JsMemoryUsage {
                heap_bytes: usage.heap_bytes.min(i64::MAX as u64) as i64,
                native_rss_bytes: usage.native_rss_bytes.min(i64::MAX as u64) as i64,
                total_bytes: usage.total_bytes.min(i64::MAX as u64) as i64,
            })
        }

        #[napi]
        pub fn shutdown(&self) -> Result<()> {
            let mut guard = self
                .inner
                .lock()
                .map_err(|_| Error::from_reason("engine lock poisoned".to_string()))?;
            *guard = IndexSnapshot::default();
            Ok(())
        }
    }
}
