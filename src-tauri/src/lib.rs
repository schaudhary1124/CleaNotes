#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        // WebKitGTK (Linux) has no native permission-prompt UI for getUserMedia (voice-note
        // recording, see src/milkdown/voiceRecording.ts) the way macOS's TCC dialog
        // (NSMicrophoneUsageDescription in Info.plist) and WebView2's own popup do - an
        // unanswered `permission-request` signal is just silently denied, with no dialog shown
        // at all. This hooks that signal and shows an equivalent native GTK Yes/No dialog, so
        // the user is actually asked on every platform. No-op elsewhere.
        .on_page_load(|webview, payload| {
            #[cfg(target_os = "linux")]
            {
                use std::{collections::HashSet, sync::Mutex};

                if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                    // on_page_load fires again on every reload, and each webview (main plus any
                    // duplicated note-* window) gets its own signal to hook - tracked by label so
                    // a reload doesn't stack a second/third handler on the same webview.
                    static HOOKED_LABELS: Mutex<Option<HashSet<String>>> = Mutex::new(None);
                    let mut hooked = HOOKED_LABELS.lock().unwrap();
                    if hooked.get_or_insert_with(HashSet::new).insert(webview.label().to_string()) {
                        let result = webview.with_webview(|platform_webview| {
                            use glib::Cast;
                            use gtk::prelude::*;
                            use webkit2gtk::{PermissionRequestExt, WebViewExt};

                            platform_webview.inner().connect_permission_request(|_webview, request| {
                                // Only decide media-capture requests - leave every other
                                // permission type WebKitGTK exposes (notifications,
                                // geolocation, ...) to its own default handling.
                                let Some(media_request) =
                                    request.downcast_ref::<webkit2gtk::UserMediaPermissionRequest>()
                                else {
                                    return false;
                                };
                                let dialog = gtk::MessageDialog::new(
                                    None::<&gtk::Window>,
                                    gtk::DialogFlags::MODAL,
                                    gtk::MessageType::Question,
                                    gtk::ButtonsType::YesNo,
                                    "PlaiNotes wants to use your microphone to record a voice note.",
                                );
                                dialog.set_title("Microphone access");
                                let response = dialog.run();
                                dialog.close();
                                if response == gtk::ResponseType::Yes {
                                    media_request.allow();
                                } else {
                                    media_request.deny();
                                }
                                true
                            });
                        });
                        if let Err(err) = result {
                            eprintln!("voice notes: failed to hook WebKitGTK media permission handling: {err}");
                        }
                    }
                }
            }
            #[cfg(not(target_os = "linux"))]
            let _ = (webview, payload);
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
