export type DocsLocale = "en" | "zh";

export type DocsRole =
    | "home"
    | "concept"
    | "tutorial"
    | "how-to"
    | "operations"
    | "troubleshooting"
    | "reference"
    | "example"
    | "compatibility";

export interface DocsGroup {
    id: string;
    order: number;
    labels: Record<DocsLocale, string>;
}

export interface DocsPage {
    id: string;
    path: string;
    order: number;
    section: "home" | "guide" | "api" | "examples";
    navGroup: string | null;
    labels: Record<DocsLocale, string>;
    role: DocsRole;
    audience: string;
    sourceOfTruth: string[];
    sourceSymbol: string;
    requiredSlots: string[];
    forbiddenSlots: string[];
    contentOwner: string;
    reuseMode: string;
    primaryNext: string | null;
}

export const guideGroups: DocsGroup[];
export const docsPages: DocsPage[];

export function pageLink(page: DocsPage): string;
export function localizeDocsLink(link: string, locale: DocsLocale): string;
export function validateDocsManifest(
    pages?: DocsPage[],
    groups?: DocsGroup[],
): string[];
