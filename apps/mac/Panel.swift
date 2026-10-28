import Cocoa
import WebKit

let raw = CommandLine.arguments.dropFirst().first ?? ""
guard let url = URL(string: raw), url.scheme == "http" || url.scheme == "https" else {
  fputs("用法：panel http://127.0.0.1:端口/\n", stderr)
  exit(1)
}

final class PanelDelegate: NSObject, NSApplicationDelegate {
  let window: NSWindow
  let web: WKWebView

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
    web = WKWebView(frame: window.contentView?.bounds ?? .zero)
    web.autoresizingMask = [.width, .height]
    window.contentView?.addSubview(web)
    window.initialFirstResponder = web
    window.center()
    super.init()
    web.load(URLRequest(url: url))
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    window.makeFirstResponder(web)
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    true
  }
}

// macOS 把复制、粘贴、剪切、全选、撤销和重做做成主菜单快捷键。
// 没有编辑菜单时，这些组合键不会进入 WKWebView。
// 网页里的选区在网页进程，自动校验经常把菜单项关掉，快捷键就一起失效。
func installEditMenu() {
  let main = NSMenu()

  let appItem = NSMenuItem()
  main.addItem(appItem)
  let appMenu = NSMenu()
  appItem.submenu = appMenu
  appMenu.addItem(withTitle: "退出代码评审", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

  let editItem = NSMenuItem()
  main.addItem(editItem)
  let edit = NSMenu(title: "编辑")
  editItem.submenu = edit
  edit.autoenablesItems = false
  edit.addItem(menuItem("撤销", Selector(("undo:")), "z", [.command]))
  edit.addItem(menuItem("重做", Selector(("redo:")), "z", [.command, .shift]))
  edit.addItem(.separator())
  edit.addItem(menuItem("剪切", #selector(NSText.cut(_:)), "x", [.command]))
  edit.addItem(menuItem("复制", #selector(NSText.copy(_:)), "c", [.command]))
  edit.addItem(menuItem("粘贴", #selector(NSText.paste(_:)), "v", [.command]))
  edit.addItem(menuItem("全选", #selector(NSText.selectAll(_:)), "a", [.command]))

  NSApp.mainMenu = main
}

func menuItem(_ title: String, _ action: Selector, _ key: String, _ mods: NSEvent.ModifierFlags) -> NSMenuItem {
  let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
  item.keyEquivalentModifierMask = mods
  item.isEnabled = true
  return item
}

let app = NSApplication.shared
let delegate = PanelDelegate(url: url)
app.setActivationPolicy(.regular)
app.delegate = delegate
installEditMenu()
app.run()
