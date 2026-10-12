import AppKit
import Foundation

// Match the visible 206 px tile in a 256 px macOS Dock icon.
// Keep geometry deterministic; the brand artwork is drawn without modification.
let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let assets = root.appendingPathComponent("desktop/assets")
let size = 1024
let tileSize: CGFloat = 824
let inset = (CGFloat(size) - tileSize) / 2
let tile = CGPath(roundedRect: CGRect(x: inset, y: inset, width: tileSize, height: tileSize),
                  cornerWidth: 185, cornerHeight: 185, transform: nil)

guard let source = NSImage(contentsOf: assets.appendingPathComponent("pony-source.png")),
      let artwork = source.cgImage(forProposedRect: nil, context: nil, hints: nil),
      let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
      let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
                              bytesPerRow: size * 4, space: colorSpace,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
    fatalError("Cannot load pony artwork or create the icon canvas")
}

context.clear(CGRect(x: 0, y: 0, width: size, height: size))
context.saveGState()
context.setShadow(offset: CGSize(width: 0, height: -10), blur: 16,
                  color: CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 0.16))
context.addPath(tile)
context.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
context.fillPath()
context.restoreGState()

context.saveGState()
context.addPath(tile)
context.clip()
context.interpolationQuality = .high
context.draw(artwork, in: CGRect(x: 40, y: 40, width: 944, height: 944))
context.restoreGState()

guard let icon = context.makeImage(),
      let png = NSBitmapImageRep(cgImage: icon).representation(using: .png, properties: [:]) else {
    fatalError("Cannot encode the icon PNG")
}
try png.write(to: assets.appendingPathComponent("icon.png"))

func run(_ executable: String, _ arguments: [String]) throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.standardOutput = FileHandle.nullDevice
    try process.run()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
        throw NSError(domain: "EvalDockIcon", code: Int(process.terminationStatus),
                      userInfo: [NSLocalizedDescriptionKey: "Icon conversion failed: \(executable)"])
    }
}

let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("evaldock-icon-\(UUID().uuidString)")
let iconset = temporary.appendingPathComponent("EvalDock.iconset")
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: temporary) }

let representations = [
    ("icon_16x16", 16), ("icon_16x16@2x", 32),
    ("icon_32x32", 32), ("icon_32x32@2x", 64),
    ("icon_128x128", 128), ("icon_128x128@2x", 256),
    ("icon_256x256", 256), ("icon_256x256@2x", 512),
    ("icon_512x512", 512), ("icon_512x512@2x", 1024),
]
for (name, pixels) in representations {
    try run("/usr/bin/sips", ["-z", String(pixels), String(pixels), assets.appendingPathComponent("icon.png").path,
                               "--out", iconset.appendingPathComponent(name + ".png").path])
}
try run("/usr/bin/iconutil", ["-c", "icns", iconset.path, "-o", assets.appendingPathComponent("icon.icns").path])
print("Generated 1024 px icon with an 824 px rounded tile and transparent margins.")
