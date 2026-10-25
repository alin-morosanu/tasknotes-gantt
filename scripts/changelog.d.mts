export const REPO: string;
export const CATEGORIES: string[];
export function unreleasedBody(text: string): string;
export function versionBody(text: string, version: string): string;
export function releaseChangelog(text: string, version: string, date: string, repo?: string): string;
export function lint(text: string): string[];
