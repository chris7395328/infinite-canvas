import createDOMPurify from "dompurify";

// Treat generated SVG as untrusted content, including when it comes from a third-party relay.
// Only passive vector content is retained. Preview through an image URL, never innerHTML/object/iframe.
export function sanitizeSvg(source: string): string {
    if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(source)) throw new Error("SVG不接受文档类型或实体声明。");
    const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
    if (parsed.doctype || parsed.querySelector("parsererror") || parsed.documentElement.localName !== "svg") throw new Error("无效的SVG文档，未保存为生成成功。");
    const purifier = createDOMPurify(window);
    const passiveValue = (value: string) => !/[\\]|@import|expression\s*\(/i.test(value) && [...value.matchAll(/url\(\s*["']?([^"')\s]+)/gi)].every((match) => match[1].startsWith("#"));
    purifier.addHook("uponSanitizeElement", (node, data) => {
        if (data.tagName === "style" && !passiveValue(node.textContent || "")) node.parentNode?.removeChild(node);
    });
    purifier.addHook("uponSanitizeAttribute", (_node, data) => {
        if (["href", "xlink:href"].includes(data.attrName) && !data.attrValue.trim().startsWith("#")) data.keepAttr = false;
        if (!passiveValue(data.attrValue)) data.keepAttr = false;
    });
    const clean = purifier.sanitize(source, {
        USE_PROFILES: { svg: true, svgFilters: true },
        FORBID_TAGS: ["script", "foreignObject", "image", "feImage", "animate", "animateMotion", "animateTransform", "set", "a"],
    });
    if (!clean.includes("<svg")) throw new Error("SVG安全净化后没有可预览的矢量内容。");
    return clean;
}
