// app/shell-tauri/src-tauri/src/strings.rs
// The host's message catalog: the words the host itself puts in front of a
// writer, or into a writer's file.
//
// THE PAGE HAS HAD ONE SINCE 008 AND THE HOST HAD NONE. `app/ui/src/i18n/`
// holds 429 keys behind a build guard that fails on the next inline literal;
// everything the host composed went on being English, and two of those strings
// are written into the writer's own book -- 041's generated contents heading
// and 043's `xml:lang`/`dc:language`. This module is the host's half, keyed the
// same way, with the same two recorded behaviours:
//
//   - A MISSING KEY RENDERS `⟦key⟧`, visibly. Two characters no message uses,
//     so a grep, a diff of an exported file and a test failure all show it.
//     Not an empty string, which is invisible; not a panic, which turns one
//     absent word into a lost export.
//   - AN UNKNOWN `{placeholder}` IS LEFT AS WRITTEN. `{name} - cast` on disk is
//     a bug report; ` - cast` is a mystery.
//
// WHERE THE LANGUAGE IS CHOSEN: `settings.json`, read by the host, exactly as
// the theme and the typography are, and injected into the page by
// `preferences_js`. This is the only answer that survives a CLI run -- `export`,
// `validate` and `salvage` all run with no window and no page to ask -- and the
// only one that runs in the same direction as every other preference.
//
// `EN` AND `DE` ARE THE TWO CATALOGS THIS BUILD SHIPS, both declared through
// `Locale::new`. Which languages ship beyond these two stays a decision about
// review capacity, not about code.

/// One language: its BCP-47 tag and its whole key table.
///
/// The tag is not decoration -- it is what `dc:language` and `<html lang>`
/// carry, so a catalog and the language attribute of the book it renders cannot
/// disagree.
pub struct Locale {
    tag: &'static str,
    entries: &'static [(&'static str, &'static str)],
}

impl Locale {
    /// Declare a catalog. `entries` must be sorted by key and hold no
    /// duplicate; `every_catalog_is_sorted_and_unique` is what says so, because
    /// a duplicate key in a table literal is legal Rust and the first one
    /// silently wins.
    pub const fn new(tag: &'static str, entries: &'static [(&'static str, &'static str)]) -> Self {
        Self { tag, entries }
    }

    pub fn tag(&self) -> &'static str {
        self.tag
    }
}

/// The English catalog.
pub static EN: Locale = Locale::new("en", EN_ENTRIES);

/// The German catalog. Sie-form, the same eighteen keys, translated in
/// `app/ui/src/i18n/de.ts`'s companion `de-host.txt` scratch file and pasted
/// here unchanged.
pub static DE: Locale = Locale::new("de", DE_ENTRIES);

/// Every catalog this build ships.
static CATALOGS: &[&Locale] = &[&EN, &DE];

/// Whether `tag` names a catalog this build ships. Used by the settings
/// command that WRITES `locale` to refuse a language nothing renders, unlike
/// `locale_for`'s own leniency below, which exists for a `settings.json`
/// edited by hand or left behind by an older build and must never refuse to
/// open a project over it.
pub fn is_known(tag: &str) -> bool {
    CATALOGS.iter().any(|locale| locale.tag == tag)
}

/// The catalog for a settings value, falling back to English.
///
/// LENIENT, like every other axis of `Settings`: a tag this build has no
/// catalog for reads as English rather than refusing to open the project. A
/// settings file is edited by hand and travels between builds.
pub fn locale_for(tag: &str) -> &'static Locale {
    locale_in(tag, CATALOGS)
}

/// The same, over a given list.
///
/// SPLIT OUT because the wall this repo has hit before -- a resolver over a
/// single catalog cannot be told apart from one that ignores its argument, the
/// recorded fixture-is-a-fact-about-itself shape in a lookup rather than in
/// data -- was true here until a second catalog shipped. `CATALOGS` now
/// holding `EN` and `DE` is what makes THIS function's own logic falsifiable
/// over the production list, and `locale_in`'s own test still exercises the
/// rule over a local two-catalog fixture besides, which is 049's answer for
/// the same wall in general: a resolver killed at its own boundary rather than
/// only through whatever the shipped list happens to be today.
pub fn locale_in(tag: &str, catalogs: &[&'static Locale]) -> &'static Locale {
    catalogs
        .iter()
        .copied()
        .find(|l| l.tag == tag)
        .unwrap_or(&EN)
}

/// How a missing key renders. Two characters no message uses.
pub fn missing_key_text(key: &str) -> String {
    format!("⟦{key}⟧")
}

/// A lookup over one catalog.
///
/// THE CATALOG IS INJECTED and there is no module-scope instance. The page
/// accepted one deliberately (008's write-back says why: threading it through
/// thirty-two constructors inside the migration that moved 425 literals would
/// have been unreviewable). The host is the opposite case -- there are two
/// composition roots, `main()` and `cli::dispatch`, the chain from either to a
/// rendered book already threads `&Vault` the same way, and a process-global
/// read of `settings.json` would make every unit test in this crate depend on
/// the developer's own home directory.
#[derive(Clone, Copy)]
pub struct Strings {
    locale: &'static Locale,
}

impl Strings {
    pub fn new(locale: &'static Locale) -> Self {
        Self { locale }
    }

    /// English.
    ///
    /// `#[cfg(test)]`, AND THAT IS THE INVARIANT RATHER THAN AN OVERSIGHT.
    /// Every production path resolves a language from `settings.json`; a
    /// production caller that named English here would be exactly the defect
    /// this module was written to remove, and the compiler is what says so.
    /// Tests are the other case -- an English fixture is what almost every
    /// assertion in this crate is written against.
    #[cfg(test)]
    pub fn english() -> Self {
        Self::new(&EN)
    }

    /// The BCP-47 tag of the language these strings are in.
    pub fn tag(&self) -> &'static str {
        self.locale.tag
    }

    /// The string for `key`.
    pub fn t(&self, key: &str) -> String {
        match self.lookup(key) {
            Some(v) => v.to_string(),
            None => missing_key_text(key),
        }
    }

    /// The string for `key` with `{name}` filled from `vars`.
    pub fn f(&self, key: &str, vars: &[(&str, &str)]) -> String {
        match self.lookup(key) {
            Some(v) => interpolate(v, vars),
            None => missing_key_text(key),
        }
    }

    /// Whether this catalog holds `key`. For guards, not for call sites: a
    /// call site that has to ask has a missing key.
    #[cfg(test)]
    pub fn has(&self, key: &str) -> bool {
        self.lookup(key).is_some()
    }

    fn lookup(&self, key: &str) -> Option<&'static str> {
        self.locale
            .entries
            .binary_search_by_key(&key, |(k, _)| k)
            .ok()
            .map(|i| self.locale.entries[i].1)
    }
}

