//! 各模块共用的导入。领域代码从 src-tauri/src/lib.rs 原样搬来，导入沿用原文件的一份。
#![allow(unused_imports)]

pub(crate) use crate::{
    canvas, datasets::*, fragments::*, graph::*, hooks::*, images::*, library::*, maps::*,
    refs::*, trash::*, types::*, util::*,
};
pub(crate) use chrono::{DateTime, FixedOffset, Local, NaiveDate, NaiveDateTime, Utc};
pub(crate) use serde::{Deserialize, Serialize};
pub(crate) use sha2::{Digest, Sha256};
pub(crate) use shard_core::dataset::{self, DatasetLimits, DatasetOp, DatasetSnapshot};
pub(crate) use shard_core::graph_model::{
    CanvasFile, CanvasNode, ShardDocumentLink, ShardMapFile, ShardMapNode, SHARD_MAP_KIND,
    SHARD_MAP_SCHEMA_VERSION,
};
pub(crate) use shard_core::{
    contains_lockbox_tag, create_public_fragment_at, create_public_fragment_in_vault,
    create_public_fragment_with_id_in_vault, derive_type, ensure_public_csv_path,
    frontmatter::{
        apply_frontmatter, custom_property_entries, parse_fragment, remove_custom_property,
        set_custom_property, validate_property_key, write_fragment_update,
    },
    graph_region::{
        find_region, render_region, replace_region, GraphRegionKind, MISSING_REGION_ERROR,
    },
    library::{
        bounded_library_filename, create_library_dataset_files, create_library_dataset_files_at,
        create_library_note_file, create_library_note_file_at,
        existing_library_directory, existing_library_path, note_title, unique_mind_map_path,
        unique_note_path, unique_titled_path, validate_library_file_name, validate_library_name,
        validate_library_name_characters, validate_library_name_length,
    },
    new_fragment_id, normalize_tags, normalize_type_tags, unique_suffix, write_fragment_file,
    FragmentFrontmatter, FragmentRelation, Vfs, VfsMetadata, LOCKBOX_TAG, PROTECTED_TYPE_TAGS,
    TYPE_TAGS,
};
pub(crate) use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    io::{BufRead, BufReader},
    path::{Component, Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::SystemTime,
};
