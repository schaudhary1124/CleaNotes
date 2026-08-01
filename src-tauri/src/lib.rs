mod identity;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            identity::save_identity_secret,
            identity::load_identity_secret
        ])
        .setup(|app| {
            // Updater isn't relevant/available on mobile targets.
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            Ok(())
        })
        // WebKitGTK (Linux) has no native permission-prompt UI for getUserMedia (voice-note
        // recording, see src/milkdown/voiceRecording.ts) the way macOS's TCC dialog
        // (NSMicrophoneUsageDescription in Info.plist) and WebView2's own popup do - an
        // unanswered `permission-request` signal is just silently denied, with no dialog shown
        // at all. This hooks that signal and shows an equivalent native GTK Yes/No dialog, so
        // the user is actually asked on every platform. No-op elsewhere.
        .on_page_load(|webview, payload| {
            // This window (and any duplicated/mirrored note window - see windowInstance.ts) is
            // transparent with custom chrome (see tauri.conf.json's `transparent`/
            // `decorations`), so its "glass" panels rely on CSS backdrop-filter for their blur
            // look. AppKit's default policy for a layer-backed view is to redraw its content
            // only once at the start/end of a live resize drag and just scale the stale bitmap
            // for every frame in between - which is what makes the window's content visibly
            // lag/stretch behind the cursor while dragging an edge, unlike a native app's own
            // views (whose blur/vibrancy the window server composites for free either way).
            // Opting the webview's own layer into continuous redraw during live resize fixes
            // that at the source. Harmless to reapply on every reload, so no need for the
            // Linux block's hooked-once tracking below.
            #[cfg(target_os = "macos")]
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                let _ = webview.with_webview(|platform_webview| unsafe {
                    let view: &objc2_web_kit::WKWebView = &*platform_webview.inner().cast();
                    view.setWantsLayer(true);
                    view.setLayerContentsRedrawPolicy(
                        objc2_app_kit::NSViewLayerContentsRedrawPolicy::DuringViewResize,
                    );
                });
            }
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
                                    "CleaNotes wants to use your microphone to record a voice note.",
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
            #[cfg(not(any(target_os = "linux", target_os = "macos")))]
            let _ = (webview, payload);
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