/// Fill `{name}` from `vars`. AN UNKNOWN NAME IS LEFT AS WRITTEN, for the same
/// reason a missing key renders visibly.
fn interpolate(template: &str, vars: &[(&str, &str)]) -> String {
    if vars.is_empty() {
        return template.to_string();
    }
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after.find('}') {
            Some(close) => {
                let name = &after[..close];
                match vars.iter().find(|(k, _)| *k == name) {
                    Some((_, value)) => out.push_str(value),
                    // Left as written, brace and all.
                    None => {
                        out.push('{');
                        out.push_str(name);
                        out.push('}');
                    }
                }
                rest = &after[close + 1..];
            }
            None => {
                // An unclosed brace is text.
                out.push('{');
                rest = after;
                break;
            }
        }
    }
    out.push_str(rest);
    out
}

/// The English strings the host writes.
///
/// SORTED BY KEY, because `lookup` binary-searches and a test asserts it. Every
/// value here was an inline literal in `export.rs`, `epub.rs`, `pdf.rs` or
/// `salvage.rs` before this slice; the words are unchanged, which is why no
/// pre-existing assertion in this crate had to move.
const EN_ENTRIES: &[(&str, &str)] = &[
    // 041's generated table of contents, in the Markdown export, the EPUB's
    // navigation document and the PDF proof alike.
    ("backup.dialog.destination", "Choose encrypted backup folder"),
    ("book.contents", "Contents"),
    ("item.numbered.chapter", "Chapter {n}"),
    ("item.numbered.scene", "Scene {n}"),
    // The window title with nothing open: the
    // one non-book title this application has, and not a product name.
    ("library", "Library"),
    ("privacy.acknowledge", "I understand that this hides the application and does not encrypt my files."),
    ("privacy.capabilities", "OS authentication and clipboard clearing are unavailable. Existing clipboard history is not protected."),
    ("privacy.change", "Change password or PIN"),
    ("privacy.choose_cancel", "Cancel"),
    ("privacy.choose_open", "Open"),
    ("privacy.choose_save", "Save"),
    ("privacy.confirm", "Confirm new password or PIN"),
    ("privacy.confirmation_mismatch", "The confirmation does not match."),
    ("privacy.current", "Current password or PIN"),
    ("privacy.disable", "Disable privacy lock"),
    ("privacy.enable", "Enable privacy lock"),
    ("privacy.error", "The privacy setting could not be changed. Try again."),
    ("privacy.explanation", "This lock hides the application. It does not encrypt projects, exports, backups or mirrors. Protect files with your OS account and full-disk encryption."),
    ("privacy.forgot_secret", "Forgot your password or PIN?"),
    ("privacy.idle", "Lock after inactivity"),
    ("privacy.idle_off", "Off"),
    ("privacy.kind", "Unlock method"),
    ("privacy.locked", "Application locked"),
    ("privacy.locked_again", "The application locked again. Enter your password or PIN to continue."),
    ("privacy.minutes", "{minutes} minutes"),
    ("privacy.more_preferences", "More lock preferences below. Scroll to review them."),
    ("privacy.neutral", "Writing application"),
    ("privacy.neutral_option", "Keep the window title neutral while unlocked"),
    ("privacy.new_secret", "New password or PIN"),
    ("privacy.password", "Password (recommended)"),
    ("privacy.pin", "PIN"),
    ("privacy.portable_locked", "This library has a privacy lock from the Linux version. This preview cannot unlock it. No manuscript was opened. Quit and keep privacy.json and your books unchanged. Use the Linux version to unlock. If you intentionally reset the screen lock offline, first back up privacy.json in the application data directory, then remove only that file. The lock does not encrypt files."),
    ("privacy.portable_recovery", "The privacy record cannot be read safely, and this preview cannot recover it. No manuscript was opened. Quit and keep your books unchanged. To reset the screen lock offline, first back up privacy.json in the application data directory, then remove only that file. The lock does not encrypt files."),
    ("privacy.quit", "Quit"),
    ("privacy.recovery", "The privacy record cannot be read safely. Quit, back up privacy.json in the application data directory, then remove only that record to reset the screen lock. Do not remove projects or ordinary settings."),
    ("privacy.requirements", "Use a password of at least 8 characters (up to 1024 bytes), or a PIN of 6 to 128 digits. Spaces and Unicode are allowed in passwords."),
    ("privacy.reset_advice", "If you forget the secret: close the application, back up privacy.json in its data directory, then remove only that file. This disables the lock without changing your books."),
    ("privacy.retry", "Try again in {seconds} seconds."),
    ("privacy.save_failed", "Some changes are not saved. Unlock to resolve them before quitting."),
    ("privacy.save_policy", "Save lock preferences"),
    ("privacy.secret", "Password or PIN"),
    ("privacy.session_lock", "Lock with the desktop session"),
    ("privacy.settings", "Privacy lock"),
    ("privacy.shortcut", "Application lock shortcut"),
    ("privacy.sleep", "Lock before sleep"),
    ("privacy.unavailable", "Unavailable on this session"),
    ("privacy.unlock", "Unlock"),
    ("privacy.verifying", "Checking..."),
    ("privacy.wait", "Wait before trying again."),
    ("privacy.wrong", "Incorrect password or PIN."),
    ("research.dialog.import", "Import research copy"),
    ("research.dialog.report", "Export craft report"),
    ("research.dialog.save", "Save research copy"),
    ("review.transport.filter", "Review DOCX"),
    ("review.transport.open", "Open returned review"),
    ("review.transport.save", "Save a copy for review"),
    ("salvage.cast.aliases", "Also called: {aliases}"),
    ("salvage.cast.appears", "Appears in:"),
    ("salvage.cast.characters", "Characters"),
    ("salvage.cast.orphans", "Details and aliases whose cast member is gone"),
    ("salvage.cast.places", "Places"),
    ("salvage.cast.poi", "Points of interest"),
    ("salvage.cast.removed", "Removed from active Cast (recoverable)."),
    ("salvage.covers.back", "Back cover"),
    ("salvage.covers.front", "Front cover"),
    ("salvage.loss-report.detail", "Technical details and stable record IDs are in manifest.json. No recorded losses does not prove that the source was complete before recovery."),
    ("salvage.loss-report.heading", "Recovery report"),
    ("salvage.loss-report.none", "No recovery losses were recorded."),
    ("salvage.loss.corrupt_research_original", "A research original could not be verified or recovered."),
    ("salvage.loss.enumeration_stopped", "Reading a table stopped before its end."),
    ("salvage.loss.file_truncated", "The database file is shorter than its header reports."),
    ("salvage.loss.invalid_review_record", "A review record has invalid fields or references; recoverable cells were retained."),
    ("salvage.loss.missing_blob", "The bytes for a saved version are missing."),
    ("salvage.loss.missing_cover", "A referenced cover image is missing."),
    ("salvage.loss.missing_picture", "A referenced picture is missing."),
    ("salvage.loss.missing_research_original", "A referenced research original is missing."),
    ("salvage.loss.orphan_appearance", "A cast appearance refers to a missing entry."),
    ("salvage.loss.orphan_cast_alias", "A recovered alias has no surviving cast entry."),
    ("salvage.loss.orphan_cast_field", "Recovered cast details have no surviving cast entry."),
    ("salvage.loss.orphan_comment", "A recovered comment has no surviving document."),
    ("salvage.loss.orphan_doc", "Recovered prose has no surviving outline entry."),
    ("salvage.loss.orphan_item", "An outline entry refers to a missing parent."),
    ("salvage.loss.orphan_knowledge_link", "A recovered relationship names an unavailable entry."),
    ("salvage.loss.orphan_research_original", "An unreferenced research file was found and recovered separately."),
    ("salvage.loss.orphan_synopsis", "A recovered synopsis has no surviving outline entry."),
    ("salvage.loss.orphan_version", "A saved version refers to a missing document or snapshot."),
    ("salvage.loss.structure", "The manuscript structure could not be reconstructed."),
    ("salvage.loss.table_unreadable", "A table could not be read."),
    ("salvage.loss.unknown", "A recovery problem was recorded."),
    ("salvage.loss.unreadable_analytics_row", "A session observation could not be read."),
    ("salvage.loss.unreadable_appearance_row", "A appearance record could not be read."),
    ("salvage.loss.unreadable_blob_row", "A stored content record could not be read."),
    ("salvage.loss.unreadable_body", "A document could not be interpreted; inspect its recovered raw bytes."),
    ("salvage.loss.unreadable_cast_alias_row", "A cast alias could not be read."),
    ("salvage.loss.unreadable_cast_field_row", "A cast detail could not be read."),
    ("salvage.loss.unreadable_cast_member_row", "A cast entry could not be read."),
    ("salvage.loss.unreadable_comment_row", "A comment record could not be read."),
    ("salvage.loss.unreadable_cover", "A cover image could not be recovered."),
    ("salvage.loss.unreadable_design_row", "A book design record could not be read."),
    ("salvage.loss.unreadable_doc_row", "A document record could not be read."),
    ("salvage.loss.unreadable_item_row", "A outline entry could not be read."),
    ("salvage.loss.unreadable_knowledge_link_row", "A relationship record could not be read."),
    ("salvage.loss.unreadable_meta_row", "A metadata record could not be read."),
    ("salvage.loss.unreadable_picture", "A picture could not be recovered."),
    ("salvage.loss.unreadable_research_row", "A research record could not be read."),
    ("salvage.loss.unreadable_review_record", "A review record or table could not be fully read."),
    ("salvage.loss.unreadable_revision_pass_row", "A revision pass record could not be read."),
    ("salvage.loss.unreadable_revision_task_row", "A revision task record could not be read."),
    ("salvage.loss.unreadable_snapshot_row", "A snapshot record could not be read."),
    ("salvage.loss.unreadable_synopsis_row", "A synopsis record could not be read."),
    ("salvage.loss.unreadable_version_body", "A saved version could not be interpreted; inspect its recovered raw bytes."),
    ("salvage.loss.unreadable_version_row", "A version record could not be read."),
    ("salvage.loss.unreadable_wordlist_row", "A dictionary entry could not be read."),
    ("salvage.snapshots.created", "created {at}"),
    ("salvage.snapshots.not_stored", "bytes not stored"),
    ("salvage.title.cast", "{name} - cast"),
    ("salvage.title.comments", "{name} - comments"),
    ("salvage.title.covers", "{name} - covers"),
    ("salvage.title.snapshots", "{name} - snapshots"),
    ("salvage.title.synopses", "{name} - synopses"),
    ("salvage.title.wordlist", "{name} - wordlist"),
    ("startup.data_migration", "garret could not safely prepare its application data. Your existing data has been preserved.\n\nOlder folder:\n{old}\n\nNewer folder:\n{new}\n\nClose every version of garret and back up both folders separately. Do not delete, merge or overwrite them. For recovery help, open github.com/iuliandita/garret/issues and include the details below, removing personal paths before posting publicly.\n\nTechnical details (English):"),
    ("startup.detail", "Technical details:"),
    ("startup.help", "The application could not open its window. On Windows, check that the Microsoft Edge WebView2 Evergreen Runtime is installed: https://developer.microsoft.com/microsoft-edge/webview2/ . An installed runtime does not rule out another startup problem. Keep the technical details below when reporting the failure."),
];

