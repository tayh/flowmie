import { describe, expect, it } from "vitest";
import {
  flowNodeToWindowBounds,
  webviewContentArea,
  windowPointToFlowPosition,
  WEBVIEW_TITLEBAR_HEIGHT,
} from "./webviewBounds";

const IDENTITY_VIEWPORT = { x: 0, y: 0, zoom: 1 };
const NO_OFFSET = { left: 0, top: 0 };

describe("windowPointToFlowPosition", () => {
  it("is a no-op at zoom 1, no pan, no offset, ratio 1", () => {
    expect(windowPointToFlowPosition({ x: 100, y: 50 }, IDENTITY_VIEWPORT, NO_OFFSET, 1)).toEqual({
      x: 100,
      y: 50,
    });
  });

  it("halves physical pixels on a HiDPI screen", () => {
    expect(windowPointToFlowPosition({ x: 200, y: 100 }, IDENTITY_VIEWPORT, NO_OFFSET, 2)).toEqual({
      x: 100,
      y: 50,
    });
  });

  it("removes the container offset and the pan, then undoes the zoom", () => {
    // logical 260,180 → minus offset 20,30 → minus pan 40,60 → /2 zoom
    expect(
      windowPointToFlowPosition(
        { x: 260, y: 180 },
        { x: 40, y: 60, zoom: 2 },
        { left: 20, top: 30 },
        1,
      ),
    ).toEqual({ x: 100, y: 45 });
  });

  it("round-trips against flowNodeToWindowBounds", () => {
    const viewport = { x: 40, y: 60, zoom: 1.5 };
    const offset = { left: 20, top: 30 };
    const original = { x: 100, y: 45 };
    const bounds = flowNodeToWindowBounds(original, { width: 1, height: 1 }, viewport, offset);
    expect(windowPointToFlowPosition(bounds, viewport, offset, 1)).toEqual(original);
  });

  it("treats a nonsense pixel ratio as 1 rather than dividing by zero", () => {
    expect(windowPointToFlowPosition({ x: 10, y: 10 }, IDENTITY_VIEWPORT, NO_OFFSET, 0)).toEqual({
      x: 10,
      y: 10,
    });
  });
});

describe("flowNodeToWindowBounds", () => {
  it("is a no-op at zoom 1 with no pan and no container offset", () => {
    const bounds = flowNodeToWindowBounds(
      { x: 100, y: 50 },
      { width: 400, height: 300 },
      IDENTITY_VIEWPORT,
      NO_OFFSET,
    );
    expect(bounds).toEqual({ x: 100, y: 50, width: 400, height: 300 });
  });

  it("applies panning as a translation without affecting size", () => {
    const bounds = flowNodeToWindowBounds(
      { x: 100, y: 50 },
      { width: 400, height: 300 },
      { x: 20, y: -10, zoom: 1 },
      NO_OFFSET,
    );
    expect(bounds).toEqual({ x: 120, y: 40, width: 400, height: 300 });
  });

  it("scales both position and size by zoom", () => {
    const bounds = flowNodeToWindowBounds(
      { x: 100, y: 50 },
      { width: 400, height: 300 },
      { x: 0, y: 0, zoom: 2 },
      NO_OFFSET,
    );
    expect(bounds).toEqual({ x: 200, y: 100, width: 800, height: 600 });
  });

  it("combines pan and zoom the way React Flow's own screen transform does", () => {
    // React Flow: screen = flow * zoom + viewport.
    const bounds = flowNodeToWindowBounds(
      { x: 100, y: 50 },
      { width: 400, height: 300 },
      { x: 20, y: -10, zoom: 0.5 },
      NO_OFFSET,
    );
    expect(bounds).toEqual({ x: 70, y: 15, width: 200, height: 150 });
  });

  it("adds the canvas container's offset from the window origin last", () => {
    const bounds = flowNodeToWindowBounds(
      { x: 100, y: 50 },
      { width: 400, height: 300 },
      { x: 20, y: -10, zoom: 0.5 },
      { left: 8, top: 32 },
    );
    expect(bounds).toEqual({ x: 78, y: 47, width: 200, height: 150 });
  });

  it("handles zero-size nodes without producing NaN", () => {
    const bounds = flowNodeToWindowBounds(
      { x: 0, y: 0 },
      { width: 0, height: 0 },
      { x: 0, y: 0, zoom: 1.5 },
      NO_OFFSET,
    );
    expect(bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe("webviewContentArea", () => {
  it("pushes the top down by the titlebar height and shrinks height to match", () => {
    const area = webviewContentArea({ x: 100, y: 50 }, { width: 400, height: 300 });
    expect(area).toEqual({
      position: { x: 100, y: 50 + WEBVIEW_TITLEBAR_HEIGHT },
      size: { width: 400, height: 300 - WEBVIEW_TITLEBAR_HEIGHT },
    });
  });

  it("never returns a negative height for a card shorter than the titlebar", () => {
    const area = webviewContentArea({ x: 0, y: 0 }, { width: 200, height: 10 });
    expect(area.size.height).toBe(0);
  });
});
