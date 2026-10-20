import Cocoa
import WebKit

let raw = CommandLine.arguments.dropFirst().first ?? ""
guard let url = URL(string: raw), url.scheme == "http" || url.scheme == "https" else {
  fputs("用法：panel http://127.0.0.1:端口/\n", stderr)
  exit(1)
}

final class PanelDelegate: NSObject, NSApplicationDelegate {
  let window: NSWindow

  init(url: URL) {
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1100, height: 780),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false
    )
    window.title = "代码评审"
    window.minSize = NSSize(width: 720, height: 480)
    window.setFrameAutosaveName("CodingReviewPanel")
    let web = WKWebView(frame: window.contentView?.bounds ?? .zero)
    web.autoresizingMask = [.width, .height]
    window.contentView?.addSubview(web)
    window.center()
    super.init()
    web.load(URLRequest(url: url))
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    true
  }
}

let app = NSApplication.shared
let delegate = PanelDelegate(url: url)
app.setActivationPolicy(.regular)
app.delegate = delegate
app.run()
