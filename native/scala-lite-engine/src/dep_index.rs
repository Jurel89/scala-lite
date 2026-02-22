use crate::EngineError;
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::hash::{Hash, Hasher};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

const DEPENDENCY_INDEX_MAGIC: &[u8; 8] = b"SLDEPIDX";
pub const DEPENDENCY_INDEX_SCHEMA_VERSION: u16 = 2;
const SEGMENT_BUCKETS: u16 = 256;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JarManifest {
    pub jar_path: String,
    pub hash: u64,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum ClassKind {
    Class = 0,
    Interface = 1,
    Trait = 2,
    Object = 3,
    Enum = 4,
    Annotation = 5,
    Unknown = 255,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum Visibility {
    Public = 0,
    Protected = 1,
    Private = 2,
    Unknown = 255,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DependencySymbolInput {
    pub simple_name: String,
    pub fqcn: String,
    pub package_name: String,
    pub kind: ClassKind,
    pub visibility: Visibility,
    pub jar_path: String,
    pub method_count: u16,
    pub field_count: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DependencySymbol {
    pub simple_name: String,
    pub fqcn: String,
    pub package_name: String,
    pub kind: ClassKind,
    pub visibility: Visibility,
    pub jar_path: String,
    pub method_count: u16,
    pub field_count: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct DepSymbolEntry {
    pub simple_name_id: u32,
    pub fqcn_id: u32,
    pub package_id: u32,
    pub kind: ClassKind,
    pub visibility: Visibility,
    pub jar_index: u16,
    pub method_count: u16,
    pub field_count: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct DepSegment {
    pub by_simple_name: HashMap<u32, Vec<DepSymbolEntry>>,
    pub by_fqcn: HashMap<u32, DepSymbolEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SegmentLookupEntry {
    pub segment_key: u16,
    pub offset: u64,
    pub length: u64,
    pub symbol_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DepIndexHeader {
    pub schema_version: u16,
    pub jar_manifests: Vec<JarManifest>,
    pub string_table: Vec<String>,
    pub simple_name_lookup: HashMap<u32, Vec<u16>>,
    pub fqcn_lookup: HashMap<u32, u16>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DependencySnapshot {
    pub schema_version: u16,
    pub jar_manifests: Vec<JarManifest>,
    pub segment_table: Vec<SegmentLookupEntry>,
    pub string_table: Vec<String>,
    pub simple_name_lookup: HashMap<u32, Vec<u16>>,
    pub fqcn_lookup: HashMap<u32, u16>,
    pub(crate) index_path: Option<PathBuf>,
    pub(crate) loaded_segments: RefCell<HashMap<u16, DepSegment>>,
    pub(crate) access_order: RefCell<Vec<u16>>,
    pub(crate) max_loaded_segments: RefCell<Option<usize>>,
    pub(crate) string_id_lookup: HashMap<String, u32>,
    pub(crate) normalized_simple_name_lookup: HashMap<String, Vec<u16>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct DependencyIndexTable {
    pub entries: Vec<SegmentLookupEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DepIndexStats {
    pub schema_version: u16,
    pub jar_count: usize,
    pub segment_count: usize,
    pub loaded_segment_count: usize,
    pub symbol_count: usize,
}

#[derive(Debug, Default)]
struct StringIdMap {
    ids: HashMap<String, u32>,
    values: Vec<String>,
}

impl StringIdMap {
    fn intern(&mut self, value: &str) -> u32 {
        if let Some(existing) = self.ids.get(value) {
            return *existing;
        }

        let identifier = self.values.len() as u32;
        let owned = value.to_string();
        self.values.push(owned.clone());
        self.ids.insert(owned, identifier);
        identifier
    }
}

fn segment_key_for_package(package_name: &str) -> u16 {
    let mut hasher = DefaultHasher::new();
    package_name.hash(&mut hasher);
    (hasher.finish() % SEGMENT_BUCKETS as u64) as u16
}

fn resolve_string(strings: &[String], identifier: u32) -> Option<&str> {
    strings.get(identifier as usize).map(String::as_str)
}

fn build_normalized_simple_name_lookup(
    simple_name_lookup: &HashMap<u32, Vec<u16>>,
    string_table: &[String],
) -> HashMap<String, Vec<u16>> {
    let mut lookup = HashMap::<String, HashSet<u16>>::new();

    for (simple_name_id, segments) in simple_name_lookup {
        let Some(simple_name) = resolve_string(string_table, *simple_name_id) else {
            continue;
        };

        let normalized = simple_name.to_lowercase();
        let entry = lookup.entry(normalized).or_default();
        for segment in segments {
            entry.insert(*segment);
        }
    }

    lookup
        .into_iter()
        .map(|(name, segments)| {
            let mut sorted = segments.into_iter().collect::<Vec<u16>>();
            sorted.sort_unstable();
            (name, sorted)
        })
        .collect::<HashMap<String, Vec<u16>>>()
}

fn ensure_segment_loaded(
    snapshot: &DependencySnapshot,
    segment_key: u16,
) -> Result<(), EngineError> {
    if snapshot.loaded_segments.borrow().contains_key(&segment_key) {
        touch_segment(snapshot, segment_key);
        return Ok(());
    }

    let Some(path) = &snapshot.index_path else {
        return Err(EngineError::InvalidDependencyIndex(
            "segment is not loaded and snapshot has no backing file".to_string(),
        ));
    };

    let Some(entry) = snapshot
        .segment_table
        .iter()
        .find(|candidate| candidate.segment_key == segment_key)
        .copied()
    else {
        return Ok(());
    };

    let mut file = File::open(path).map_err(|error| EngineError::Io(error.to_string()))?;
    file.seek(SeekFrom::Start(entry.offset))
        .map_err(|error| EngineError::Io(error.to_string()))?;

    let mut bytes = vec![0u8; entry.length as usize];
    file.read_exact(&mut bytes)
        .map_err(|error| EngineError::Io(error.to_string()))?;

    let segment: DepSegment = bincode::deserialize(&bytes)
        .map_err(|error| EngineError::Deserialization(error.to_string()))?;
    snapshot
        .loaded_segments
        .borrow_mut()
        .insert(segment_key, segment);
    touch_segment(snapshot, segment_key);
    enforce_loaded_segment_limit(snapshot);
    Ok(())
}

fn touch_segment(snapshot: &DependencySnapshot, segment_key: u16) {
    let mut order = snapshot.access_order.borrow_mut();
    order.retain(|existing| *existing != segment_key);
    order.push(segment_key);
}

fn enforce_loaded_segment_limit(snapshot: &DependencySnapshot) {
    let Some(max_segments) = *snapshot.max_loaded_segments.borrow() else {
        return;
    };

    if max_segments == 0 {
        snapshot.loaded_segments.borrow_mut().clear();
        snapshot.access_order.borrow_mut().clear();
        return;
    }

    let mut loaded = snapshot.loaded_segments.borrow_mut();
    let mut order = snapshot.access_order.borrow_mut();
    while loaded.len() > max_segments {
        if order.is_empty() {
            break;
        }

        let oldest = order.remove(0);
        loaded.remove(&oldest);
    }
}

pub fn set_dependency_index_max_loaded_segments(
    snapshot: &DependencySnapshot,
    max_segments: Option<usize>,
) {
    *snapshot.max_loaded_segments.borrow_mut() = max_segments;
    enforce_loaded_segment_limit(snapshot);
}

pub fn evict_dependency_index_segments(
    snapshot: &DependencySnapshot,
    max_segments: usize,
) -> usize {
    let before = snapshot.loaded_segments.borrow().len();
    set_dependency_index_max_loaded_segments(snapshot, Some(max_segments));
    let after = snapshot.loaded_segments.borrow().len();
    before.saturating_sub(after)
}

fn materialize_symbol(
    snapshot: &DependencySnapshot,
    entry: &DepSymbolEntry,
) -> Option<DependencySymbol> {
    let simple_name = resolve_string(&snapshot.string_table, entry.simple_name_id)?.to_string();
    let fqcn = resolve_string(&snapshot.string_table, entry.fqcn_id)?.to_string();
    let package_name = resolve_string(&snapshot.string_table, entry.package_id)?.to_string();
    let jar_path = snapshot
        .jar_manifests
        .get(entry.jar_index as usize)
        .map(|manifest| manifest.jar_path.clone())?;

    Some(DependencySymbol {
        simple_name,
        fqcn,
        package_name,
        kind: entry.kind,
        visibility: entry.visibility,
        jar_path,
        method_count: entry.method_count,
        field_count: entry.field_count,
    })
}

pub fn build_dependency_snapshot(
    symbols: &[DependencySymbolInput],
    jar_manifests: &[JarManifest],
) -> DependencySnapshot {
    let mut jar_index_by_path = HashMap::<String, u16>::new();
    for (index, manifest) in jar_manifests.iter().enumerate() {
        jar_index_by_path.insert(manifest.jar_path.clone(), index as u16);
    }

    let mut string_ids = StringIdMap::default();
    let mut segments = HashMap::<u16, DepSegment>::new();
    let mut simple_name_lookup = HashMap::<u32, HashSet<u16>>::new();
    let mut fqcn_lookup = HashMap::<u32, u16>::new();

    for symbol in symbols {
        let simple_name_id = string_ids.intern(&symbol.simple_name);
        let fqcn_id = string_ids.intern(&symbol.fqcn);
        let package_id = string_ids.intern(&symbol.package_name);
        let jar_index = *jar_index_by_path.get(&symbol.jar_path).unwrap_or(&0);

        let entry = DepSymbolEntry {
            simple_name_id,
            fqcn_id,
            package_id,
            kind: symbol.kind,
            visibility: symbol.visibility,
            jar_index,
            method_count: symbol.method_count,
            field_count: symbol.field_count,
        };

        let segment_key = segment_key_for_package(&symbol.package_name);
        let segment = segments.entry(segment_key).or_default();
        segment
            .by_simple_name
            .entry(simple_name_id)
            .or_default()
            .push(entry);
        segment.by_fqcn.entry(fqcn_id).or_insert(entry);

        simple_name_lookup
            .entry(simple_name_id)
            .or_default()
            .insert(segment_key);
        fqcn_lookup.entry(fqcn_id).or_insert(segment_key);
    }

    let simple_name_lookup = simple_name_lookup
        .into_iter()
        .map(|(name_id, keys)| {
            let mut sorted_keys: Vec<u16> = keys.into_iter().collect();
            sorted_keys.sort_unstable();
            (name_id, sorted_keys)
        })
        .collect::<HashMap<u32, Vec<u16>>>();

    let string_id_lookup = string_ids
        .values
        .iter()
        .enumerate()
        .map(|(index, value)| (value.clone(), index as u32))
        .collect::<HashMap<String, u32>>();

    let string_table = string_ids.values;
    let normalized_simple_name_lookup =
        build_normalized_simple_name_lookup(&simple_name_lookup, &string_table);

    DependencySnapshot {
        schema_version: DEPENDENCY_INDEX_SCHEMA_VERSION,
        jar_manifests: jar_manifests.to_vec(),
        segment_table: Vec::new(),
        string_table,
        simple_name_lookup,
        fqcn_lookup,
        index_path: None,
        loaded_segments: RefCell::new(segments),
        access_order: RefCell::new(Vec::new()),
        max_loaded_segments: RefCell::new(None),
        string_id_lookup,
        normalized_simple_name_lookup,
    }
}

pub fn save_dependency_index(path: &str, snapshot: &DependencySnapshot) -> Result<(), EngineError> {
    let target_path = Path::new(path);
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).map_err(|error| EngineError::Io(error.to_string()))?;
    }

    let mut segment_map = snapshot.loaded_segments.borrow().clone();
    for entry in &snapshot.segment_table {
        if segment_map.contains_key(&entry.segment_key) {
            continue;
        }

        ensure_segment_loaded(snapshot, entry.segment_key)?;
        if let Some(loaded) = snapshot.loaded_segments.borrow().get(&entry.segment_key) {
            segment_map.insert(entry.segment_key, loaded.clone());
        }
    }

    let mut keys: Vec<u16> = segment_map.keys().copied().collect();
    keys.sort_unstable();

    let mut segment_blobs = Vec::<(u16, Vec<u8>, u32)>::new();
    for key in keys {
        if let Some(segment) = segment_map.get(&key) {
            let blob = bincode::serialize(segment)
                .map_err(|error| EngineError::Serialization(error.to_string()))?;
            let symbol_count = segment
                .by_simple_name
                .values()
                .map(std::vec::Vec::len)
                .sum::<usize>() as u32;
            segment_blobs.push((key, blob, symbol_count));
        }
    }

    let header = DepIndexHeader {
        schema_version: snapshot.schema_version,
        jar_manifests: snapshot.jar_manifests.clone(),
        string_table: snapshot.string_table.clone(),
        simple_name_lookup: snapshot.simple_name_lookup.clone(),
        fqcn_lookup: snapshot.fqcn_lookup.clone(),
    };
    let header_bytes = bincode::serialize(&header)
        .map_err(|error| EngineError::Serialization(error.to_string()))?;

    let mut lookup_entries = Vec::<SegmentLookupEntry>::new();
    for (key, blob, symbol_count) in &segment_blobs {
        lookup_entries.push(SegmentLookupEntry {
            segment_key: *key,
            offset: 0,
            length: blob.len() as u64,
            symbol_count: *symbol_count,
        });
    }

    let mut table = DependencyIndexTable {
        entries: lookup_entries,
    };
    let provisional_table_bytes = bincode::serialize(&table)
        .map_err(|error| EngineError::Serialization(error.to_string()))?;

    let mut segment_offset = DEPENDENCY_INDEX_MAGIC.len() as u64
        + 4
        + header_bytes.len() as u64
        + 4
        + provisional_table_bytes.len() as u64;

    for entry in &mut table.entries {
        entry.offset = segment_offset;
        segment_offset += entry.length;
    }

    let table_bytes = bincode::serialize(&table)
        .map_err(|error| EngineError::Serialization(error.to_string()))?;

    let mut file = File::create(target_path).map_err(|error| EngineError::Io(error.to_string()))?;
    file.write_all(DEPENDENCY_INDEX_MAGIC)
        .map_err(|error| EngineError::Io(error.to_string()))?;
    file.write_all(&(header_bytes.len() as u32).to_le_bytes())
        .map_err(|error| EngineError::Io(error.to_string()))?;
    file.write_all(&header_bytes)
        .map_err(|error| EngineError::Io(error.to_string()))?;
    file.write_all(&(table_bytes.len() as u32).to_le_bytes())
        .map_err(|error| EngineError::Io(error.to_string()))?;
    file.write_all(&table_bytes)
        .map_err(|error| EngineError::Io(error.to_string()))?;

    for (_, blob, _) in &segment_blobs {
        file.write_all(blob)
            .map_err(|error| EngineError::Io(error.to_string()))?;
    }

    file.flush()
        .map_err(|error| EngineError::Io(error.to_string()))?;
    Ok(())
}

pub fn load_dependency_index(path: &str) -> Result<DependencySnapshot, EngineError> {
    let mut file = File::open(path).map_err(|error| EngineError::Io(error.to_string()))?;

    let mut magic = [0u8; 8];
    file.read_exact(&mut magic)
        .map_err(|error| EngineError::Io(error.to_string()))?;
    if &magic != DEPENDENCY_INDEX_MAGIC {
        return Err(EngineError::InvalidDependencyIndex(
            "dependency index magic header mismatch".to_string(),
        ));
    }

    let mut header_len_bytes = [0u8; 4];
    file.read_exact(&mut header_len_bytes)
        .map_err(|error| EngineError::Io(error.to_string()))?;
    let header_len = u32::from_le_bytes(header_len_bytes) as usize;

    let mut header_bytes = vec![0u8; header_len];
    file.read_exact(&mut header_bytes)
        .map_err(|error| EngineError::Io(error.to_string()))?;
    let header: DepIndexHeader = bincode::deserialize(&header_bytes)
        .map_err(|error| EngineError::Deserialization(error.to_string()))?;

    if header.schema_version != DEPENDENCY_INDEX_SCHEMA_VERSION {
        return Err(EngineError::UnsupportedSchemaVersion(header.schema_version));
    }

    let mut table_len_bytes = [0u8; 4];
    file.read_exact(&mut table_len_bytes)
        .map_err(|error| EngineError::Io(error.to_string()))?;
    let table_len = u32::from_le_bytes(table_len_bytes) as usize;

    let mut table_bytes = vec![0u8; table_len];
    file.read_exact(&mut table_bytes)
        .map_err(|error| EngineError::Io(error.to_string()))?;
    let table: DependencyIndexTable = bincode::deserialize(&table_bytes)
        .map_err(|error| EngineError::Deserialization(error.to_string()))?;

    let string_table = header.string_table;
    let simple_name_lookup = header.simple_name_lookup;
    let normalized_simple_name_lookup =
        build_normalized_simple_name_lookup(&simple_name_lookup, &string_table);
    let string_id_lookup = string_table
        .iter()
        .enumerate()
        .map(|(index, value)| (value.clone(), index as u32))
        .collect::<HashMap<String, u32>>();

    Ok(DependencySnapshot {
        schema_version: header.schema_version,
        jar_manifests: header.jar_manifests,
        segment_table: table.entries,
        string_id_lookup,
        string_table,
        simple_name_lookup,
        fqcn_lookup: header.fqcn_lookup,
        index_path: Some(PathBuf::from(path)),
        loaded_segments: RefCell::new(HashMap::new()),
        access_order: RefCell::new(Vec::new()),
        max_loaded_segments: RefCell::new(None),
        normalized_simple_name_lookup,
    })
}

pub fn query_dep_symbols(
    snapshot: &DependencySnapshot,
    name: &str,
    limit: u32,
) -> Result<Vec<DependencySymbol>, EngineError> {
    let normalized = name.trim().to_lowercase();
    if normalized.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }

    let mut results = Vec::<DependencySymbol>::new();
    let mut seen_fqcn = HashSet::<String>::new();

    let mut keys_set = HashSet::<u16>::new();
    if let Some(exact_segments) = snapshot.normalized_simple_name_lookup.get(&normalized) {
        for key in exact_segments {
            keys_set.insert(*key);
        }
    } else {
        for (simple_name, segments) in &snapshot.normalized_simple_name_lookup {
            if !simple_name.contains(&normalized) {
                continue;
            }

            for key in segments {
                keys_set.insert(*key);
            }
        }
    }

    let mut keys: Vec<u16> = keys_set.into_iter().collect();
    keys.sort_unstable();

    for key in keys {
        ensure_segment_loaded(snapshot, key)?;
        let loaded = snapshot.loaded_segments.borrow();
        let Some(segment) = loaded.get(&key) else {
            continue;
        };

        for (simple_name_id, entries) in &segment.by_simple_name {
            let Some(simple_name) = resolve_string(&snapshot.string_table, *simple_name_id) else {
                continue;
            };

            if !simple_name.to_lowercase().contains(&normalized) {
                continue;
            }

            for entry in entries {
                let Some(symbol) = materialize_symbol(snapshot, entry) else {
                    continue;
                };

                if !seen_fqcn.insert(symbol.fqcn.clone()) {
                    continue;
                }

                results.push(symbol);
                if results.len() >= limit as usize {
                    results.sort_by(|left, right| left.fqcn.cmp(&right.fqcn));
                    return Ok(results);
                }
            }
        }
    }

    results.sort_by(|left, right| left.fqcn.cmp(&right.fqcn));
    Ok(results)
}

pub fn query_dep_symbol_by_fqcn(
    snapshot: &DependencySnapshot,
    fqcn: &str,
) -> Result<Option<DependencySymbol>, EngineError> {
    let normalized = fqcn.trim();
    if normalized.is_empty() {
        return Ok(None);
    }

    let Some(fqcn_id) = snapshot.string_id_lookup.get(normalized).copied() else {
        return Ok(None);
    };

    let Some(segment_key) = snapshot.fqcn_lookup.get(&fqcn_id).copied() else {
        return Ok(None);
    };

    ensure_segment_loaded(snapshot, segment_key)?;
    let loaded = snapshot.loaded_segments.borrow();
    if let Some(segment) = loaded.get(&segment_key) {
        if let Some(entry) = segment.by_fqcn.get(&fqcn_id) {
            return Ok(materialize_symbol(snapshot, entry));
        }
    }

    Ok(None)
}

pub fn query_dep_symbols_in_package(
    snapshot: &DependencySnapshot,
    name: &str,
    package_name: &str,
    limit: u32,
) -> Result<Vec<DependencySymbol>, EngineError> {
    let normalized_name = name.trim().to_lowercase();
    let normalized_package = package_name.trim();

    if normalized_name.is_empty() || normalized_package.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }

    let mut all = query_dep_symbols(snapshot, name, limit.saturating_mul(4))?;
    all.retain(|entry| {
        entry.package_name == normalized_package
            && entry.simple_name.to_lowercase().contains(&normalized_name)
    });
    all.sort_by(|left, right| left.fqcn.cmp(&right.fqcn));
    all.truncate(limit as usize);
    Ok(all)
}

pub fn get_dep_index_stats(snapshot: &DependencySnapshot) -> DepIndexStats {
    let symbol_count = snapshot
        .segment_table
        .iter()
        .map(|entry| entry.symbol_count as usize)
        .sum::<usize>();

    DepIndexStats {
        schema_version: snapshot.schema_version,
        jar_count: snapshot.jar_manifests.len(),
        segment_count: snapshot.segment_table.len(),
        loaded_segment_count: snapshot.loaded_segments.borrow().len(),
        symbol_count,
    }
}

pub fn dependency_index_is_stale(
    snapshot: &DependencySnapshot,
    current_manifests: &[JarManifest],
) -> bool {
    if snapshot.jar_manifests.len() != current_manifests.len() {
        return true;
    }

    let expected = snapshot
        .jar_manifests
        .iter()
        .map(|manifest| {
            (
                manifest.jar_path.clone(),
                manifest.hash,
                manifest.size_bytes,
            )
        })
        .collect::<HashSet<(String, u64, u64)>>();

    let current = current_manifests
        .iter()
        .map(|manifest| {
            (
                manifest.jar_path.clone(),
                manifest.hash,
                manifest.size_bytes,
            )
        })
        .collect::<HashSet<(String, u64, u64)>>();

    expected != current
}

pub fn changed_jar_paths(
    snapshot: &DependencySnapshot,
    current_manifests: &[JarManifest],
) -> Vec<String> {
    let previous = snapshot
        .jar_manifests
        .iter()
        .map(|manifest| {
            (
                manifest.jar_path.clone(),
                (manifest.hash, manifest.size_bytes),
            )
        })
        .collect::<HashMap<String, (u64, u64)>>();

    let mut changed = Vec::<String>::new();
    for manifest in current_manifests {
        let is_changed = previous
            .get(&manifest.jar_path)
            .map(|(hash, size)| *hash != manifest.hash || *size != manifest.size_bytes)
            .unwrap_or(true);

        if is_changed {
            changed.push(manifest.jar_path.clone());
        }
    }

    changed.sort();
    changed.dedup();
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_path() -> String {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after epoch")
            .as_nanos();
        let base = std::env::temp_dir().join(format!("scala-lite-dep-index-{nanos}.bin"));
        base.to_string_lossy().into_owned()
    }

    #[test]
    fn segmented_snapshot_roundtrip_and_lazy_load() {
        let manifests = vec![
            JarManifest {
                jar_path: "/deps/a.jar".to_string(),
                hash: 10,
                size_bytes: 100,
            },
            JarManifest {
                jar_path: "/deps/b.jar".to_string(),
                hash: 20,
                size_bytes: 200,
            },
        ];

        let symbols = vec![
            DependencySymbolInput {
                simple_name: "Future".to_string(),
                fqcn: "scala.concurrent.Future".to_string(),
                package_name: "scala.concurrent".to_string(),
                kind: ClassKind::Trait,
                visibility: Visibility::Public,
                jar_path: "/deps/a.jar".to_string(),
                method_count: 12,
                field_count: 1,
            },
            DependencySymbolInput {
                simple_name: "Option".to_string(),
                fqcn: "scala.Option".to_string(),
                package_name: "scala".to_string(),
                kind: ClassKind::Class,
                visibility: Visibility::Public,
                jar_path: "/deps/b.jar".to_string(),
                method_count: 8,
                field_count: 2,
            },
        ];

        let built = build_dependency_snapshot(&symbols, &manifests);
        let path = unique_temp_path();

        save_dependency_index(&path, &built).expect("save should succeed");
        let loaded = load_dependency_index(&path).expect("load should succeed");

        assert_eq!(loaded.loaded_segments.borrow().len(), 0);
        assert_eq!(loaded.schema_version, DEPENDENCY_INDEX_SCHEMA_VERSION);
        assert!(!loaded.segment_table.is_empty());

        let future = query_dep_symbol_by_fqcn(&loaded, "scala.concurrent.Future")
            .expect("query should succeed")
            .expect("symbol should exist");

        assert_eq!(future.simple_name, "Future");
        assert_eq!(loaded.loaded_segments.borrow().len(), 1);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn query_loads_only_target_segment() {
        let manifests = vec![JarManifest {
            jar_path: "/deps/a.jar".to_string(),
            hash: 1,
            size_bytes: 1,
        }];

        let symbols = vec![
            DependencySymbolInput {
                simple_name: "Future".to_string(),
                fqcn: "scala.concurrent.Future".to_string(),
                package_name: "scala.concurrent".to_string(),
                kind: ClassKind::Trait,
                visibility: Visibility::Public,
                jar_path: "/deps/a.jar".to_string(),
                method_count: 1,
                field_count: 1,
            },
            DependencySymbolInput {
                simple_name: "Either".to_string(),
                fqcn: "scala.util.Either".to_string(),
                package_name: "scala.util".to_string(),
                kind: ClassKind::Class,
                visibility: Visibility::Public,
                jar_path: "/deps/a.jar".to_string(),
                method_count: 1,
                field_count: 1,
            },
        ];

        let path = unique_temp_path();
        let snapshot = build_dependency_snapshot(&symbols, &manifests);
        save_dependency_index(&path, &snapshot).expect("save should succeed");
        let loaded = load_dependency_index(&path).expect("load should succeed");

        assert_eq!(loaded.loaded_segments.borrow().len(), 0);
        let _future = query_dep_symbol_by_fqcn(&loaded, "scala.concurrent.Future")
            .expect("query should succeed")
            .expect("symbol should exist");
        assert_eq!(loaded.loaded_segments.borrow().len(), 1);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn segment_cache_eviction_keeps_recent_segments() {
        let manifests = vec![JarManifest {
            jar_path: "/deps/a.jar".to_string(),
            hash: 1,
            size_bytes: 1,
        }];

        let symbols = vec![
            DependencySymbolInput {
                simple_name: "Future".to_string(),
                fqcn: "scala.concurrent.Future".to_string(),
                package_name: "scala.concurrent".to_string(),
                kind: ClassKind::Trait,
                visibility: Visibility::Public,
                jar_path: "/deps/a.jar".to_string(),
                method_count: 1,
                field_count: 1,
            },
            DependencySymbolInput {
                simple_name: "Either".to_string(),
                fqcn: "scala.util.Either".to_string(),
                package_name: "scala.util".to_string(),
                kind: ClassKind::Class,
                visibility: Visibility::Public,
                jar_path: "/deps/a.jar".to_string(),
                method_count: 1,
                field_count: 1,
            },
            DependencySymbolInput {
                simple_name: "Try".to_string(),
                fqcn: "scala.util.Try".to_string(),
                package_name: "scala.util.control".to_string(),
                kind: ClassKind::Class,
                visibility: Visibility::Public,
                jar_path: "/deps/a.jar".to_string(),
                method_count: 1,
                field_count: 1,
            },
        ];

        let path = unique_temp_path();
        let snapshot = build_dependency_snapshot(&symbols, &manifests);
        save_dependency_index(&path, &snapshot).expect("save should succeed");
        let loaded = load_dependency_index(&path).expect("load should succeed");

        set_dependency_index_max_loaded_segments(&loaded, Some(1));

        let _ = query_dep_symbol_by_fqcn(&loaded, "scala.concurrent.Future");
        let _ = query_dep_symbol_by_fqcn(&loaded, "scala.util.Either");
        assert_eq!(loaded.loaded_segments.borrow().len(), 1);

        let evicted = evict_dependency_index_segments(&loaded, 0);
        assert!(evicted >= 1);
        assert_eq!(loaded.loaded_segments.borrow().len(), 0);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn load_rejects_older_schema_version() {
        let manifests = vec![JarManifest {
            jar_path: "/deps/a.jar".to_string(),
            hash: 1,
            size_bytes: 1,
        }];

        let symbols = vec![DependencySymbolInput {
            simple_name: "Future".to_string(),
            fqcn: "scala.concurrent.Future".to_string(),
            package_name: "scala.concurrent".to_string(),
            kind: ClassKind::Trait,
            visibility: Visibility::Public,
            jar_path: "/deps/a.jar".to_string(),
            method_count: 1,
            field_count: 1,
        }];

        let path = unique_temp_path();
        let snapshot = build_dependency_snapshot(&symbols, &manifests);
        save_dependency_index(&path, &snapshot).expect("save should succeed");

        {
            let mut file = File::options()
                .read(true)
                .write(true)
                .open(&path)
                .expect("open should succeed");
            file.seek(SeekFrom::Start(8 + 4))
                .expect("seek should succeed");
            file.write_all(&1u16.to_le_bytes())
                .expect("write should succeed");
            file.flush().expect("flush should succeed");
        }

        let loaded = load_dependency_index(&path);
        assert!(matches!(
            loaded,
            Err(EngineError::UnsupportedSchemaVersion(1))
        ));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn stale_detection_identifies_manifest_changes() {
        let manifests = vec![JarManifest {
            jar_path: "/deps/a.jar".to_string(),
            hash: 10,
            size_bytes: 100,
        }];

        let built = build_dependency_snapshot(&[], &manifests);

        let same = vec![JarManifest {
            jar_path: "/deps/a.jar".to_string(),
            hash: 10,
            size_bytes: 100,
        }];
        let changed = vec![JarManifest {
            jar_path: "/deps/a.jar".to_string(),
            hash: 11,
            size_bytes: 100,
        }];

        assert!(!dependency_index_is_stale(&built, &same));
        assert!(dependency_index_is_stale(&built, &changed));

        let changed_paths = changed_jar_paths(&built, &changed);
        assert_eq!(changed_paths, vec!["/deps/a.jar".to_string()]);
    }

    #[test]
    fn simple_name_queries_are_sorted_and_capped() {
        let manifests = vec![JarManifest {
            jar_path: "/deps/a.jar".to_string(),
            hash: 1,
            size_bytes: 1,
        }];

        let symbols = vec![
            DependencySymbolInput {
                simple_name: "Future".to_string(),
                fqcn: "scala.concurrent.Future".to_string(),
                package_name: "scala.concurrent".to_string(),
                kind: ClassKind::Trait,
                visibility: Visibility::Public,
                jar_path: "/deps/a.jar".to_string(),
                method_count: 1,
                field_count: 1,
            },
            DependencySymbolInput {
                simple_name: "Future".to_string(),
                fqcn: "scala.concurrent.impl.Promise$Future".to_string(),
                package_name: "scala.concurrent.impl".to_string(),
                kind: ClassKind::Class,
                visibility: Visibility::Public,
                jar_path: "/deps/a.jar".to_string(),
                method_count: 1,
                field_count: 1,
            },
        ];

        let snapshot = build_dependency_snapshot(&symbols, &manifests);
        let path = unique_temp_path();
        save_dependency_index(&path, &snapshot).expect("save should succeed");
        let loaded = load_dependency_index(&path).expect("load should succeed");

        let results = query_dep_symbols(&loaded, "Future", 1).expect("query should succeed");
        assert_eq!(results.len(), 1);

        let in_package = query_dep_symbols_in_package(&loaded, "Future", "scala.concurrent", 10)
            .expect("package query should succeed");
        assert_eq!(in_package.len(), 1);
        assert_eq!(in_package[0].package_name, "scala.concurrent");

        let _ = fs::remove_file(path);
    }
}
