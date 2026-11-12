import i18n from "@/i18n";

export const pastedImages = (data: DataTransfer | null) => Array.from(data?.files || []).filter((file) => file.type.startsWith("image/"));

export async function readClipboardImages() {
    try {
        if (!navigator.clipboard?.read) throw new Error("unavailable");
        const items = await navigator.clipboard.read();
        return await Promise.all(items.flatMap((item) => item.types.filter((type) => type.startsWith("image/")).map((type) => item.getType(type))));
    } catch {
        throw new Error(i18n.t("common.clipboardReadHint"));
    }
}
