import AppKit

let S: CGFloat = 1024
let img = NSImage(size: NSSize(width: S, height: S))
img.lockFocus()
let ctx = NSGraphicsContext.current!.cgContext
func hex(_ h: UInt32) -> NSColor { NSColor(srgbRed: CGFloat((h >> 16) & 255)/255, green: CGFloat((h >> 8) & 255)/255, blue: CGFloat(h & 255)/255, alpha: 1) }

// Background: macOS squircle (824px grid, radius ~185) + drop shadow
let body = NSRect(x: 100, y: 100, width: 824, height: 824)
let path = NSBezierPath(roundedRect: body, xRadius: 185, yRadius: 185)
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -12), blur: 28, color: NSColor.black.withAlphaComponent(0.35).cgColor)
hex(0x161616).setFill(); path.fill()
ctx.restoreGState()
NSGradient(starting: hex(0x2a2a2c), ending: hex(0x0c0c0c))!.draw(in: path, angle: -90)

// Ring: track + segments in the timer colors (clockwise from 12 o'clock)
let c = NSPoint(x: 512, y: 512), r: CGFloat = 318, w: CGFloat = 54
let track = NSBezierPath(); track.appendArc(withCenter: c, radius: r, startAngle: 0, endAngle: 360)
track.lineWidth = w; hex(0x2c2c2e).setStroke(); track.stroke()
// Spaced segments: offset the round caps' overhang (w/2) to keep a real gap between them.
let capTurn = (w / 2) / r / (2 * .pi), gap: CGFloat = 0.022
let segs: [(CGFloat, CGFloat, UInt32)] = [(0, 0.50, 0xffffff), (0.50, 0.75, 0xffd60a), (0.75, 0.875, 0xff8a00), (0.875, 1.0, 0xe5002b)]
for (a, b, col) in segs {
  let p = NSBezierPath()
  let s0 = a + capTurn + gap / 2, s1 = b - capTurn - gap / 2
  p.appendArc(withCenter: c, radius: r, startAngle: 90 - s0 * 360, endAngle: 90 - s1 * 360, clockwise: true)
  p.lineWidth = w; p.lineCapStyle = .round; hex(col).setStroke(); p.stroke()
}

// "2:00" optically centered (digit height) and fitted inside the ring
var size: CGFloat = 300
var font = NSFont(name: "AvenirNextCondensed-Heavy", size: size)!
func make(_ f: NSFont) -> NSAttributedString { NSAttributedString(string: "2:00", attributes: [.font: f, .foregroundColor: NSColor.white]) }
let maxW = (r - w / 2) * 2 * 0.74
let w0 = make(font).size().width
if w0 > maxW { size *= maxW / w0; font = NSFont(name: "AvenirNextCondensed-Heavy", size: size)! }
let txt = make(font)
let baseline = c.y - font.capHeight / 2
txt.draw(at: NSPoint(x: c.x - txt.size().width / 2, y: baseline + font.descender))
img.unlockFocus()

let out = CommandLine.arguments[1]
let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
for target in CommandLine.arguments.dropFirst(2) {
  print(target, NSWorkspace.shared.setIcon(img, forFile: target, options: []))
}
