import * as vscode from 'vscode';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const GITHUB_OWNER = 'Avlaak';
const GITHUB_REPO = 'embedd-cortex-debug';
const VSIX_PREFIX = 'embedd-cortex-debug-';
const EXTENSION_ID = 'embedd-team.embedd-cortex-debug';
const EXTENSION_DISPLAY_NAME = 'Embedd Cortex-Debug';
const CONFIG_SECTION = 'cortex-debug';

interface GitHubRelease {
    tag_name: string;
    assets: GitHubAsset[];
}

interface GitHubAsset {
    name: string;
    browser_download_url: string;
}

function httpsGet(url: string): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
        const options: https.RequestOptions = {
            headers: { 'User-Agent': 'VSCode-Extension-Updater' }
        };
        https.get(url, options, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                const redirectUrl = res.headers.location;
                if (redirectUrl) {
                    httpsGet(redirectUrl).then(resolve, reject);
                    return;
                }
            }
            const statusCode = res.statusCode ?? 0;
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => resolve({ statusCode, body: data }));
            res.on('error', reject);
        }).on('error', reject);
    });
}

function httpsDownload(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const options: https.RequestOptions = {
            headers: { 'User-Agent': 'VSCode-Extension-Updater' }
        };
        https.get(url, options, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                const redirectUrl = res.headers.location;
                if (redirectUrl) {
                    httpsDownload(redirectUrl, destPath).then(resolve, reject);
                    return;
                }
            }
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            const file = fs.createWriteStream(destPath);
            res.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve();
            });
            file.on('error', (err) => {
                fs.unlink(destPath, () => { });
                reject(err);
            });
        }).on('error', (err) => {
            fs.unlink(destPath, () => { });
            reject(err);
        });
    });
}

function parseVersion(versionStr: string): number[] {
    return versionStr.replace(/^v/, '').split('.').map(Number);
}

function compareVersions(a: number[], b: number[]): number {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const av = a[i] || 0;
        const bv = b[i] || 0;
        if (av > bv) { return 1; }
        if (av < bv) { return -1; }
    }
    return 0;
}

function extractVersionFromAssetName(name: string): string | null {
    if (!name.startsWith(VSIX_PREFIX) || !name.endsWith('.vsix')) {
        return null;
    }
    return name.slice(VSIX_PREFIX.length, -5);
}

async function getLatestRelease(): Promise<{ version: string; downloadUrl: string } | null> {
    const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
    const response = await httpsGet(apiUrl);

    if (response.statusCode === 404) {
        // Repository not found or no releases published yet
        return null;
    }
    if (response.statusCode !== 200) {
        throw new Error(`GitHub API returned HTTP ${response.statusCode}`);
    }

    const release: GitHubRelease = JSON.parse(response.body);

    for (const asset of release.assets) {
        const version = extractVersionFromAssetName(asset.name);
        if (version) {
            return { version, downloadUrl: asset.browser_download_url };
        }
    }
    return null;
}

function getCurrentVersion(): string {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    return (ext?.packageJSON?.version as string) ?? '0.0.0';
}

export async function checkForUpdates(silent: boolean): Promise<void> {
    try {
        const latest = await getLatestRelease();
        if (!latest) {
            if (!silent) {
                vscode.window.showInformationMessage(`${EXTENSION_DISPLAY_NAME}: no releases found.`);
            }
            return;
        }

        const currentVersion = getCurrentVersion();
        const latestParsed = parseVersion(latest.version);
        const currentParsed = parseVersion(currentVersion);

        if (compareVersions(latestParsed, currentParsed) <= 0) {
            if (!silent) {
                vscode.window.showInformationMessage(
                    `${EXTENSION_DISPLAY_NAME}: you are using the latest version (${currentVersion}).`
                );
            }
            return;
        }

        const install = 'Install';
        const dismiss = 'Dismiss';
        const selection = await vscode.window.showInformationMessage(
            `${EXTENSION_DISPLAY_NAME}: new version ${latest.version} is available (current: ${currentVersion}).`,
            install,
            dismiss
        );

        if (selection === install) {
            await downloadAndInstall(latest.downloadUrl, latest.version);
        }
    } catch (err: any) {
        if (!silent) {
            vscode.window.showErrorMessage(
                `${EXTENSION_DISPLAY_NAME}: update check failed — ${err.message}`
            );
        }
    }
}

async function downloadAndInstall(downloadUrl: string, version: string): Promise<void> {
    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `${EXTENSION_DISPLAY_NAME}: downloading v${version}...`,
            cancellable: false
        },
        async () => {
            const tmpDir = os.tmpdir();
            const vsixPath = path.join(tmpDir, `${VSIX_PREFIX}${version}.vsix`);

            try {
                await httpsDownload(downloadUrl, vsixPath);
                await vscode.commands.executeCommand(
                    'workbench.extensions.installExtension',
                    vscode.Uri.file(vsixPath)
                );

                const reload = 'Reload';
                const result = await vscode.window.showInformationMessage(
                    `${EXTENSION_DISPLAY_NAME} v${version} installed. Reload to activate.`,
                    reload
                );
                if (result === reload) {
                    vscode.commands.executeCommand('workbench.action.reloadWindow');
                }
            } finally {
                fs.unlink(vsixPath, () => { });
            }
        }
    );
}

export function scheduleAutoUpdateCheck(context: vscode.ExtensionContext): void {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const autoUpdate = config.get<boolean>('autoCheckUpdates', true);

    if (autoUpdate) {
        // Delay the initial check by 30 seconds after activation
        const timer = setTimeout(() => {
            checkForUpdates(true);
        }, 30_000);

        context.subscriptions.push({ dispose: () => clearTimeout(timer) });
    }
}
