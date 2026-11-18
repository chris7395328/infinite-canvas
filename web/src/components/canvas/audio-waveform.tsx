import { useMemo } from "react";

export function AudioWaveform({ peaks, className }: { peaks: number[]; className?: string }) {
    const path = useMemo(() => peaks.map((peak, index) => {
        const half = Math.max(1, peak * 30 / 255);
        return `M${index * 3 + 1.5},${32 - half}v${half * 2}`;
    }).join(""), [peaks]);
    return (
        <svg aria-hidden="true" className={className} viewBox={`0 0 ${Math.max(1, peaks.length) * 3} 64`} preserveAspectRatio="none">
            <path d={path} stroke="currentColor" strokeWidth="1.8" fill="none" />
        </svg>
    );
}
