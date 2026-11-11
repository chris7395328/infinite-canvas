import { expect, test } from "bun:test";
import { canvasEditorText } from "../src/lib/canvas/canvas-editor-text";
import { canvasEdgePan } from "../src/lib/canvas/canvas-edge-pan";

// Structural DOM fixtures exercise native Enter markup without starting a browser or paid requests.
const text = (value: string) => ({ nodeType: 3, nodeName: "#text", textContent: value } as ChildNode);
const element = (tag: string, children: ChildNode[] = [], dataset = {}) => ({ nodeType: 1, nodeName: tag, tagName: tag, childNodes: children, dataset } as unknown as ChildNode);
const serialize = (children: ChildNode[]) => canvasEditorText(children, (node) => node.dataset.refLabel);

test("native Enter preserves text, consecutive blank lines and reference chips", () => {
    expect(serialize([text("第一行"), element("DIV", [text("第二行")])])).toBe("第一行\n第二行");
    expect(serialize([text("一"), element("DIV", [element("BR")]), element("DIV", [text("三")])])).toBe("一\n\n三");
    expect(serialize([element("DIV", [text("一")]), element("P", [text("二")]), text("三")])).toBe("一\n二\n三");
    expect(serialize([text("\uFEFF一"), element("BR"), text("二")])).toBe("一\n二");
    expect(serialize([element("BR")])).toBe("");
    expect(serialize([text("一"), element("DIV", [element("SPAN", [text("UI title")], { refLabel: "@图片1" }), text("二")])])).toBe("一\n@图片1二");
    expect(canvasEditorText([element("DIV", [element("SPAN", [], { referenceNodeId: "n1" })])], (node) => node.dataset.referenceNodeId ? `@[node:${node.dataset.referenceNodeId}]` : undefined)).toBe("@[node:n1]");
});

test("node and wire edge pan use identical screen-space velocity in all directions", () => {
    const rect = { left: 100, right: 1100, top: 50, bottom: 850 };
    expect(canvasEdgePan({ x: 600, y: 450 }, rect, 1000)).toEqual({ x: 0, y: 0, active: false });
    expect(canvasEdgePan({ x: 100, y: 50 }, rect, 1000)).toEqual({ x: 480, y: 480, active: true });
    expect(canvasEdgePan({ x: 1100, y: 850 }, rect, 1000)).toEqual({ x: -480, y: -480, active: true });
    expect(canvasEdgePan({ x: 1200, y: 900 }, rect, 1000)).toEqual({ x: -1480, y: -980, active: true });
    expect(canvasEdgePan({ x: 124, y: 74 }, rect, 500)).toEqual({ x: 120, y: 120, active: true });
    expect(canvasEdgePan({ x: 148, y: 98 }, rect, 1000)).toEqual({ x: 0, y: 0, active: false });
    expect(canvasEdgePan({ x: 100, y: 50 }, rect, -1)).toEqual({ x: 0, y: 0, active: true });
    expect(canvasEdgePan({ x: 100, y: 50 }, rect, 0).active).toBe(true); // First RAF timestamp must not end an edge drag.
});

test("canvas prompt editors cannot submit on Enter; explicit send stays available", async () => {
    for (const name of ["canvas-prompt-chip-input", "canvas-resource-mention-textarea"]) {
        const source = await Bun.file(new URL(`../src/components/canvas/${name}.tsx`, import.meta.url)).text();
        expect(source).not.toContain("onSubmit?:");
        expect(source).not.toContain("onSubmit()");
        expect(source).not.toContain("isPlainEnterKey");
        expect(source).toContain("isImeComposing(event)");
    }
    const panel = await Bun.file(new URL("../src/components/canvas/canvas-node-prompt-panel.tsx", import.meta.url)).text();
    expect(panel).not.toContain("onSubmit={submit}");
    expect(panel).toContain("isRunning ? onStop(node.id) : submit()");
});