/// The German strings the host writes. Same eighteen keys as `EN_ENTRIES`,
/// same order, `every_catalog_is_sorted_and_unique` and
/// `english_and_german_hold_the_same_keys` are what say so rather than this
/// comment.
const DE_ENTRIES: &[(&str, &str)] = &[
    ("backup.dialog.destination", "Ordner für verschlüsselte Sicherungen wählen"),
    ("book.contents", "Inhalt"),
    ("item.numbered.chapter", "Kapitel {n}"),
    ("item.numbered.scene", "Szene {n}"),
    ("library", "Bibliothek"),
    ("privacy.acknowledge", "Ich verstehe, dass dies die Anwendung verbirgt und meine Dateien nicht verschlüsselt."),
    ("privacy.capabilities", "Betriebssystem-Anmeldung und das Leeren der Zwischenablage sind nicht verfügbar. Ihr Verlauf bleibt ungeschützt."),
    ("privacy.change", "Passwort oder PIN ändern"),
    ("privacy.choose_cancel", "Abbrechen"),
    ("privacy.choose_open", "Öffnen"),
    ("privacy.choose_save", "Speichern"),
    ("privacy.confirm", "Neues Passwort oder neue PIN bestätigen"),
    ("privacy.confirmation_mismatch", "Die Bestätigung stimmt nicht überein."),
    ("privacy.current", "Aktuelles Passwort oder aktuelle PIN"),
    ("privacy.disable", "Sperre deaktivieren"),
    ("privacy.enable", "Sperre aktivieren"),
    ("privacy.error", "Die Sperreinstellung konnte nicht geändert werden. Versuchen Sie es erneut."),
    ("privacy.explanation", "Diese Sperre verbirgt die Anwendung. Sie verschlüsselt keine Projekte, Exporte, Sicherungen oder Spiegelordner. Schützen Sie Dateien mit Ihrem Betriebssystemkonto und einer Festplattenverschlüsselung."),
    ("privacy.forgot_secret", "Passwort oder PIN vergessen?"),
    ("privacy.idle", "Nach Inaktivität sperren"),
    ("privacy.idle_off", "Aus"),
    ("privacy.kind", "Entsperrmethode"),
    ("privacy.locked", "Anwendung gesperrt"),
    ("privacy.locked_again", "Die Anwendung wurde erneut gesperrt. Geben Sie Ihr Passwort oder Ihre PIN ein."),
    ("privacy.minutes", "{minutes} Minuten"),
    ("privacy.more_preferences", "Weitere Sperreinstellungen folgen unten. Scrollen Sie, um sie zu prüfen."),
    ("privacy.neutral", "Schreibanwendung"),
    ("privacy.neutral_option", "Fenstertitel auch im entsperrten Zustand neutral halten"),
    ("privacy.new_secret", "Neues Passwort oder neue PIN"),
    ("privacy.password", "Passwort (empfohlen)"),
    ("privacy.pin", "PIN"),
    ("privacy.portable_locked", "Für diese Bibliothek ist eine Bildschirmsperre aus der Linux-Version aktiviert. Diese Vorschau kann sie nicht entsperren. Es wurde kein Manuskript geöffnet. Beenden Sie die Anwendung und lassen Sie privacy.json und Ihre Bücher unverändert. Verwenden Sie zum Entsperren die Linux-Version. Wenn Sie die Bildschirmsperre bewusst offline zurücksetzen, sichern Sie zuerst privacy.json im Anwendungsdatenordner und entfernen Sie dann nur diese Datei. Die Sperre verschlüsselt keine Dateien."),
    ("privacy.portable_recovery", "Der Sperrdatensatz kann nicht sicher gelesen werden und diese Vorschau kann ihn nicht wiederherstellen. Es wurde kein Manuskript geöffnet. Beenden Sie die Anwendung und lassen Sie Ihre Bücher unverändert. Um die Bildschirmsperre offline zurückzusetzen, sichern Sie zuerst privacy.json im Anwendungsdatenordner und entfernen Sie dann nur diese Datei. Die Sperre verschlüsselt keine Dateien."),
    ("privacy.quit", "Beenden"),
    ("privacy.recovery", "Der Sperrdatensatz kann nicht sicher gelesen werden. Beenden Sie die Anwendung, sichern Sie privacy.json im Anwendungsdatenordner und entfernen Sie nur diesen Datensatz, um die Bildschirmsperre zurückzusetzen. Entfernen Sie keine Projekte oder gewöhnlichen Einstellungen."),
    ("privacy.requirements", "Verwenden Sie ein Passwort mit mindestens 8 Zeichen (höchstens 1024 Bytes) oder eine PIN mit 6 bis 128 Ziffern. Passwörter dürfen Leerzeichen und Unicode enthalten."),
    ("privacy.reset_advice", "Falls Sie das Geheimnis vergessen: Schließen Sie die Anwendung, sichern Sie privacy.json in ihrem Datenordner und entfernen Sie nur diese Datei. Damit wird die Sperre deaktiviert; Ihre Bücher bleiben unverändert."),
    ("privacy.retry", "In {seconds} Sekunden erneut versuchen."),
    ("privacy.save_failed", "Einige Änderungen sind nicht gespeichert. Entsperren Sie die Anwendung, um sie vor dem Beenden zu sichern."),
    ("privacy.save_policy", "Sperreinstellungen speichern"),
    ("privacy.secret", "Passwort oder PIN"),
    ("privacy.session_lock", "Mit der Desktopsitzung sperren"),
    ("privacy.settings", "Bildschirmsperre"),
    ("privacy.shortcut", "Tastenkürzel für die Anwendungssperre"),
    ("privacy.sleep", "Vor dem Ruhezustand sperren"),
    ("privacy.unavailable", "In dieser Sitzung nicht verfügbar"),
    ("privacy.unlock", "Entsperren"),
    ("privacy.verifying", "Wird geprüft..."),
    ("privacy.wait", "Warten Sie vor dem nächsten Versuch."),
    ("privacy.wrong", "Falsches Passwort oder falsche PIN."),
    ("research.dialog.import", "Recherchekopie importieren"),
    ("research.dialog.report", "Schreibbericht exportieren"),
    ("research.dialog.save", "Recherchekopie speichern"),
    ("review.transport.filter", "DOCX mit Vorschlägen"),
    ("review.transport.open", "Zurückgegebene Vorschläge öffnen"),
    ("review.transport.save", "Kopie zur Überprüfung speichern"),
    ("salvage.cast.aliases", "Auch genannt: {aliases}"),
    ("salvage.cast.appears", "Tritt auf in:"),
    ("salvage.cast.characters", "Figuren"),
    (
        "salvage.cast.orphans",
        "Merkmale und Beinamen, deren Eintrag im Figurenverzeichnis fehlt",
    ),
    ("salvage.cast.places", "Orte"),
    ("salvage.cast.poi", "Objekte"),
    ("salvage.cast.removed", "Aus dem aktiven Figurenverzeichnis entfernt (wiederherstellbar)."),
    ("salvage.covers.back", "Hinterer Umschlag"),
    ("salvage.covers.front", "Vorderer Umschlag"),
    ("salvage.loss-report.detail", "Technische Details und stabile Datensatz-IDs stehen in manifest.json. Keine protokollierten Verluste beweisen nicht, dass die Quelle vor der Wiederherstellung vollständig war."),
    ("salvage.loss-report.heading", "Wiederherstellungsbericht"),
    ("salvage.loss-report.none", "Es wurden keine Wiederherstellungsverluste protokolliert."),
    ("salvage.loss.corrupt_research_original", "Eine Forschungsdatei konnte nicht geprüft oder wiederhergestellt werden."),
    ("salvage.loss.enumeration_stopped", "Das Lesen einer Tabelle brach vor ihrem Ende ab."),
    ("salvage.loss.file_truncated", "Die Datenbankdatei ist kürzer als in ihrem Kopf angegeben."),
    ("salvage.loss.invalid_review_record", "Ungültige Felder oder Verweise in einem Überprüfungsdatensatz; lesbare Zellen wurden behalten."),
    ("salvage.loss.missing_blob", "Die Daten einer gespeicherten Version fehlen."),
    ("salvage.loss.missing_cover", "Ein zugeordnetes Umschlagbild fehlt."),
    ("salvage.loss.missing_picture", "Ein zugeordnetes Bild fehlt."),
    ("salvage.loss.missing_research_original", "Eine zugeordnete Forschungsdatei fehlt."),
    ("salvage.loss.orphan_appearance", "Ein Figurenauftritt verweist auf einen fehlenden Eintrag."),
    ("salvage.loss.orphan_cast_alias", "Ein wiederhergestellter Alias hat keinen erhaltenen Figureneintrag."),
    ("salvage.loss.orphan_cast_field", "Wiederhergestellte Figurendetails haben keinen erhaltenen Figureneintrag."),
    ("salvage.loss.orphan_comment", "Ein wiederhergestellter Kommentar hat kein erhaltenes Dokument."),
    ("salvage.loss.orphan_doc", "Wiederhergestellter Text hat keinen erhaltenen Gliederungseintrag."),
    ("salvage.loss.orphan_item", "Ein Gliederungseintrag verweist auf einen fehlenden übergeordneten Eintrag."),
    ("salvage.loss.orphan_knowledge_link", "Eine wiederhergestellte Beziehung verweist auf einen nicht verfügbaren Eintrag."),
    ("salvage.loss.orphan_research_original", "Eine nicht zugeordnete Forschungsdatei wurde getrennt wiederhergestellt."),
    ("salvage.loss.orphan_synopsis", "Eine wiederhergestellte Inhaltsangabe hat keinen erhaltenen Gliederungseintrag."),
    ("salvage.loss.orphan_version", "Eine gespeicherte Version verweist auf ein fehlendes Dokument oder einen fehlenden Schnappschuss."),
    ("salvage.loss.structure", "Die Manuskriptstruktur konnte nicht wiederhergestellt werden."),
    ("salvage.loss.table_unreadable", "Nicht lesbar: Tabelle."),
    ("salvage.loss.unknown", "Ein Wiederherstellungsproblem wurde protokolliert."),
    ("salvage.loss.unreadable_analytics_row", "Nicht lesbar: Sitzungsbeobachtung."),
    ("salvage.loss.unreadable_appearance_row", "Nicht lesbar: Auftrittsdatensatz."),
    ("salvage.loss.unreadable_blob_row", "Nicht lesbar: Inhaltsdatensatz."),
    ("salvage.loss.unreadable_body", "Ein Dokument konnte nicht interpretiert werden; prüfen Sie seine wiederhergestellten Rohdaten."),
    ("salvage.loss.unreadable_cast_alias_row", "Nicht lesbar: Figurenalias."),
    ("salvage.loss.unreadable_cast_field_row", "Nicht lesbar: Figurendetail."),
    ("salvage.loss.unreadable_cast_member_row", "Nicht lesbar: Figureneintrag."),
    ("salvage.loss.unreadable_comment_row", "Nicht lesbar: Kommentardatensatz."),
    ("salvage.loss.unreadable_cover", "Ein Umschlagbild konnte nicht wiederhergestellt werden."),
    ("salvage.loss.unreadable_design_row", "Nicht lesbar: Buchgestaltungsdatensatz."),
    ("salvage.loss.unreadable_doc_row", "Nicht lesbar: Dokumentdatensatz."),
    ("salvage.loss.unreadable_item_row", "Nicht lesbar: Gliederungseintrag."),
    ("salvage.loss.unreadable_knowledge_link_row", "Nicht lesbar: Beziehungsdatensatz."),
    ("salvage.loss.unreadable_meta_row", "Nicht lesbar: Metadatensatz."),
    ("salvage.loss.unreadable_picture", "Ein Bild konnte nicht wiederhergestellt werden."),
    ("salvage.loss.unreadable_research_row", "Nicht lesbar: Forschungsdatensatz."),
    ("salvage.loss.unreadable_review_record", "Ein Überprüfungsdatensatz oder eine Tabelle konnte nicht vollständig gelesen werden."),
    ("salvage.loss.unreadable_revision_pass_row", "Nicht lesbar: Überarbeitungsgang-Datensatz."),
    ("salvage.loss.unreadable_revision_task_row", "Nicht lesbar: Überarbeitungsaufgaben-Datensatz."),
    ("salvage.loss.unreadable_snapshot_row", "Nicht lesbar: Schnappschussdatensatz."),
    ("salvage.loss.unreadable_synopsis_row", "Nicht lesbar: Inhaltsangabendatensatz."),
    ("salvage.loss.unreadable_version_body", "Eine gespeicherte Version konnte nicht interpretiert werden; prüfen Sie ihre wiederhergestellten Rohdaten."),
    ("salvage.loss.unreadable_version_row", "Nicht lesbar: Versionsdatensatz."),
    ("salvage.loss.unreadable_wordlist_row", "Nicht lesbar: Wörterbucheintrag."),
    ("salvage.snapshots.created", "angelegt {at}"),
    ("salvage.snapshots.not_stored", "Bytes nicht gespeichert"),
    ("salvage.title.cast", "{name} - Figurenverzeichnis"),
    ("salvage.title.comments", "{name} - Notizen"),
    ("salvage.title.covers", "{name} - Umschläge"),
    ("salvage.title.snapshots", "{name} - Schnappschüsse"),
    ("salvage.title.synopses", "{name} - Inhaltsangaben"),
    ("salvage.title.wordlist", "{name} - Wortliste"),
    ("startup.data_migration", "garret konnte seine Anwendungsdaten nicht sicher vorbereiten. Ihre vorhandenen Daten wurden erhalten.\n\nBisheriger Ordner:\n{old}\n\nNeuer Ordner:\n{new}\n\nSchließen Sie alle Versionen von garret und sichern Sie beide Ordner getrennt. Löschen, verbinden oder überschreiben Sie sie nicht. Hilfe bei der Wiederherstellung erhalten Sie unter github.com/iuliandita/garret/issues. Geben Sie die folgenden Details an und entfernen Sie persönliche Pfade vor einer öffentlichen Meldung.\n\nTechnische Details (Englisch):"),
    ("startup.detail", "Technische Details:"),
    ("startup.help", "Die Anwendung konnte ihr Fenster nicht öffnen. Prüfen Sie unter Windows, ob die Microsoft Edge WebView2 Evergreen Runtime installiert ist: https://developer.microsoft.com/microsoft-edge/webview2/ . Eine installierte Runtime schließt andere Startprobleme nicht aus. Bewahren Sie die folgenden technischen Details für einen Fehlerbericht auf."),
];

