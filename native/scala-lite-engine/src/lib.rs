use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
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
    pub accounted_bytes: u64,
    pub estimated_overhead_bytes: u64,
    pub native_rss_bytes: u64,
    pub total_bytes: u64,
    pub includes: String,
    pub excludes: String,
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
    pub by_symbol: HashMap<u32, Vec<InternedSymbolEntry>>,
    pub diagnostics_by_file: HashMap<u32, Vec<InternedDiagnosticEntry>>,
    pub imports_by_file: HashMap<u32, Vec<InternedImportEntry>>,
    pub package_by_file: HashMap<u32, u32>,
    pub string_interner: StringInterner,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct StringInterner {
    pub strings: Vec<String>,
    pub lookup: HashMap<String, u32>,
}

impl StringInterner {
    fn intern(&mut self, value: &str) -> u32 {
        if let Some(existing) = self.lookup.get(value) {
            return *existing;
        }

        let id = self.strings.len() as u32;
        let owned = value.to_string();
        self.strings.push(owned.clone());
        self.lookup.insert(owned, id);
        id
    }

    fn resolve(&self, id: u32) -> Option<&str> {
        self.strings.get(id as usize).map(String::as_str)
    }

    fn lookup_id(&self, value: &str) -> Option<u32> {
        self.lookup.get(value).copied()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum InternedSymbolKind {
    Package = 0,
    Object = 1,
    Class = 2,
    Trait = 3,
    Enum = 4,
    Def = 5,
    Val = 6,
    Var = 7,
    Type = 8,
    Given = 9,
    Param = 10,
    Unknown = 255,
}

impl InternedSymbolKind {
    fn from_wire(kind: &str) -> Self {
        match kind {
            "package" => Self::Package,
            "object" => Self::Object,
            "class" => Self::Class,
            "trait" => Self::Trait,
            "enum" => Self::Enum,
            "def" => Self::Def,
            "val" => Self::Val,
            "var" => Self::Var,
            "type" => Self::Type,
            "given" => Self::Given,
            "param" => Self::Param,
            _ => Self::Unknown,
        }
    }

    fn as_wire(self) -> &'static str {
        match self {
            Self::Package => "package",
            Self::Object => "object",
            Self::Class => "class",
            Self::Trait => "trait",
            Self::Enum => "enum",
            Self::Def => "def",
            Self::Val => "val",
            Self::Var => "var",
            Self::Type => "type",
            Self::Given => "given",
            Self::Param => "param",
            Self::Unknown => "def",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum InternedVisibility {
    Public = 0,
    Protected = 1,
    Private = 2,
    Unknown = 255,
}

impl InternedVisibility {
    fn from_wire(visibility: &str) -> Self {
        match visibility {
            "public" => Self::Public,
            "protected" => Self::Protected,
            "private" => Self::Private,
            _ => Self::Unknown,
        }
    }

    fn as_wire(self) -> &'static str {
        match self {
            Self::Public => "public",
            Self::Protected => "protected",
            Self::Private => "private",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct InternedSymbolEntry {
    pub name_id: u32,
    pub kind: InternedSymbolKind,
    pub file_path_id: u32,
    pub line_number: u32,
    pub container_name_id: Option<u32>,
    pub package_name_id: u32,
    pub visibility: InternedVisibility,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum InternedDiagnosticSeverity {
    Error = 0,
    Warning = 1,
    Info = 2,
    Hint = 3,
    Unknown = 255,
}

impl InternedDiagnosticSeverity {
    fn from_wire(severity: &str) -> Self {
        match severity {
            "error" => Self::Error,
            "warning" => Self::Warning,
            "information" => Self::Info,
            "hint" => Self::Hint,
            _ => Self::Unknown,
        }
    }

    fn as_wire(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Warning => "warning",
            Self::Info => "information",
            Self::Hint => "hint",
            Self::Unknown => "error",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct InternedDiagnosticEntry {
    pub line_number: u32,
    pub column: u32,
    pub severity: InternedDiagnosticSeverity,
    pub message_id: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct InternedImportEntry {
    pub package_path_id: u32,
    pub imported_name_id: Option<u32>,
    pub source_symbol_name_id: Option<u32>,
    pub is_wildcard: bool,
    pub line_number: u32,
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

        records.extend(parse_import_statement(
            file_path,
            &statement,
            (index + 1) as u32,
        ));
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
    let mut snapshot = IndexSnapshot::default();
    append_files(&mut snapshot, files)?;
    Ok(snapshot)
}

fn evict_file_from_snapshot(index: &mut IndexSnapshot, file_path: &str) {
    if let Some(file_path_id) = index.string_interner.lookup_id(file_path) {
        index
            .by_symbol
            .values_mut()
            .for_each(|entries| entries.retain(|entry| entry.file_path_id != file_path_id));
        index.by_symbol.retain(|_, entries| !entries.is_empty());

        index.diagnostics_by_file.remove(&file_path_id);
        index.imports_by_file.remove(&file_path_id);
        index.package_by_file.remove(&file_path_id);

        if index.by_symbol.is_empty()
            && index.diagnostics_by_file.is_empty()
            && index.imports_by_file.is_empty()
            && index.package_by_file.is_empty()
        {
            index.string_interner.strings.clear();
            index.string_interner.lookup.clear();
            return;
        }

        compact_string_interner(index);
    }
}

fn compact_string_interner(index: &mut IndexSnapshot) {
    let mut used: HashSet<u32> = HashSet::new();

    for (name_id, entries) in &index.by_symbol {
        used.insert(*name_id);
        for entry in entries {
            used.insert(entry.file_path_id);
            if let Some(container_name_id) = entry.container_name_id {
                used.insert(container_name_id);
            }
            used.insert(entry.package_name_id);
        }
    }

    for (file_id, entries) in &index.diagnostics_by_file {
        used.insert(*file_id);
        for entry in entries {
            used.insert(entry.message_id);
        }
    }

    for (file_id, entries) in &index.imports_by_file {
        used.insert(*file_id);
        for entry in entries {
            used.insert(entry.package_path_id);
            if let Some(imported_name_id) = entry.imported_name_id {
                used.insert(imported_name_id);
            }
            if let Some(source_symbol_name_id) = entry.source_symbol_name_id {
                used.insert(source_symbol_name_id);
            }
        }
    }

    for (file_id, package_id) in &index.package_by_file {
        used.insert(*file_id);
        used.insert(*package_id);
    }

    if used.is_empty() {
        index.string_interner.strings.clear();
        index.string_interner.lookup.clear();
        return;
    }

    let mut used_sorted: Vec<u32> = used.into_iter().collect();
    used_sorted.sort_unstable();

    let mut id_map: HashMap<u32, u32> = HashMap::new();
    let mut new_strings: Vec<String> = Vec::with_capacity(used_sorted.len());
    for old_id in used_sorted {
        if let Some(value) = index.string_interner.resolve(old_id) {
            let new_id = new_strings.len() as u32;
            new_strings.push(value.to_string());
            id_map.insert(old_id, new_id);
        }
    }

    let mut new_lookup: HashMap<String, u32> = HashMap::with_capacity(new_strings.len());
    for (new_id, value) in new_strings.iter().enumerate() {
        new_lookup.insert(value.clone(), new_id as u32);
    }

    let remap = |id: u32, id_map: &HashMap<u32, u32>| -> Option<u32> { id_map.get(&id).copied() };

    let mut new_by_symbol: HashMap<u32, Vec<InternedSymbolEntry>> =
        HashMap::with_capacity(index.by_symbol.len());
    for (old_name_id, entries) in &index.by_symbol {
        let new_name_id = match remap(*old_name_id, &id_map) {
            Some(value) => value,
            None => continue,
        };

        let mut remapped_entries: Vec<InternedSymbolEntry> = Vec::with_capacity(entries.len());
        for entry in entries {
            let Some(file_path_id) = remap(entry.file_path_id, &id_map) else {
                continue;
            };
            let package_name_id = match remap(entry.package_name_id, &id_map) {
                Some(value) => value,
                None => continue,
            };
            let container_name_id = entry.container_name_id.and_then(|id| remap(id, &id_map));

            remapped_entries.push(InternedSymbolEntry {
                name_id: new_name_id,
                kind: entry.kind,
                file_path_id,
                line_number: entry.line_number,
                container_name_id,
                package_name_id,
                visibility: entry.visibility,
            });
        }

        if !remapped_entries.is_empty() {
            new_by_symbol.insert(new_name_id, remapped_entries);
        }
    }

    let mut new_diagnostics_by_file: HashMap<u32, Vec<InternedDiagnosticEntry>> =
        HashMap::with_capacity(index.diagnostics_by_file.len());
    for (old_file_id, entries) in &index.diagnostics_by_file {
        let Some(new_file_id) = remap(*old_file_id, &id_map) else {
            continue;
        };
        let mut remapped_entries: Vec<InternedDiagnosticEntry> = Vec::with_capacity(entries.len());

        for entry in entries {
            let Some(message_id) = remap(entry.message_id, &id_map) else {
                continue;
            };
            remapped_entries.push(InternedDiagnosticEntry {
                line_number: entry.line_number,
                column: entry.column,
                severity: entry.severity,
                message_id,
            });
        }

        if !remapped_entries.is_empty() {
            new_diagnostics_by_file.insert(new_file_id, remapped_entries);
        }
    }

    let mut new_imports_by_file: HashMap<u32, Vec<InternedImportEntry>> =
        HashMap::with_capacity(index.imports_by_file.len());
    for (old_file_id, entries) in &index.imports_by_file {
        let Some(new_file_id) = remap(*old_file_id, &id_map) else {
            continue;
        };
        let mut remapped_entries: Vec<InternedImportEntry> = Vec::with_capacity(entries.len());

        for entry in entries {
            let Some(package_path_id) = remap(entry.package_path_id, &id_map) else {
                continue;
            };
            let imported_name_id = entry.imported_name_id.and_then(|id| remap(id, &id_map));
            let source_symbol_name_id = entry
                .source_symbol_name_id
                .and_then(|id| remap(id, &id_map));

            remapped_entries.push(InternedImportEntry {
                package_path_id,
                imported_name_id,
                source_symbol_name_id,
                is_wildcard: entry.is_wildcard,
                line_number: entry.line_number,
            });
        }

        if !remapped_entries.is_empty() {
            new_imports_by_file.insert(new_file_id, remapped_entries);
        }
    }

    let mut new_package_by_file: HashMap<u32, u32> =
        HashMap::with_capacity(index.package_by_file.len());
    for (old_file_id, old_package_id) in &index.package_by_file {
        if let (Some(new_file_id), Some(new_package_id)) = (
            remap(*old_file_id, &id_map),
            remap(*old_package_id, &id_map),
        ) {
            new_package_by_file.insert(new_file_id, new_package_id);
        }
    }

    index.by_symbol = new_by_symbol;
    index.diagnostics_by_file = new_diagnostics_by_file;
    index.imports_by_file = new_imports_by_file;
    index.package_by_file = new_package_by_file;
    index.string_interner = StringInterner {
        strings: new_strings,
        lookup: new_lookup,
    };
}

fn current_symbol_total(index: &IndexSnapshot) -> u32 {
    index
        .by_symbol
        .values()
        .map(std::vec::Vec::len)
        .sum::<usize>() as u32
}

pub fn append_files(index: &mut IndexSnapshot, files: &[FileInput]) -> Result<u32, EngineError> {
    let parsed: Result<Vec<ParseFileResult>, EngineError> = files
        .par_iter()
        .map(|file| parse_file(&file.file_path, &file.content))
        .collect();

    let parsed = parsed?;

    for file_result in parsed {
        evict_file_from_snapshot(index, &file_result.file_path);

        let file_path_id = index.string_interner.intern(&file_result.file_path);

        for import in file_result.imports {
            let package_path_id = index.string_interner.intern(&import.package_path);
            let imported_name_id = import
                .imported_name
                .as_deref()
                .map(|value| index.string_interner.intern(value));
            let source_symbol_name_id = import
                .source_symbol_name
                .as_deref()
                .map(|value| index.string_interner.intern(value));

            index
                .imports_by_file
                .entry(file_path_id)
                .or_default()
                .push(InternedImportEntry {
                    package_path_id,
                    imported_name_id,
                    source_symbol_name_id,
                    is_wildcard: import.is_wildcard,
                    line_number: import.line_number,
                });
        }

        if let Some(package_symbol) = file_result
            .symbols
            .iter()
            .find(|entry| entry.kind == "package")
        {
            let package_name_id = index.string_interner.intern(&package_symbol.package_name);
            index.package_by_file.insert(file_path_id, package_name_id);
        }

        for symbol in file_result.symbols {
            let name_id = index.string_interner.intern(&symbol.name);
            let package_name_id = index.string_interner.intern(&symbol.package_name);
            let container_name_id = symbol
                .container_name
                .as_deref()
                .map(|value| index.string_interner.intern(value));

            let entry = InternedSymbolEntry {
                name_id,
                kind: InternedSymbolKind::from_wire(&symbol.kind),
                file_path_id,
                line_number: symbol.line_number,
                container_name_id,
                package_name_id,
                visibility: InternedVisibility::from_wire(&symbol.visibility),
            };

            index.by_symbol.entry(name_id).or_default().push(entry);
        }

        for diagnostic in file_result.diagnostics {
            let message_id = index.string_interner.intern(&diagnostic.message);
            index
                .diagnostics_by_file
                .entry(file_path_id)
                .or_default()
                .push(InternedDiagnosticEntry {
                    line_number: diagnostic.line_number,
                    column: diagnostic.column,
                    severity: InternedDiagnosticSeverity::from_wire(&diagnostic.severity),
                    message_id,
                });
        }
    }

    Ok(current_symbol_total(index))
}

fn materialize_symbol_entry(
    index: &IndexSnapshot,
    entry: &InternedSymbolEntry,
) -> Option<SymbolEntry> {
    let name = index.string_interner.resolve(entry.name_id)?.to_string();
    let file_path = index
        .string_interner
        .resolve(entry.file_path_id)?
        .to_string();
    let package_name = index
        .string_interner
        .resolve(entry.package_name_id)?
        .to_string();
    let container_name = entry
        .container_name_id
        .and_then(|id| index.string_interner.resolve(id).map(str::to_string));

    Some(SymbolEntry {
        name,
        kind: entry.kind.as_wire().to_string(),
        file_path,
        line_number: entry.line_number,
        container_name,
        package_name,
        visibility: entry.visibility.as_wire().to_string(),
    })
}

fn materialize_diagnostic_entry(
    index: &IndexSnapshot,
    file_path: &str,
    entry: &InternedDiagnosticEntry,
) -> Option<DiagnosticEntry> {
    Some(DiagnosticEntry {
        file_path: file_path.to_string(),
        line_number: entry.line_number,
        column: entry.column,
        severity: entry.severity.as_wire().to_string(),
        message: index.string_interner.resolve(entry.message_id)?.to_string(),
    })
}

#[allow(dead_code)]
fn materialize_import_entry(
    index: &IndexSnapshot,
    file_path: &str,
    entry: &InternedImportEntry,
) -> Option<ImportEntry> {
    Some(ImportEntry {
        file_path: file_path.to_string(),
        package_path: index
            .string_interner
            .resolve(entry.package_path_id)?
            .to_string(),
        imported_name: entry
            .imported_name_id
            .and_then(|id| index.string_interner.resolve(id).map(str::to_string)),
        source_symbol_name: entry
            .source_symbol_name_id
            .and_then(|id| index.string_interner.resolve(id).map(str::to_string)),
        is_wildcard: entry.is_wildcard,
        line_number: entry.line_number,
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

    let Some(query_id) = index.string_interner.lookup_id(query) else {
        return Ok(Vec::new());
    };

    let mut matched = index
        .by_symbol
        .get(&query_id)
        .into_iter()
        .flat_map(|entries| entries.iter())
        .filter_map(|entry| materialize_symbol_entry(index, entry))
        .filter(|entry| entry.package_name == package_path)
        .collect::<Vec<_>>();

    matched.sort_by(compare_symbol_entries);
    Ok(matched.into_iter().take(limit.max(1)).collect())
}

pub fn query_package_exists(index: &IndexSnapshot, package_path: &str) -> bool {
    if package_path.trim().is_empty() {
        return false;
    }

    index.by_symbol.values().any(|entries| {
        entries.iter().any(|entry| {
            index
                .string_interner
                .resolve(entry.package_name_id)
                .map(|value| value == package_path)
                .unwrap_or(false)
        })
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

    if let Some(query_id) = index.string_interner.lookup_id(query) {
        if let Some(exact_entries) = index.by_symbol.get(&query_id) {
            let mut sorted = exact_entries
                .iter()
                .filter_map(|entry| materialize_symbol_entry(index, entry))
                .collect::<Vec<_>>();
            sorted.sort_by(compare_symbol_entries);
            return Ok(sorted.into_iter().take(capped_limit).collect());
        }
    }

    let mut ranked_buckets: Vec<(i32, String, Vec<SymbolEntry>)> = index
        .by_symbol
        .iter()
        .filter_map(|(name_id, entries)| {
            let name = index.string_interner.resolve(*name_id)?;
            fuzzy_score(query, name).map(|score| {
                let mut sorted_entries = entries
                    .iter()
                    .filter_map(|entry| materialize_symbol_entry(index, entry))
                    .collect::<Vec<_>>();
                sorted_entries.sort_by(compare_symbol_entries);
                (score, name.to_string(), sorted_entries)
            })
        })
        .collect();

    ranked_buckets.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));

    Ok(ranked_buckets
        .into_iter()
        .flat_map(|(_, _, entries)| entries)
        .take(capped_limit)
        .collect())
}

fn compare_symbol_entries(left: &SymbolEntry, right: &SymbolEntry) -> std::cmp::Ordering {
    left.file_path
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
    let Some(file_path_id) = index.string_interner.lookup_id(file_path) else {
        return Ok(Vec::new());
    };

    Ok(index
        .diagnostics_by_file
        .get(&file_path_id)
        .into_iter()
        .flat_map(|entries| entries.iter())
        .filter_map(|entry| materialize_diagnostic_entry(index, file_path, entry))
        .collect())
}

pub fn get_memory_usage(index: &IndexSnapshot) -> Result<MemoryUsage, EngineError> {
    fn map_bucket_overhead<K, V>(map: &HashMap<K, V>) -> u64 {
        (map.capacity() * std::mem::size_of::<(K, V)>()) as u64
    }

    fn string_allocated_bytes(value: &String) -> u64 {
        value.capacity() as u64
    }

    let mut accounted_bytes = 0u64;

    accounted_bytes += map_bucket_overhead(&index.by_symbol);
    for entries in index.by_symbol.values() {
        accounted_bytes += (entries.capacity() * std::mem::size_of::<InternedSymbolEntry>()) as u64;
    }

    accounted_bytes +=
        (index.string_interner.strings.capacity() * std::mem::size_of::<String>()) as u64;
    accounted_bytes +=
        (index.string_interner.lookup.capacity() * std::mem::size_of::<(String, u32)>()) as u64;
    for value in &index.string_interner.strings {
        accounted_bytes += string_allocated_bytes(value);
    }
    for key in index.string_interner.lookup.keys() {
        accounted_bytes += string_allocated_bytes(key);
    }

    accounted_bytes += map_bucket_overhead(&index.diagnostics_by_file);
    for diagnostics in index.diagnostics_by_file.values() {
        accounted_bytes +=
            (diagnostics.capacity() * std::mem::size_of::<InternedDiagnosticEntry>()) as u64;
    }

    accounted_bytes += map_bucket_overhead(&index.imports_by_file);
    for imports in index.imports_by_file.values() {
        accounted_bytes += (imports.capacity() * std::mem::size_of::<InternedImportEntry>()) as u64;
    }

    accounted_bytes += map_bucket_overhead(&index.package_by_file);

    let estimated_overhead_bytes = accounted_bytes / 5;
    let native_rss_bytes = accounted_bytes + estimated_overhead_bytes;
    let heap_bytes = 0u64;

    Ok(MemoryUsage {
        heap_bytes,
        accounted_bytes,
        estimated_overhead_bytes,
        native_rss_bytes,
        total_bytes: heap_bytes + native_rss_bytes,
        includes: "interned symbol entries, string table, diagnostic entries, import entries, package map, HashMap bucket arrays".to_string(),
        excludes: "allocator metadata, fragmentation beyond estimate, thread-local caches, stack usage".to_string(),
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

    #[test]
    fn get_memory_usage_reports_non_zero_for_non_empty_index() {
        let files = vec![FileInput {
            file_path: "/tmp/a.scala".to_string(),
            content: "package demo\nclass User\n".to_string(),
        }];

        let index = index_files(&files).expect("index_files should succeed");
        let usage = get_memory_usage(&index).expect("get_memory_usage should succeed");

        assert!(usage.accounted_bytes > 0);
        assert!(usage.native_rss_bytes >= usage.accounted_bytes);
        assert!(!usage.includes.is_empty());
        assert!(!usage.excludes.is_empty());
    }

    #[test]
    fn get_diagnostics_materializes_from_interned_storage() {
        let files = vec![FileInput {
            file_path: "/tmp/a.scala".to_string(),
            content: "object Demo {\n  def broken( = 1\n}\n".to_string(),
        }];

        let index = index_files(&files).expect("index_files should succeed");
        let diagnostics =
            get_diagnostics(&index, "/tmp/a.scala").expect("get_diagnostics should succeed");

        assert!(!diagnostics.is_empty());
        assert!(diagnostics
            .iter()
            .any(|entry| { entry.file_path == "/tmp/a.scala" && entry.severity == "error" }));
    }

    #[test]
    fn evict_compacts_string_interner_after_removal() {
        let files = vec![
            FileInput {
                file_path: "/tmp/a.scala".to_string(),
                content: "package demo\nclass A\n".to_string(),
            },
            FileInput {
                file_path: "/tmp/b.scala".to_string(),
                content: "package demo\nclass B\n".to_string(),
            },
        ];

        let mut index = index_files(&files).expect("index_files should succeed");
        let initial_string_count = index.string_interner.strings.len();

        evict_file_from_snapshot(&mut index, "/tmp/a.scala");

        // Ensure the remaining file is still indexed and interner compacted.
        let remaining = query_symbols(&index, "B", 10).expect("query_symbols should succeed");
        assert_eq!(remaining.len(), 1);
        assert!(remaining
            .iter()
            .all(|entry| entry.file_path == "/tmp/b.scala"));

        let after_evict_count = index.string_interner.strings.len();
        assert!(after_evict_count < initial_string_count);
    }
}

#[cfg(feature = "napi")]
mod napi_bridge {
    use super::{
        append_files, get_diagnostics, get_memory_usage, parse_file, query_package_exists,
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
        pub accounted_bytes: i64,
        pub estimated_overhead_bytes: i64,
        pub native_rss_bytes: i64,
        pub total_bytes: i64,
        pub includes: String,
        pub excludes: String,
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

            let mut guard = self
                .inner
                .lock()
                .map_err(|_| Error::from_reason("engine lock poisoned".to_string()))?;
            *guard = IndexSnapshot::default();
            let symbol_total = append_files(&mut guard, &mapped)
                .map_err(|error| Error::from_reason(error.to_string()))?;
            Ok(symbol_total)
        }

        #[napi]
        pub fn append_files(&self, files: Vec<JsFileInput>) -> Result<u32> {
            let mapped: Vec<FileInput> = files
                .into_iter()
                .map(|file| FileInput {
                    file_path: file.file_path,
                    content: file.content,
                })
                .collect();

            let mut guard = self
                .inner
                .lock()
                .map_err(|_| Error::from_reason("engine lock poisoned".to_string()))?;
            append_files(&mut guard, &mapped).map_err(|error| Error::from_reason(error.to_string()))
        }

        #[napi]
        pub fn clear_index(&self) -> Result<()> {
            let mut guard = self
                .inner
                .lock()
                .map_err(|_| Error::from_reason("engine lock poisoned".to_string()))?;
            *guard = IndexSnapshot::default();
            Ok(())
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

            super::evict_file_from_snapshot(&mut guard, &file_path);
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
                accounted_bytes: usage.accounted_bytes.min(i64::MAX as u64) as i64,
                estimated_overhead_bytes: usage.estimated_overhead_bytes.min(i64::MAX as u64)
                    as i64,
                native_rss_bytes: usage.native_rss_bytes.min(i64::MAX as u64) as i64,
                total_bytes: usage.total_bytes.min(i64::MAX as u64) as i64,
                includes: usage.includes,
                excludes: usage.excludes,
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
