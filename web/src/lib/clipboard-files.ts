/** Native paste data also works on HTTP; do not require the async Clipboard API. */
export function clipboardFiles(data: DataTransfer | null): File[] {
    if (!data) return [];
    const files = Array.from(data.files);
    if (files.length) return files;
    return Array.from(data.items).flatMap((item) => {
        const file = item.kind === "file" ? item.getAsFile() : null;
        return file ? [file] : [];
    });
}