#[cfg(test)]
mod tests {
    use super::*;

    /// A catalog of five keys, so the lookup is tested over a fixture and not
    /// over whatever English happens to hold today -- 008's own rule for the
    /// page's tests, and the reason `en.ts` can be reworded without touching
    /// them.
    static FIXTURE_ENTRIES: &[(&str, &str)] = &[
        ("a.brace", "{unclosed"),
        ("a.plain", "Plain"),
        ("a.two", "{one} and {two}"),
        ("b.vars", "Hello {name}"),
        ("c.empty_vars", "no placeholders here"),
    ];
    static FIXTURE: Locale = Locale::new("qq", FIXTURE_ENTRIES);

    fn fixture() -> Strings {
        Strings::new(&FIXTURE)
    }

    #[test]
    fn a_key_present_in_the_catalog_renders_its_value() {
        assert_eq!(fixture().t("a.plain"), "Plain");
    }

    #[test]
    fn a_missing_key_renders_itself_visibly() {
        assert_eq!(fixture().t("nope.at.all"), "⟦nope.at.all⟧");
        assert_eq!(
            fixture().f("nope.at.all", &[("name", "x")]),
            "⟦nope.at.all⟧"
        );
    }

    #[test]
    fn a_placeholder_is_filled_from_the_variables() {
        assert_eq!(fixture().f("b.vars", &[("name", "Ada")]), "Hello Ada");
        assert_eq!(
            fixture().f("a.two", &[("two", "second"), ("one", "first")]),
            "first and second"
        );
    }

