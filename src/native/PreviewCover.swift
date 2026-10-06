import AppKit
import WebKit

/// The preview's native cover (LKM-173). AppKit gives the views that float over the page
/// (the editing and Layers islands, the resize edge and the toast) their clicks and scrolls, but WebKit's own
/// tracking areas still hand the page every pointer move in its frame. So the page is told
/// which of its viewport rects those views cover, in CSS pixels, and lays a shield there
/// (`src/preview/native-cover.ts`): no hover box, `:hover` or page listener sees a pointer
/// that is over a native view. Computed on layout and sent only when it changed, never per
/// move; WebKit's tracking areas stay its own.
extension Host {
    func previewCoverRects() -> [[String: Double]] {
        guard let preview = views["preview"], !preview.isHidden, preview.superview === canvas else { return [] }
        let scale = max(preview.pageZoom * preview.magnification, 0.01)
        let floating: [NSView] = [editingInspector, layers, nativeLayout?.inspectorDivider, toast].compactMap { $0 }
        return floating.compactMap { view in
            guard !view.isHidden, view.superview === canvas else { return nil }
            let r = preview.convert(view.frame, from: canvas).intersection(preview.bounds)
            guard !r.isNull, r.width > 0, r.height > 0 else { return nil }
            let top = preview.isFlipped ? r.minY : preview.bounds.height - r.maxY
            func css(_ value: CGFloat) -> Double { (Double(value / scale) * 2).rounded() / 2 }
            return ["x":css(r.minX), "y":css(top), "width":css(r.width), "height":css(r.height)]
        }
    }
    /// Reports the covered rects when they changed. Main delivers them to the page through the
    /// preview's usual channel and again after each load: evaluating into the page from here
    /// (inside a WebKit callback or mid-navigation) crashed WebKit's executor check.
    func sendPreviewCover() {
        let rects = previewCoverRects()
        guard rects != previewCover else { return }
        previewCover = rects
        emit(["event":"native-cover", "rects":rects])
    }
}
