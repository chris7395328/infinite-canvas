import i18n from "@/i18n";

export function pastedFiles(data: DataTransfer | null) {
    const files = Array.from(data?.files || []);
    if (files.length) return files;
    return Array.from(data?.items || []).flatMap((item) => {
        const file = item.kind === "file" && item.getAsFile();
        return file ? [file] : [];
    });
}

export const pastedImages = (data: DataTransfer | null) => pastedFiles(data).filter((file) => file.type.startsWith("image/"));

export async function readClipboardImages() {
    try {
        if (!navigator.clipboard?.read) throw new Error("unavailable");
        const items = await navigator.clipboard.read();
        return await Promise.all(items.flatMap((item) => item.types.filter((type) => type.startsWith("image/")).map((type) => item.getType(type))));
    } catch {
        throw new Error(i18n.t("common.clipboardReadHint"));
    }
}