    #[test]
    fn an_unknown_placeholder_is_left_as_written() {
        // The recorded rule: `{name} - cast` in a file is a bug report and
        // ` - cast` is a mystery. Asserted with a SECOND, known placeholder
        // beside it, so a rule that dropped every placeholder cannot pass.
        assert_eq!(fixture().f("b.vars", &[("other", "x")]), "Hello {name}");
        assert_eq!(fixture().f("a.two", &[("one", "first")]), "first and {two}");
    }

    #[test]
    fn an_unclosed_brace_is_text() {
        assert_eq!(fixture().f("a.brace", &[("unclosed", "x")]), "{unclosed");
    }

    #[test]
    fn a_template_with_no_placeholder_is_returned_whole() {
        assert_eq!(
            fixture().f("c.empty_vars", &[("name", "x")]),
            "no placeholders here"
        );
    }

    #[test]
    fn the_locale_tag_is_the_catalogs_own() {
        assert_eq!(fixture().tag(), "qq");
        assert_eq!(Strings::english().tag(), "en");
    }

    #[test]
    fn a_tag_selects_its_own_catalog_and_an_unknown_one_falls_back() {
        // OVER TWO CATALOGS, because over one this rule cannot be wrong. Both
        // directions and the fallback, which is the whole of what the resolver
        // promises.
        static OTHER: Locale = Locale::new("qq", FIXTURE_ENTRIES);
        let both: &[&'static Locale] = &[&EN, &OTHER];
        assert_eq!(locale_in("qq", both).tag(), "qq");
        assert_eq!(locale_in("en", both).tag(), "en");
        assert_eq!(locale_in("fr", both).tag(), "en");
        // And the catalog that comes back is that language's, not just its
        // name: a resolver returning the right tag over the wrong table would
        // render one language's words under another's label.
        assert_eq!(Strings::new(locale_in("qq", both)).t("a.plain"), "Plain");
    }

    #[test]
    fn an_unknown_language_falls_back_to_english() {
        // LENIENT, like every other axis of `Settings`. Asserted in both
        // directions: a resolver that answered English for everything would
        // satisfy half of this.
        assert_eq!(locale_for("en").tag(), "en");
        assert_eq!(locale_for("qq").tag(), "en");
        assert_eq!(locale_for("").tag(), "en");
    }

    #[test]
    fn a_known_tag_selects_its_own_catalog_and_an_unknown_one_does_not() {
        assert_eq!(locale_for("de").tag(), "de");
        assert_eq!(Strings::new(locale_for("de")).t("book.contents"), "Inhalt");
        assert!(is_known("en"));
        assert!(is_known("de"));
        assert!(!is_known("fr"));
        assert!(!is_known(""));
    }

    #[test]
    fn a_regional_subtag_this_build_has_no_exact_catalog_for_falls_back_to_english() {
        // `locale_for` is an EXACT match against the tag a catalog declared --
        // there is no language-subtag extraction anywhere in this module, so
        // "de-AT" is simply a tag no `Locale::new` used and gets `locale_for`'s
        // documented fallback, the same as any other unknown tag. Naming the
        // rule this file actually implements, not the one a locale-aware
        // library might.
        assert_eq!(locale_for("de-AT").tag(), "en");
    }

    #[test]
    fn english_and_german_hold_the_same_keys() {
        // The completeness half of the page's own `catalog-completeness.test.ts`,
        // over the host's seventeen instead of the page's nine hundred: a key one
        // catalog has and the other does not renders `⟦key⟧` into a writer's
        // exported book in whichever language is missing it.
        let en_keys: std::collections::BTreeSet<&str> =
            EN_ENTRIES.iter().map(|(k, _)| *k).collect();
        let de_keys: std::collections::BTreeSet<&str> =
            DE_ENTRIES.iter().map(|(k, _)| *k).collect();
        assert_eq!(en_keys, de_keys);
    }

    #[test]
    fn every_catalog_is_sorted_and_unique() {
        // `lookup` binary-searches, so an unsorted table silently answers
        // `None` for keys it holds -- which renders `⟦key⟧` into a writer's
        // book. A duplicate key is legal Rust and the search would pick
        // whichever half it landed in.
        assert_eq!(
            CATALOGS.len(),
            2,
            "this test must cover every shipped catalog"
        );
        for locale in CATALOGS {
            let keys: Vec<&str> = locale.entries.iter().map(|(k, _)| *k).collect();
            let mut sorted = keys.clone();
            sorted.sort_unstable();
            assert_eq!(keys, sorted, "{} is not sorted by key", locale.tag);
            sorted.dedup();
            assert_eq!(
                sorted.len(),
                keys.len(),
                "{} has a duplicate key",
                locale.tag
            );
        }
    }

    #[test]
    fn no_english_value_is_empty_and_the_catalog_is_not() {
        // The vacuity guard. An empty catalog satisfies every "the host holds
        // no literal" assertion in this slice by having been emptied.
        assert!(EN_ENTRIES.len() >= 17, "{}", EN_ENTRIES.len());
        for (key, value) in EN_ENTRIES {
            assert!(!value.trim().is_empty(), "{key} is empty");
        }
    }

    #[test]
    fn english_holds_every_key_the_host_asks_for() {
        // Named one at a time. A key the host looks up and the catalog lacks
        // renders `⟦key⟧` into an exported book, and the only place that is
        // cheap to find is here.
        let en = Strings::english();
        for key in [
            "book.contents",
            "salvage.cast.aliases",
            "salvage.cast.removed",
            "salvage.cast.appears",
            "salvage.cast.characters",
            "salvage.cast.orphans",
            "salvage.cast.places",
            "salvage.cast.poi",
            "salvage.covers.back",
            "salvage.covers.front",
            "salvage.snapshots.created",
            "salvage.snapshots.not_stored",
            "salvage.title.cast",
            "salvage.title.comments",
            "salvage.title.covers",
            "salvage.title.snapshots",
            "salvage.title.synopses",
            "salvage.title.wordlist",
        ] {
            assert!(en.has(key), "{key} is not in the English catalog");
        }
    }
}

/// THE DRIFT GUARD, and the reason this module is load-bearing rather than
/// decorative.
///
/// The page's half ships `no-hardcoded-strings.test.ts`, which fails the
/// build on the next inline literal anywhere in `app/ui/src`. The host cannot
/// have that guard over 39,000 lines of Rust full of SQL, XML and format
/// strings without an allowlist so long it would exempt the next real label. So
/// the boundary is drawn where it is actually load-bearing: **the three modules
/// that compose a writer's file**. `export.rs`, `epub.rs` and `pdf.rs` are
/// documented as pure and as holding no writer-facing words of their own, and
/// that sentence was true only by inspection until this test.
///
/// Both recorded defects are caught by it: `CONTENTS_TITLE = "Contents"` is a
/// value in the catalog, and `LANGUAGE = "en"` is a shipped language tag.
#[cfg(test)]
mod renderer_guard {
    use super::*;

