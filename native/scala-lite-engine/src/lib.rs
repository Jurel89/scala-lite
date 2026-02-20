use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SymbolEntry {
    pub name: String,
    pub kind: String,
    pub file_path: String,
    pub line_number: u32,
    pub container_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
pub struct ParseFileResult {
    pub symbols: Vec<SymbolEntry>,
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

    for (line_index, line) in content.lines().enumerate() {
        let line_number = (line_index + 1) as u32;
        let trimmed = line.trim_start();

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
            if let Some(rest) = trimmed.strip_prefix(token) {
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
                };
                symbols.push(symbol);

                if kind == "object" || kind == "class" || kind == "trait" || kind == "enum" {
                    current_container = Some(candidate);
                }
            }
        }
    }

    symbols
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
    let diagnostics = detect_syntax_diagnostics(file_path, content);

    Ok(ParseFileResult {
        symbols,
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

    for file_result in parsed {
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

    let mut ranked: Vec<(i32, SymbolEntry)> = index
        .by_symbol
        .iter()
        .filter_map(|(name, entries)| {
            fuzzy_score(query, name).map(|score| {
                let first = entries.first().cloned().unwrap_or(SymbolEntry {
                    name: name.clone(),
                    kind: "unknown".to_string(),
                    file_path: String::new(),
                    line_number: 1,
                    container_name: None,
                });
                (score, first)
            })
        })
        .collect();

    ranked.sort_by(|left, right| right.0.cmp(&left.0));

    Ok(ranked
        .into_iter()
        .take(limit.max(1))
        .map(|(_, entry)| entry)
        .collect())
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

#[cfg(feature = "napi")]
mod napi_bridge {
    use super::{
        get_diagnostics, get_memory_usage, index_files, parse_file, query_symbols, DiagnosticEntry,
        FileInput, IndexSnapshot, MemoryUsage, ParseFileResult, SymbolEntry,
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
        pub heap_bytes: u64,
        pub native_rss_bytes: u64,
        pub total_bytes: u64,
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
                heap_bytes: usage.heap_bytes,
                native_rss_bytes: usage.native_rss_bytes,
                total_bytes: usage.total_bytes,
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
