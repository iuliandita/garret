pub mod core_constants;
pub mod mobile_core;
mod package_format;

// Both desktop and Android compile these same source files. There is one schema,
// migration ladder, transaction implementation, and ProseMirror body format.
#[path = "find.rs"]
mod find;
#[path = "replace.rs"]
mod replace;
#[path = "review_document.rs"]
mod review_document;
mod review_docx;
#[cfg(target_os = "android")]
#[path = "backup_bundle.rs"]
mod backup_bundle;
#[cfg(target_os = "android")]
#[path = "covers.rs"]
mod covers;
#[cfg(target_os = "android")]
#[path = "design.rs"]
mod design;
#[cfg(target_os = "android")]
#[path = "encrypted_archive.rs"]
mod encrypted_archive;
#[cfg(target_os = "android")]
#[path = "pictures.rs"]
mod pictures;
#[cfg(target_os = "android")]
#[path = "research.rs"]
mod research;
#[cfg(target_os = "android")]
#[path = "review_validation.rs"]
mod review_validation;
#[cfg(target_os = "android")]
#[path = "row_scan.rs"]
mod row_scan;
#[cfg(target_os = "android")]
#[path = "validation.rs"]
mod validation;
#[cfg(target_os = "android")]
mod transfer_copy;
#[cfg(target_os = "android")]
mod transfer_publish;
#[path = "store/mod.rs"]
pub mod store;
#[path = "strings.rs"]
pub mod strings;
#[path = "words.rs"]
pub mod words;

// Existing store code names these keys through projects. Keep one definition
// while the desktop project registry remains outside the mobile core.
pub mod projects {
    pub use crate::core_constants::{DAY_BASELINE_KEY, NAME_KEY};
}

pub mod identity {
    pub use crate::core_constants::PIN_KEY;
}

#[cfg(target_os = "android")]
mod mobile;

#[cfg(target_os = "android")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    mobile::run();
}