    /// The four modules that turn a book into bytes.
    const RENDERERS: [(&str, &str); 4] = [
        ("export.rs", include_str!("export.rs")),
        ("epub.rs", include_str!("epub.rs")),
        ("pdf.rs", include_str!("pdf.rs")),
        ("docx.rs", include_str!("docx.rs")),
    ];

    /// The marker each of these files puts its inline tests behind. NOT the
    /// bare `#[cfg(test)]` attribute: `export.rs` carries a second one on a
    /// test-only `impl`, and cutting there would have left half the shipping
    /// module unscanned while the guard reported success.
    const TEST_MODULE: &str = "#[cfg(test)]\nmod tests {";

    /// The part of a Rust source that ships, which is everything before its
    /// own test module.
    ///
    /// THE TEST MODULE IS NOT SCANNED, and it must not be: these three files
    /// hold their fixtures inline, and a fixture book is CALLED `Chapter One`
    /// by a person writing a test about chapter titles. The page's guard makes
    /// the same cut by scanning `src` and not `test`. The boundary is asserted
    /// rather than assumed -- exactly one marker per file, and most of the file
    /// a substantial module on the shipping side of it, so a file that moved
    /// its tests to the top cannot silence this guard by accident.
    fn shipping_part(src: &str) -> &str {
        match src.find(TEST_MODULE) {
            Some(at) => &src[..at],
            None => src,
        }
    }

