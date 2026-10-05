import Cocoa
import WebKit

let BOARD_URL = URL(string: "http://localhost:3000")!

final class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate {
    var window: NSWindow!
    var webView: WKWebView!

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        buildWindow()
        webView.loadHTMLString(Self.notice("Starting Formic…", "Bringing up the database and the board."), baseURL: nil)

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let ok = AppDelegate.runScript("start-formic")
            DispatchQueue.main.async {
                guard let self = self else { return }
                if ok {
                    self.webView.load(URLRequest(url: BOARD_URL))
                } else {
                    self.webView.loadHTMLString(Self.notice("Formic couldn’t start",
                        "Open ~/Library/Logs/Formic.log to see why, then Quit and reopen."), baseURL: nil)
                }
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        _ = AppDelegate.runScript("stop-formic")
    }

    func buildWindow() {
        let frame = NSRect(x: 0, y: 0, width: 1280, height: 860)
        window = NSWindow(contentRect: frame,
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Formic"
        window.minSize = NSSize(width: 720, height: 560)
        window.setFrameAutosaveName("FormicMainWindow")
        window.center()

        let config = WKWebViewConfiguration()
        webView = WKWebView(frame: frame, configuration: config)
        webView.uiDelegate = self
        window.contentView = webView

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func buildMenu() {
        let mainMenu = NSMenu()

        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Formic", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Formic", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Formic", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let editItem = NSMenuItem()
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu

        let viewItem = NSMenuItem()
        mainMenu.addItem(viewItem)
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(withTitle: "Reload", action: #selector(reload(_:)), keyEquivalent: "r").target = self
        let full = viewMenu.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        full.keyEquivalentModifierMask = [.command, .control]
        full.target = nil
        viewItem.submenu = viewMenu

        NSApp.mainMenu = mainMenu
    }

    @objc func reload(_ sender: Any?) { webView.reload() }

    /**
     * A link with target="_blank" — which is every external link in Formic: a
     * pull request, a key page, a repository — asks for a new window. There is
     * no second window here, and a WKWebView drops such a request silently
     * when nothing answers it, so the link looks dead. Hand it to the default
     * browser instead, which is what the tab would have been.
     */
    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    static func runScript(_ name: String) -> Bool {
        guard let url = Bundle.main.url(forResource: name, withExtension: "sh") else { return false }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = [url.path]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return false }
        p.waitUntilExit()
        return p.terminationStatus == 0
    }

    static func notice(_ title: String, _ body: String) -> String {
        return """
        <!doctype html><meta charset=utf-8>
        <style>
          html,body{height:100%;margin:0}
          body{display:flex;align-items:center;justify-content:center;background:#fbf9f5;
               font:15px -apple-system,system-ui,sans-serif;color:#1c1917}
          .box{text-align:center;max-width:420px;padding:24px}
          h1{font-size:19px;margin:0 0 8px;font-family:Georgia,serif}
          p{margin:0;color:#78716c;line-height:1.5}
        </style>
        <div class=box><h1>\(title)</h1><p>\(body)</p></div>
        """
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
