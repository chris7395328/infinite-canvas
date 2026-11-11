// Native contentEditable Enter creates DIV/P blocks; textContent alone loses those line breaks.
// Keep native editing/undo and treat reference chips as atomic text tokens.
export function canvasEditorText(nodes: ArrayLike<ChildNode>, reference: (element: HTMLElement) => string | undefined): string {
    const children = Array.from(nodes);
    if (children.length === 1 && children[0].nodeName === "BR") return "";
    let result = "";
    let previousBlock = false;
    children.forEach((node, index) => {
        const block = node.nodeName === "DIV" || node.nodeName === "P";
        if (index && (block || previousBlock) && (previousBlock || !result.endsWith("\n"))) result += "\n";
        if (node.nodeType === 3) result += node.textContent || "";
        else if (node.nodeType === 1) {
            const element = node as HTMLElement;
            result += reference(element) ?? (element.tagName === "BR" ? "\n" : canvasEditorText(element.childNodes, reference));
        }
        previousBlock = block;
    });
    return result.replace(/\uFEFF/g, "");
}