    /// A string literal, with the line it opened on.
    #[derive(Debug)]
    struct Literal {
        line: usize,
        text: String,
    }

    /// Every string literal in a Rust source, COMMENTS STRIPPED FIRST.
    ///
    /// Three guards in this repo have been bitten by finding their target in
    /// the comment explaining why the target is absent, and every note in these
    /// three files about which words do NOT belong there is prose full of
    /// quoted strings. One pass, because a comment inside a literal and a
    /// literal inside a comment are told apart only by scanning in order.
    ///
    /// `'` IS NEVER TREATED AS A QUOTE. Rust spells lifetimes with it and this
    /// crate is full of them; a char literal holds one character and cannot be
    /// a sentence.
    fn literals_in(src: &str) -> Vec<Literal> {
        let b: Vec<char> = src.chars().collect();
        let mut out = Vec::new();
        let mut i = 0usize;
        let mut line = 1usize;
        while i < b.len() {
            let c = b[i];
            if c == '\n' {
                line += 1;
                i += 1;
                continue;
            }
            if c == '/' && b.get(i + 1) == Some(&'/') {
                while i < b.len() && b[i] != '\n' {
                    i += 1;
                }
                continue;
            }
            if c == '/' && b.get(i + 1) == Some(&'*') {
                i += 2;
                while i < b.len() && !(b[i] == '*' && b.get(i + 1) == Some(&'/')) {
                    if b[i] == '\n' {
                        line += 1;
                    }
                    i += 1;
                }
                i += 2;
                continue;
            }
            // A raw string: `r"..."` or `r#"..."#`, any number of hashes.
            if c == 'r' && matches!(b.get(i + 1), Some('"') | Some('#')) {
                let mut j = i + 1;
                let mut hashes = 0usize;
                while b.get(j) == Some(&'#') {
                    hashes += 1;
                    j += 1;
                }
                if b.get(j) == Some(&'"') {
                    let start_line = line;
                    j += 1;
                    let mut text = String::new();
                    while j < b.len() {
                        if b[j] == '"' {
                            let closed = (1..=hashes).all(|k| b.get(j + k) == Some(&'#'));
                            if closed {
                                j += hashes + 1;
                                break;
                            }
                        }
                        if b[j] == '\n' {
                            line += 1;
                        }
                        text.push(b[j]);
                        j += 1;
                    }
                    out.push(Literal {
                        line: start_line,
                        text,
                    });
                    i = j;
                    continue;
                }
            }
            if c == '"' {
                let start_line = line;
                let mut j = i + 1;
                let mut text = String::new();
                while j < b.len() {
                    if b[j] == '\\' {
                        // The escape and what it escapes, both kept: a `\"`
                        // inside a format string is part of the markup, and a
                        // rule that dropped it would join two literals into one.
                        text.push(b[j]);
                        if let Some(n) = b.get(j + 1) {
                            if *n == '\n' {
                                line += 1;
                            }
                            text.push(*n);
                        }
                        j += 2;
                        continue;
                    }
                    if b[j] == '"' {
                        j += 1;
                        break;
                    }
                    if b[j] == '\n' {
                        line += 1;
                    }
                    text.push(b[j]);
                    j += 1;
                }
                out.push(Literal {
                    line: start_line,
                    text,
                });
                i = j;
                continue;
            }
            i += 1;
        }
        out
    }

