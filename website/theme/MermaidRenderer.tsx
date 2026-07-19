import { useEffect, useMemo, useRef, useState } from "react";
import mermaid, { type MermaidConfig } from "mermaid";

type MermaidRendererProps = {
    code: string;
    config?: MermaidConfig;
};

let nextRenderId = 0;
let renderQueue: Promise<void> = Promise.resolve();

function enqueueRender<T>(task: () => Promise<T>): Promise<T> {
    const result = renderQueue.then(task, task);
    renderQueue = result.then(
        () => undefined,
        () => undefined,
    );
    return result;
}

export default function MermaidRenderer({
    code,
    config = {},
}: MermaidRendererProps) {
    const [renderedDiagram, setRenderedDiagram] = useState({ code: "", svg: "" });
    const [renderError, setRenderError] = useState(false);
    const [themeRevision, setThemeRevision] = useState(0);
    const activeTheme = useRef<"dark" | "default" | null>(null);
    const configKey = useMemo(() => JSON.stringify(config), [config]);
    const visibleSvg = renderedDiagram.code === code ? renderedDiagram.svg : "";

    useEffect(() => {
        const readTheme = () =>
            document.documentElement.classList.contains("dark")
                ? "dark" as const
                : "default" as const;
        activeTheme.current = readTheme();
        let frame = 0;
        const observer = new MutationObserver(() => {
            window.cancelAnimationFrame(frame);
            frame = window.requestAnimationFrame(() => {
                const nextTheme = readTheme();
                if (activeTheme.current === nextTheme) return;
                activeTheme.current = nextTheme;
                setThemeRevision((revision) => revision + 1);
            });
        });
        observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["class"],
        });
        return () => {
            observer.disconnect();
            window.cancelAnimationFrame(frame);
        };
    }, []);

    useEffect(() => {
        let active = true;
        setRenderError(false);

        void enqueueRender(async () => {
            if (!active) return null;
            const theme = document.documentElement.classList.contains("dark")
                ? "dark"
                : "default";
            mermaid.initialize({
                ...config,
                securityLevel: "strict",
                startOnLoad: false,
                theme,
            });
            const id = `pc-mermaid-${++nextRenderId}`;
            return mermaid.render(id, code);
        }).then(
            (result) => {
                if (!active || !result) return;
                setRenderedDiagram({ code, svg: result.svg });
                setRenderError(false);
            },
            () => {
                if (active) setRenderError(true);
            },
        );

        return () => {
            active = false;
        };
    }, [code, configKey, themeRevision]);

    return (
        <div
            aria-busy={!visibleSvg && !renderError}
            data-mermaid-state={renderError ? "error" : visibleSvg ? "ready" : "rendering"}
            dangerouslySetInnerHTML={{ __html: renderError ? "" : visibleSvg }}
        />
    );
}