    /// Why a literal does not belong in a renderer, or None.
    ///
    /// THREE CLAUSES AND EACH ONE IS A RECORDED DEFECT OR THE NEXT ONE:
    /// a word the catalog already holds (041's heading), a language tag this
    /// build ships (043's `LANGUAGE`), and an English sentence that has no key
    /// yet -- which is what the next slice would add.
    fn offence(text: &str) -> Option<&'static str> {
        if EN_ENTRIES.iter().any(|(_, v)| *v == text) {
            return Some("a word the catalog already holds; ask `strings` for it");
        }
        if CATALOGS.iter().any(|l| l.tag == text) {
            return Some("a language tag; take it from `strings.tag()`");
        }
        if is_sentence(text) {
            return Some("an English sentence with no key; put it in the catalog");
        }
        None
    }

    /// A sentence a writer could read, told apart from the markup, the SQL and
    /// the format strings these three files are made of.
    ///
    /// DELIBERATELY NARROW, on the page guard's recorded rule: a
    /// pattern-shaped exemption is how a real label slips through, so this
    /// refuses the moment anything that is not a word appears. Two or more
    /// words, letters and apostrophes only, opening with a capital.
    fn is_sentence(text: &str) -> bool {
        let words: Vec<&str> = text.split(' ').collect();
        if words.len() < 2 {
            return false;
        }
        if !words
            .iter()
            .all(|w| !w.is_empty() && w.chars().all(|c| c.is_ascii_alphabetic() || c == '\''))
        {
            return false;
        }
        words[0].starts_with(|c: char| c.is_ascii_uppercase())
    }

    #[test]
    fn the_scanner_reaches_every_renderer_and_finds_literals_in_it() {
        // VACUITY GUARD. A scanner that silently matches nothing passes
        // everything, which is the recorded shape of three guards in this repo.
        for (name, src) in RENDERERS {
            assert_eq!(
                src.matches(TEST_MODULE).count(),
                1,
                "{name}: the test boundary is not where this guard thinks it is"
            );
            let shipping = shipping_part(src);
            // A FLOOR AND NOT A FRACTION. These files are more test than
            // code by weight -- `export.rs` is 25 kB of module and 31 kB of
            // tests -- so a fraction would be a fact about how well tested they
            // are. What this needs to know is that the cut did not land near
            // the top of the file and leave the module unscanned.
            assert!(
                shipping.len() > 8_000,
                "{name}: only {} bytes are on the shipping side",
                shipping.len()
            );
            let found = literals_in(shipping);
            assert!(
                found.len() > 20,
                "{name}: only {} literals found",
                found.len()
            );
        }
    }

    #[test]
    fn the_scanner_strips_comments_and_keeps_line_numbers() {
        let src =
            "let a = \"kept\";\n// let b = \"commented\";\n/* \"block\" */ let c = \"third\";\n";
        let found = literals_in(src);
        let texts: Vec<&str> = found.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(texts, vec!["kept", "third"]);
        assert_eq!(found[0].line, 1);
        assert_eq!(found[1].line, 3);
    }

    #[test]
    fn the_scanner_does_not_read_a_lifetime_as_a_string() {
        // `'a` is everywhere in these three files and there is no closing
        // quote for it. A scanner that took it for one would swallow the rest
        // of the file and report nothing -- passing the guard by blindness.
        let found = literals_in("fn f<'a>(x: &'a str) -> &'a str { \"only\" }");
        let texts: Vec<&str> = found.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(texts, vec!["only"]);
    }

    #[test]
    fn the_three_clauses_each_refuse_and_each_permit() {
        // Every clause in both directions, because a rule that refused
        // everything and a rule that refused nothing both satisfy a
        // one-directional test.
        assert!(offence("Contents").is_some());
        assert!(offence("en").is_some());
        assert!(offence("Underline is kept in your book").is_some());

        // And the markup, the tokens and the format strings these files are
        // made of, which must all pass.
        for permitted in [
            "<dc:language>{language}</dc:language>\\n",
            "cover",
            "titlepage",
            "SELECT body FROM blob WHERE key = ?1",
            "#",
            "{} {}",
            "application/xhtml+xml",
        ] {
            assert!(offence(permitted).is_none(), "{permitted}");
        }
    }

    #[test]
    fn the_renderers_hold_no_writer_facing_word_of_their_own() {
        // THE POINT OF THIS FILE. `export.rs`, `epub.rs` and `pdf.rs` say in
        // their own doc comments that they hold no writer-facing words; before
        // this test that sentence was true by inspection, and 041's heading and
        // 043's language tag both sat in them for weeks.
        let mut offenders: Vec<String> = Vec::new();
        for (name, src) in RENDERERS {
            for lit in literals_in(shipping_part(src)) {
                if let Some(why) = offence(&lit.text) {
                    offenders.push(format!("{name}:{}  {:?} -- {why}", lit.line, lit.text));
                }
            }
        }
        assert_eq!(offenders, Vec::<String>::new());
    }
}
